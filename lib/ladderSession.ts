/**
 * lib/ladderSession.ts — the bridge between the ladder engine and the existing
 * study screens. Pure helpers shared by all three study pages so the ladder
 * behaves identically everywhere. No React / Supabase here.
 */

import type { Rung, Rating } from '@/domain'
import type { RungAttemptOutcome, IntervalRange, ReshowHint } from '@/engine/ladderEngine'

/** Which existing study screen renders a given rung. */
export type RungUI = 'mcq' | 'typing' | 'flashcard' | 'dictation'

export function rungUI(rung: Rung): RungUI {
  if (rung.type === 'mcq') return 'mcq'
  if (rung.type === 'self_graded') return 'flashcard'
  if (rung.type === 'dictation') return 'dictation'
  return 'typing'
}

/** True when the learner must produce the native side (prompt/answer swapped). */
export function producesNative(rung: Rung): boolean {
  return rung.direction === 'produce_native'
}

/**
 * Maps a multiple-choice result (+ optional self-rating) to a ladder outcome.
 * On a self-rated rung a wrong pick is auto-Again; a correct one carries the rating.
 */
export function mcqOutcome(correct: boolean, selfRated: boolean, rating?: Rating): RungAttemptOutcome {
  if (selfRated) return correct ? (rating ?? 'good') : 'again'
  return correct ? 'pass' : 'miss'
}

/**
 * Maps a typed/dictation grade (already resolved to pass / almost / miss by the
 * rung's strictness) + optional self-rating to a ladder outcome.
 */
export function typedOutcome(status: 'pass' | 'almost' | 'miss', selfRated: boolean, rating?: Rating): RungAttemptOutcome {
  if (selfRated) return status === 'pass' ? (rating ?? 'good') : 'again'
  return status
}

/**
 * Picks the least-busy day inside an interval range (load-balancing), given how
 * many cards are already due `d` days out. Ties keep the earliest day.
 */
export function pickIntervalDay(range: IntervalRange, dueInDays: Map<number, number>): number {
  let best = range.min
  let bestCount = dueInDays.get(range.min) ?? 0
  for (let d = range.min + 1; d <= range.max; d++) {
    const c = dueInDays.get(d) ?? 0
    if (c < bestCount) { bestCount = c; best = d }
  }
  return best
}

// ─── In-session re-show timing (short Again/Hard/Good windows) ────────────────

/** A card waiting in the session queue. `readyAt` = 0 means no timer (free to show). */
export interface QueueItem { cardId: string; readyAt: number; ratedAt: number }

/**
 * How long a card that STAYED on a rung should be held before reappearing — we
 * want to burn as much of the window as possible: Again ≤ 1 min, Hard ≤ 5 min,
 * Good (first) ≤ 10 min. Advancing/other outcomes have no timer (0).
 */
export function reshowDelayMs(hint: ReshowHint): number {
  switch (hint) {
    case 'soon':   return 60_000    // Again
    case 'short':  return 300_000   // Hard
    case 'medium': return 600_000   // Good (first)
    default:       return 0
  }
}

function pctElapsed(e: QueueItem, now: number): number {
  return e.readyAt <= e.ratedAt ? 1 : (now - e.ratedAt) / (e.readyAt - e.ratedAt)
}

/**
 * Chooses the next card to show:
 *  1. A card whose timer has ELAPSED (readyAt ≤ now) must go next — most-overdue first;
 *  2. otherwise fill the time with a free card (no timer);
 *  3. if every remaining card is still waiting on a timer, show the one closest to its
 *     target (greatest % of its window elapsed).
 * Avoids immediately repeating `avoidId` when another card is available.
 */
export function pickNextCard(queue: QueueItem[], now: number, avoidId?: string): QueueItem | null {
  if (queue.length === 0) return null
  const others = queue.filter(e => e.cardId !== avoidId)
  const pool = others.length ? others : queue

  const eligible = pool.filter(e => e.readyAt <= now)
  if (eligible.length) {
    const overdueTimers = eligible.filter(e => e.readyAt > 0).sort((a, b) => a.readyAt - b.readyAt)
    return overdueTimers[0] ?? eligible.find(e => e.readyAt === 0) ?? eligible[0]!
  }
  return [...pool].sort((a, b) => pctElapsed(b, now) - pctElapsed(a, now))[0]!
}
