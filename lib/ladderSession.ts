/**
 * lib/ladderSession.ts — the bridge between the ladder engine and the existing
 * study screens. Pure helpers shared by all three study pages so the ladder
 * behaves identically everywhere. No React / Supabase here.
 */

import type { Rung, Rating } from '@/domain'
import type { RungAttemptOutcome, IntervalRange } from '@/engine/ladderEngine'

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
