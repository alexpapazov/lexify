/**
 * lib/distractors.ts
 *
 * Multiple-choice option builder for pre-graduation "recognition" steps.
 *
 * Strategy:
 *  1. Use cached `card.choices[side]` if it has enough usable distractors.
 *  2. Otherwise, ask /api/distractors for AI-generated options (Claude) and
 *     cache the result on the card via cardRepo.update().
 *  3. If AI generation is unavailable or fails, fall back to picking random
 *     front/back values from sibling cards in the same deck.
 *
 * Returns a shuffled array containing the correct answer plus up to
 * `OPTIONS_NEEDED - 1` distractors (fewer if the deck is too small).
 */

import type { Card, CardSide, CardChoices } from '@/domain'
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

export interface MultipleChoiceResult {
  options: string[]
  /** Set when AI generation produced (and cached) a new choices pool, so callers can update local state. */
  cachedChoices?: CardChoices
}

/**
 * Get (and lazily generate/cache) multiple-choice options for `side` of `card`.
 * `side` is the answer side of the current pipeline step — i.e. what the
 * learner needs to pick out from among the distractors.
 */
export async function getMultipleChoiceOptions(
  card: Card,
  side: CardSide,
  deckCards: Card[],
  sourceLanguage: string,
  targetLanguage: string,
): Promise<MultipleChoiceResult> {
  const correct = side === 'front' ? card.front : card.back
  const distractorsNeeded = OPTIONS_NEEDED - 1

  let pool = dedupeAgainst(correct, card.choices?.[side] ?? [])
  let cachedChoices: CardChoices | undefined

  if (pool.length < distractorsNeeded) {
    const aiChoices = await fetchAiChoices(card, deckCards, sourceLanguage, targetLanguage)
    if (aiChoices) {
      try {
        const cardRepo = new SupabaseCardRepository()
        await cardRepo.update(card.id, { choices: aiChoices })
        cachedChoices = aiChoices
      } catch {
        // Caching is best-effort — still use the freshly generated choices below.
      }
      pool = dedupeAgainst(correct, aiChoices[side] ?? [])
    }
  }

  if (pool.length < distractorsNeeded) {
    const fallback = deckFallback(card, side, deckCards, correct, distractorsNeeded - pool.length)
    pool = dedupeAgainst(correct, [...pool, ...fallback])
  }

  const distractors = shuffle(pool).slice(0, distractorsNeeded)
  return { options: shuffle([correct, ...distractors]), cachedChoices }
}

/** True if `card` still needs AI/cached distractors generated for `side`. */
export function needsChoices(card: Card, side: CardSide): boolean {
  const correct = side === 'front' ? card.front : card.back
  const pool = dedupeAgainst(correct, card.choices?.[side] ?? [])
  return pool.length < OPTIONS_NEEDED - 1
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
      if (!item || !needsChoices(item.card, item.side)) continue
      try {
        const result = await getMultipleChoiceOptions(
          item.card, item.side, item.deckCards, item.sourceLanguage, item.targetLanguage,
        )
        if (result.cachedChoices) onCached(item.card.id, result.cachedChoices)
      } catch {
        // Best-effort — the card will lazy-load its own choices when shown.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}
