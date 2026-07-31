/**
 * engine/confusion.ts — pure detection + penalty for PRODUCTION CONFUSIONS: on a typed production
 * review you type word B when the card wanted A. That's a discrimination failure (you can't tell the
 * two target words apart), best fixed by recognition work — so we link the pair, penalize the
 * RECOGNITION track of both, and (session layer) queue an A-vs-B drill. Framework-free.
 */

import type { GradingSettings, ConfusionKind, ConfusionSimilarityTag } from '@/domain'
import { isDifferentWordMistake } from './grading'
import { intervalForRetention, DEFAULT_FSRS_CONFIG } from './fsrs'

/** Normalize a word for cross-card matching: NFC, drop (f)/[note] annotations, collapse space, lowercase. */
export function normalizeForMatch(s: string): string {
  return s.normalize('NFC').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

export interface SiblingCard { cardId: string; front: string; sourceLanguage: string }

/**
 * Detects a confusion: the learner typed a GENUINE different word (not a typo — per
 * `isDifferentWordMistake`) that exactly matches another card's target word (`front`). Returns that
 * card's id (B), or null. Matches across the whole library (`siblings`); the current card is excluded.
 */
export function findConfusedSibling(
  typed: string, expectedFront: string, currentCardId: string,
  siblings: SiblingCard[], settings: GradingSettings,
): string | null {
  if (!isDifferentWordMistake(typed, expectedFront, settings)) return null
  const key = normalizeForMatch(typed)
  if (!key) return null
  for (const s of siblings) {
    if (s.cardId === currentCardId) continue
    if (normalizeForMatch(s.front) === key) return s.cardId
  }
  return null
}

// ─── Intra- vs inter-language + similarity tagging ──────────────────────────

/** Same learned language → 'intra' (full response); different → 'inter' (stored only for now). */
export function confusionKind(sourceLanguageA: string, sourceLanguageB: string): ConfusionKind {
  return sourceLanguageA === sourceLanguageB ? 'intra' : 'inter'
}

/** Levenshtein edit ratio in [0,1] (1 = identical), on Unicode-decomposed (NFD) strings so composed
 *  syllables like Hangul 발/팔 compare at the phoneme level. */
export function editRatio(a: string, b: string): number {
  const x = a.normalize('NFD'), y = b.normalize('NFD')
  if (!x.length && !y.length) return 1
  const m = x.length, n = y.length
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 1; j <= n; j++) d[0]![j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1))
  return 1 - d[m]![n]! / Math.max(m, n)
}

/** ≥ this edit ratio ⇒ tagged 'phonetic' (an orthographic proxy — a true IPA/phonetic tagger is future). */
const PHONETIC_SIMILARITY_THRESHOLD = 0.6
const TEMPORAL_WINDOW_DAYS = 2

/**
 * Best-effort similarity tags for an INTRA-language confusion. Computes the deterministic ones now:
 * 'phonetic' (orthographic near-neighbor via editRatio) and 'temporal' (both learned within
 * TEMPORAL_WINDOW_DAYS). 'semantic' is NOT auto-detected (future AI/embedding tagger). Returns the
 * detected subset (possibly empty = "not yet fully classified"; the future mode adds semantic/other).
 */
export function classifyIntraTags(opts: {
  frontA: string; frontB: string
  introducedA?: string | null; introducedB?: string | null
}): ConfusionSimilarityTag[] {
  const tags: ConfusionSimilarityTag[] = []
  if (editRatio(normalizeForMatch(opts.frontA), normalizeForMatch(opts.frontB)) >= PHONETIC_SIMILARITY_THRESHOLD) tags.push('phonetic')
  if (opts.introducedA && opts.introducedB) {
    const diffDays = Math.abs(new Date(opts.introducedA).getTime() - new Date(opts.introducedB).getTime()) / 86_400_000
    if (diffDays <= TEMPORAL_WINDOW_DAYS) tags.push('temporal')
  }
  return tags
}

// ─── Interleaving confusable pairs in a session ─────────────────────────────

/**
 * Reorder a session queue so that confusable cards (linked A↔B) that are BOTH due this session sit
 * next to each other — forcing the learner to contrast them. Connected groups (A↔B↔C…) are clustered
 * at the position of the group's first member; non-confusable items keep their order. Stable, pure.
 */
export function interleaveConfusablePairs<T extends { card: { id: string } }>(
  queue: T[], links: { cardAId: string; cardBId: string }[],
): T[] {
  if (links.length === 0 || queue.length === 0) return queue
  const present = new Set(queue.map(q => q.card.id))
  const adj = new Map<string, Set<string>>()
  const add = (x: string, y: string) => { (adj.get(x) ?? adj.set(x, new Set()).get(x)!).add(y) }
  for (const l of links) {
    if (!present.has(l.cardAId) || !present.has(l.cardBId) || l.cardAId === l.cardBId) continue
    add(l.cardAId, l.cardBId); add(l.cardBId, l.cardAId)
  }
  if (adj.size === 0) return queue

  // Connected components over the confusable cards.
  const groupOf = new Map<string, number>()
  let g = 0
  for (const id of adj.keys()) {
    if (groupOf.has(id)) continue
    const stack = [id]; groupOf.set(id, g)
    while (stack.length) {
      const cur = stack.pop()!
      for (const nb of adj.get(cur) ?? []) if (!groupOf.has(nb)) { groupOf.set(nb, g); stack.push(nb) }
    }
    g++
  }

  // Bucket every queue item by its group (items keep their relative order within a group).
  const byGroup = new Map<number, T[]>()
  for (const item of queue) {
    const gi = groupOf.get(item.card.id)
    if (gi !== undefined) (byGroup.get(gi) ?? byGroup.set(gi, []).get(gi)!).push(item)
  }

  const emitted = new Set<T>()
  const out: T[] = []
  for (const item of queue) {
    if (emitted.has(item)) continue
    const gi = groupOf.get(item.card.id)
    if (gi === undefined) { out.push(item); emitted.add(item); continue }
    for (const m of byGroup.get(gi)!) if (!emitted.has(m)) { out.push(m); emitted.add(m) }  // whole group, contiguous
  }
  return out
}

// Recognition-track FSRS penalty for a confusion — cut stability (comes back sooner), bump difficulty
// (grows slower). Persistent, unlike a raw interval cut which the next review would recompute away.
export const CONFUSION_STABILITY_FACTOR = 0.5
const CONFUSION_DIFFICULTY_DELTA = 1.0

/**
 * Penalized difficulty/stability + the resulting recognition interval (days) for a confused card's
 * recognition track. Returns null when the card has no FSRS state yet (nothing to penalize).
 */
export function confusionPenalty(
  state: { difficulty: number | null; stability: number | null },
  retention: number = DEFAULT_FSRS_CONFIG.requestRetention,
): { difficulty: number; stability: number; intervalDays: number } | null {
  if (state.difficulty == null || state.stability == null) return null
  const difficulty = Math.min(10, state.difficulty + CONFUSION_DIFFICULTY_DELTA)
  const stability  = Math.max(0.5, state.stability * CONFUSION_STABILITY_FACTOR)
  return { difficulty, stability, intervalDays: Math.max(1, Math.round(intervalForRetention(stability, retention))) }
}
