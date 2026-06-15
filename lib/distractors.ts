/**
 * lib/distractors.ts
 *
 * Multiple-choice option builder for pre-graduation "recognition" steps.
 *
 * Strategy:
 *  1. Use cached `card.choices[side]` if it has enough usable distractors —
 *     return these immediately, synchronously.
 *  2. Otherwise, fill in with random front/back values from sibling cards in
 *     the deck so options can be shown right away with no loading delay.
 *  3. Separately (in the background), ask /api/distractors for AI-generated
 *     options (Claude) and cache the result on the card via
 *     cardRepo.update() once it resolves. Once cached, those AI choices are
 *     permanent and will be used immediately on future renders — the
 *     sibling-card fallback is only ever a temporary stand-in while AI
 *     choices are (re-)generated.
 *
 * Returns a shuffled array containing the correct answer plus up to
 * `OPTIONS_NEEDED - 1` distractors (fewer if the deck is too small).
 */

import type { Card, CardSide, CardChoices, CardConfusion } from '@/domain'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { langName } from '@/lib/languages'

export const OPTIONS_NEEDED = 4

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

export function dedupeAgainst(correct: string, pool: string[]): string[] {
  const seen = new Set([norm(correct)])
  const out: string[] = []
  for (const item of pool) {
    const key = norm(item)
    if (!item.trim() || seen.has(key)) continue
    seen.add(key)
    out.push(item.trim())
  }
  return out
}

/** Random sibling-card fallback: pull `count` other values from `side` of other cards in the deck. */
function deckFallback(card: Card, side: CardSide, deckCards: Card[], correct: string, count: number): string[] {
  const pool = deckCards
    .filter(c => c.id !== card.id)
    .map(c => (side === 'front' ? c.front : c.back))
  return shuffle(dedupeAgainst(correct, pool)).slice(0, count)
}

async function fetchAiChoices(
  card: Card,
  deckCards: Card[],
  sourceLanguage: string,
  targetLanguage: string,
): Promise<CardChoices | null> {
  try {
    const res = await fetch('/api/distractors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        front: card.front,
        back:  card.back,
        sourceLanguage: langName(sourceLanguage),
        targetLanguage: langName(targetLanguage),
        deckFronts: deckCards.filter(c => c.id !== card.id).map(c => c.front),
        deckBacks:  deckCards.filter(c => c.id !== card.id).map(c => c.back),
      }),
    })
    const data = await res.json()
    if (!data.ok || !data.choices) return null
    return data.choices as CardChoices
  } catch {
    return null
  }
}

/**
 * Build multiple-choice options for `side` of `card` synchronously, with no
 * network calls. Uses cached AI choices if there are enough; otherwise pads
 * out with random sibling-card values from the deck as a temporary stand-in.
 * `side` is the answer side of the current pipeline step — i.e. what the
 * learner needs to pick out from among the distractors.
 */
export function buildOptions(
  card: Card,
  side: CardSide,
  deckCards: Card[],
): string[] {
  const correct = side === 'front' ? card.front : card.back
  const distractorsNeeded = OPTIONS_NEEDED - 1

  let pool = dedupeAgainst(correct, card.choices?.[side] ?? [])
  if (pool.length < distractorsNeeded) {
    const fallback = deckFallback(card, side, deckCards, correct, distractorsNeeded - pool.length)
    pool = dedupeAgainst(correct, [...pool, ...fallback])
  }

  const distractors = shuffle(pool).slice(0, distractorsNeeded)
  return shuffle([correct, ...distractors])
}

/** True if `card` still needs AI/cached distractors generated for `side`. */
export function needsChoices(card: Card, side: CardSide): boolean {
  const correct = side === 'front' ? card.front : card.back
  const pool = dedupeAgainst(correct, card.choices?.[side] ?? [])
  return pool.length < OPTIONS_NEEDED - 1
}

/**
 * If `card` doesn't yet have enough cached AI distractors for `side`, fetch
 * fresh ones from /api/distractors and cache them on the card for good.
 * Returns the newly cached choices (covering both sides), or `null` if no
 * generation was needed or it failed — in which case the caller keeps
 * showing its existing/fallback options and can simply try again later.
 */
export async function ensureChoicesGenerated(
  card: Card,
  side: CardSide,
  deckCards: Card[],
  sourceLanguage: string,
  targetLanguage: string,
): Promise<CardChoices | null> {
  if (!needsChoices(card, side)) return null

  const aiChoices = await fetchAiChoices(card, deckCards, sourceLanguage, targetLanguage)
  if (!aiChoices) return null

  try {
    const cardRepo = new SupabaseCardRepository()
    await cardRepo.update(card.id, { choices: aiChoices })
  } catch {
    // Caching is best-effort — the caller still gets the freshly generated choices.
  }
  return aiChoices
}

/**
 * Number of times a learner must mix up the same word with a card's answer
 * (see `CardConfusion.count`/`isWordMixup`) before that word gets promoted
 * into the card's cached multiple-choice distractors.
 */
export const CONFUSION_PROMOTION_THRESHOLD = 3

/**
 * If the learner has repeatedly (>= CONFUSION_PROMOTION_THRESHOLD times)
 * confused a real word with `card`'s `side` answer — and that word isn't
 * already one of `card`'s cached distractors for `side` — returns updated
 * `CardChoices` with the confused word swapped in for the lowest-priority
 * existing distractor (the last one). Returns `null` if there's nothing to
 * promote, or if `card.choices[side]` doesn't yet have a full cached
 * distractor set to swap from (in that case the AI-generation path will
 * populate it first; promotion can happen on a later session).
 *
 * Pure/synchronous — callers are responsible for persisting the result
 * (see `promoteConfusionDistractors`).
 */
export function promoteConfusionDistractor(
  card: Card,
  side: CardSide,
  confusions: CardConfusion[],
): CardChoices | null {
  const correct = side === 'front' ? card.front : card.back
  const distractorsNeeded = OPTIONS_NEEDED - 1

  const current = dedupeAgainst(correct, card.choices?.[side] ?? [])
  if (current.length < distractorsNeeded) return null

  const best = confusions
    .filter(c => c.answerSide === side && c.isWordMixup && c.count >= CONFUSION_PROMOTION_THRESHOLD)
    .filter(c => norm(c.confusedText) !== norm(correct))
    .sort((a, b) => b.count - a.count)[0]
  if (!best) return null

  const confusedText = best.confusedText.trim()
  if (!confusedText) return null
  if (current.some(x => norm(x) === norm(confusedText))) return null // already a distractor

  const updated = [...current.slice(0, distractorsNeeded - 1), confusedText]
  const base: CardChoices = card.choices ?? { front: [], back: [] }
  return { ...base, [side]: updated }
}

export interface ConfusionPromotionItem {
  card: Card
  side: CardSide
}

/**
 * Background pass over upcoming recognition-step cards: for each one, checks
 * whether a frequently-confused word should be promoted into its cached
 * distractors (`promoteConfusionDistractor`), and if so persists the updated
 * `choices` via `cardRepo.update()` and reports it through `onCached` (same
 * callback shape as `prefetchChoices`/`ensureChoicesGenerated`) so the
 * session can update its in-memory card immediately. Best-effort — failures
 * are swallowed per-card.
 */
export async function promoteConfusionDistractors(
  items: ConfusionPromotionItem[],
  confusionsByCard: Map<string, CardConfusion[]>,
  onCached: (cardId: string, choices: CardChoices) => void,
): Promise<void> {
  const cardRepo = new SupabaseCardRepository()
  for (const { card, side } of items) {
    const confusions = confusionsByCard.get(card.id) ?? []
    if (confusions.length === 0) continue
    const updated = promoteConfusionDistractor(card, side, confusions)
    if (!updated) continue
    try {
      await cardRepo.update(card.id, { choices: updated })
      onCached(card.id, updated)
    } catch {
      // Best-effort — try again on a future session.
    }
  }
}

export interface PrefetchItem {
  card:           Card
  side:           CardSide
  deckCards:      Card[]
  sourceLanguage: string
  targetLanguage: string
}

/**
 * Background pre-generation of multiple-choice distractors for upcoming
 * session cards, so `MultipleChoiceMode` rarely has to show "Loading
 * choices…" — by the time a card comes up, its options are usually already
 * cached. Runs with limited concurrency and fails silently per-card (the
 * card just falls back to lazy loading when it's actually shown).
 */
export async function prefetchChoices(
  items: PrefetchItem[],
  onCached: (cardId: string, choices: CardChoices) => void,
  concurrency = 2,
): Promise<void> {
  let next = 0
  async function worker() {
    while (next < items.length) {
      const item = items[next++]
      if (!item) continue
      try {
        const aiChoices = await ensureChoicesGenerated(
          item.card, item.side, item.deckCards, item.sourceLanguage, item.targetLanguage,
        )
        if (aiChoices) onCached(item.card.id, aiChoices)
      } catch {
        // Best-effort — the card will fall back to deck-based choices when shown.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}
