/**
 * lib/ladderSession.ts — the bridge between the ladder engine and the existing
 * study screens. Pure helpers shared by all three study pages so the ladder
 * behaves identically everywhere. No React / Supabase here.
 */

import type { Rung, Rating } from '@/domain'
import type { RungAttemptOutcome, IntervalRange, ReshowHint } from '@/engine/ladderEngine'

/** Which existing study screen renders a given rung. */
type RungUI = 'mcq' | 'typing' | 'flashcard' | 'dictation'

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

/** Wait after advancing to the next rung, so a card spaces out between rungs
 *  instead of climbing back-to-back. Same soft-timer mechanism as Again/Hard/Good. */
const BETWEEN_RUNG_DELAY_MS = 180_000  // 3 min

/**
 * How long a card should be held before reappearing. When it STAYED on a rung we
 * burn as much of its window as possible: Again ≤ 1 min, Hard ≤ 5 min, Good (first)
 * ≤ 10 min. When it ADVANCED to the next rung, a 3-minute between-rung wait applies.
 */
export function reshowDelayMs(hint: ReshowHint): number {
  switch (hint) {
    case 'soon':     return 60_000                  // Again
    case 'short':    return 300_000                 // Hard
    case 'medium':   return 600_000                 // Good (first)
    case 'advanced': return BETWEEN_RUNG_DELAY_MS   // moved up a rung → 3-min wait
    default:         return 0
  }
}

export const DEFAULT_WRONG_WAIT_SECONDS = 60     // 1 min
export const DEFAULT_CORRECT_WAIT_SECONDS = 360  // 6 min

/** True when a single correct answer advances the rung (any advance rule needs ≤1). */
export function rungIsSingleStep(rung: Rung): boolean {
  const rules = rung.advanceRules && rung.advanceRules.length > 0 ? rung.advanceRules : [{ times: rung.advanceTimes }]
  return rules.some(r => (r.times ?? 1) <= 1)
}

/**
 * How long (ms) a card rests before reappearing after one attempt.
 *  - Self-rated / self-graded rungs keep the rating-based windows (reshowDelayMs; global gap on advance).
 *  - Auto-checked rungs use their manual wrong/correct waits (defaults 1 min / 6 min): a WRONG answer
 *    waits `wrongWaitSeconds`; a CORRECT answer that doesn't yet advance waits `correctWaitSeconds`; and
 *    a correct answer that advances a SINGLE-STEP rung waits `correctWaitSeconds` in place of the global
 *    between-rungs gap (multi-step advances still use the global gap; drop-backs use the wrong wait).
 */
export function rungReshowMs(rung: Rung, res: { reshow: ReshowHint; advanced: boolean }, globalBetweenSeconds: number): number {
  const globalMs = Math.max(0, globalBetweenSeconds) * 1000
  if (rung.selfRated || rung.type === 'self_graded') {
    return res.reshow === 'advanced' ? globalMs : reshowDelayMs(res.reshow)
  }
  const wrong = Math.max(0, rung.wrongWaitSeconds ?? DEFAULT_WRONG_WAIT_SECONDS) * 1000
  const correct = Math.max(0, rung.correctWaitSeconds ?? DEFAULT_CORRECT_WAIT_SECONDS) * 1000
  if (res.advanced) {
    if (res.reshow !== 'advanced') return wrong                       // drop-back → treat as wrong
    return rungIsSingleStep(rung) ? correct : globalMs                // single-step correct overrides global
  }
  return res.reshow === 'soon' ? wrong : correct                     // 'soon' = wrong; 'medium' = correct
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
