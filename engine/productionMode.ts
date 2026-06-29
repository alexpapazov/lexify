/**
 * engine/productionMode.ts
 *
 * Decides whether a graduated card's next review should use **typed
 * production** (type the answer, graded automatically) or **self-graded
 * production** (recall it, then self-rate Again/Hard/Good/Easy) — per the
 * spec:
 *
 *   Mandatory typing continues until ALL of:
 *     - at least 14 days have passed since (re)graduation
 *     - at least 4 typed reviews have been completed
 *     - recent typed accuracy is at least 85%
 *
 *   Afterward, typed production is chosen probabilistically based on
 *   recent typed accuracy:
 *     < 70%      → 100% typed
 *     70% - 84%  → 70% typed
 *     85% - 94%  → 35% typed
 *     >= 95%     → 15% typed
 *
 *   Forced typing (overrides everything above, returns 'typed'):
 *     - `forcedTypedRemaining > 0` — set by pipeline.ts after: a typed
 *       answer with a spelling/accent/gender/article error (3 reviews), a
 *       self-graded "Again" (1 review), or a return to relearning (1 review).
 *     - No typed review in the last 90 days (`lastTypedReviewAt`).
 *     - The most recent rating was "Hard" — a lightweight approximation of
 *       "reports Hard repeatedly" given the fields available on CardState;
 *       a single recent "Hard" nudges the next review back to typed so
 *       repeated "Hard"s naturally keep the card in typed mode.
 *
 * Pure function — no I/O. `rng` is injectable for deterministic tests.
 */

import type { CardState, SchedulerParams } from '@/domain'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'

export type ProductionMode = 'typed' | 'self-graded'

/** Rolling window size for `typedAccuracyWindow` (see domain CardState). */
export const TYPED_ACCURACY_WINDOW_SIZE = 20

/** How many reviews a typed spelling/accent/gender/article error forces typing for. */
export const FORCED_TYPED_ON_TYPO_ERROR = 3

/** How many reviews a self-graded "Again" or a return to relearning forces typing for. */
export const FORCED_TYPED_ON_LAPSE = 1

const MANDATORY_DAYS_SINCE_GRADUATION = 14
const MANDATORY_MIN_TYPED_REVIEWS     = 4
const MANDATORY_MIN_ACCURACY          = 0.85

const NO_TYPED_REVIEW_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / DAY_MS
}

function recentTypedAccuracy(state: CardState): number {
  const window = state.typedAccuracyWindow
  if (window.length === 0) return 0
  return window.reduce((sum, v) => sum + v, 0) / window.length
}

export function decideProductionMode(
  state: CardState,
  now: Date = new Date(),
  rng: () => number = Math.random,
  params: SchedulerParams = DEFAULT_SCHEDULER_PARAMS,
): ProductionMode {
  // ── Forced typing (highest priority) ────────────────────────────────────
  if (state.forcedTypedRemaining > 0) return 'typed'

  if (state.lastRating === 'hard') return 'typed'

  if (!state.lastTypedReviewAt || daysSince(state.lastTypedReviewAt, now) >= NO_TYPED_REVIEW_DAYS) {
    return 'typed'
  }

  // ── Mandatory typing window since (re)graduation ────────────────────────
  const daysSinceGraduation = state.graduatedAt ? daysSince(state.graduatedAt, now) : 0
  const accuracy = recentTypedAccuracy(state)

  if (
    daysSinceGraduation < MANDATORY_DAYS_SINCE_GRADUATION ||
    state.typedReviewCount < MANDATORY_MIN_TYPED_REVIEWS ||
    accuracy < MANDATORY_MIN_ACCURACY
  ) {
    return 'typed'
  }

  // ── Probabilistic typed production based on recent typed accuracy ───────
  let typedProbability: number
  if (accuracy < 0.70)      typedProbability = params.typedProbBelow70
  else if (accuracy < 0.85) typedProbability = params.typedProb70to84
  else if (accuracy < 0.95) typedProbability = params.typedProb85to94
  else                       typedProbability = params.typedProb95plus

  return rng() < typedProbability ? 'typed' : 'self-graded'
}
