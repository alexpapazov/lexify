/**
 * engine/scheduler.ts
 *
 * Long-term remembering algorithm — governs how *graduated* cards are
 * re-scheduled after each review. Pre-graduation pipeline progression
 * (engine/pipeline.ts) is unaffected by anything in this file.
 *
 * Core ideas (see "Language Learning App Brainstorm" spec):
 *  - Each rating (hard/good/easy) has a [min, ideal, max] interval multiplier
 *    range that decays toward a floor as the card's interval grows
 *    (long-stable cards get smaller relative boosts). The "ideal" value
 *    drives the new interval; the full range is exposed via
 *    `idealIntervalRange()` for review-density smoothing.
 *  - Review timing (elective vs. due/overdue) is determined from `dueAt`:
 *      progress = elapsed / scheduledIntervalDays
 *      progress < 0.30        → very-early — a correct answer is a no-op
 *      0.30 <= progress < 1.0 → elective (early, but meaningful)
 *      progress >= 1.0        → due / overdue
 *  - Wrong ("again") answers on a graduated card start a 10-minute relearn
 *    loop: the card comes back due ~10 minutes later, preserving a "pending"
 *    shortened interval (currentInterval × 0.60 per "again" press, compounding,
 *    no floor). Once the learner recovers, the pending interval is multiplied
 *    by the Hard/Good/Easy multiplier and the result is floored at 1 day
 *    (Hard/Good) or 2 days (Easy).
 *  - 3+ "again" ratings within a 24h lapse cluster — whether during normal
 *    review or while already in the relearn loop — ALWAYS send the card back
 *    into the learning pipeline, regardless of timing.
 *  - All ideal intervals are capped at MAX_INTERVAL_DAYS.
 *
 * Swap in a different algorithm later by calling setActiveScheduler() —
 * nothing else changes.
 */

import type { CardState, Rating } from '@/domain'

export interface ScheduleResult {
  dueAt:             string
  /** "Ideal" interval in days (continuous, memory-state-based) — used as `currentInterval` next time. */
  intervalDays:      number
  /** The actual calendar gap (days) between `lastReviewedAt` and `dueAt`. */
  scheduledIntervalDays: number
  ease:              number
  lapseClusterCount: number
  lastLapseAt:       string | null
  /**
   * Set when a 3rd+ "again" within a lapse cluster — whether during normal
   * review or while already in the relearn loop — should send the card back
   * into the learning pipeline rather than just shrinking its interval.
   */
  relearn?:          boolean
  /**
   * 0 = not in the 10-minute "Again" relearn loop. >= 1 = how many failed
   * retries have happened since the triggering lapse.
   */
  relearningStep:    number
  /** The ideal interval (days) to apply once the relearn loop recovers. Null when not relearning. */
  pendingIntervalDays: number | null
  /** 'elective' = reviewed before the card was due; 'due' = on-time, overdue, first review, or relearn-loop activity. */
  reviewMode:        'elective' | 'due'
  /**
   * True for a correct, very-early (progress < 0.30) review: scheduling is
   * left completely unchanged (no-op) — the caller should not update
   * dueAt/intervalDays/scheduledIntervalDays/lastReviewedAt.
   */
  noChange?:         boolean
  /**
   * For correct (hard/good/easy) reviews, the [min, max] interval-day window
   * (around `intervalDays`) that engine/density.ts may smooth `dueAt` into.
   * Undefined when smoothing doesn't apply (relearn, "again", graduation, no-op).
   */
  smoothMinDays?:    number
  smoothMaxDays?:    number
}

export interface ScheduleContext {
  /** Defaults to `new Date()` — overridable for tests. */
  now?: Date
  /**
   * 0 (mild — close typo/spelling/article slip) to 1 (severe — total
   * meaning failure / blank answer). Only used for `rating === 'again'`.
   * Defaults to 0.5 (moderate) when omitted.
   */
  wrongSeverity?: number
}

export interface Scheduler {
  schedule(state: CardState, rating: Rating, ctx?: ScheduleContext): ScheduleResult
}

// ─── Tunable constants ──────────────────────────────────────────────────────

/** [min, ideal, max] interval multiplier ranges (<7 days, before decay), per the spec. */
export const MULTIPLIER_RANGE: Record<'hard' | 'good' | 'easy', { min: number; ideal: number; max: number }> = {
  hard: { min: 1.1, ideal: 1.2,  max: 1.3 },
  good: { min: 2.0, ideal: 2.25, max: 2.5 },
  easy: { min: 3.0, ideal: 3.5,  max: 4.0 },
}

/** The "ideal" multiplier from MULTIPLIER_RANGE, kept for backwards compatibility. */
export const BASE_MULTIPLIER: Record<'hard' | 'good' | 'easy', number> = {
  hard: MULTIPLIER_RANGE.hard.ideal,
  good: MULTIPLIER_RANGE.good.ideal,
  easy: MULTIPLIER_RANGE.easy.ideal,
}

/** Floors that every multiplier in MULTIPLIER_RANGE decays toward as the interval grows. */
export const MIN_EFFECTIVE_MULTIPLIER: Record<'hard' | 'good' | 'easy', number> = {
  hard: 1.0,
  good: 1.15,
  easy: 1.25,
}

/** Boosted [min, ideal, max] multipliers for fast-tracked import-known cards. */
export const ACCEL_MULTIPLIER_RANGE: Record<'hard' | 'good' | 'easy', { min: number; ideal: number; max: number }> = {
  hard: { min: 1.3, ideal: 1.5, max: 1.7 },
  good: { min: 2.5, ideal: 3.0, max: 3.5 },
  easy: { min: 4.0, ideal: 5.0, max: 6.0 },
}

/** First interval (days) assigned the moment a card graduates. */
const INITIAL_INTERVAL: Record<Rating, number> = { again: 1, hard: 1, good: 3, easy: 7 }

/**
 * Maps the number of pipeline struggles (wrong answers on any step, "?" presses,
 * and Repeat presses) to the [minDays, maxDays] interval range assigned at graduation.
 * The density smoother picks the least-loaded day within that range.
 * The ideal is Math.floor((min+max)/2).
 *
 *   0 errors  → 4–6 days  (ideal 5)
 *   1 error   → 3–4 days  (ideal 3)
 *   2 errors  → 2–3 days  (ideal 2)
 *   3 errors  → 1–2 days  (ideal 1)
 *   4+ errors → 1 day     (ideal 1)
 */
export function graduationIntervalRange(typingErrors: number): [number, number] {
  if (typingErrors === 0) return [4, 6]
  if (typingErrors === 1) return [3, 4]
  if (typingErrors === 2) return [2, 3]
  if (typingErrors === 3) return [1, 2]
  return [1, 1]
}

/** How quickly multipliers decay toward their floor as intervals grow. */
const DECAY_CONSTANT_DAYS = 90

/** "Close together" window for lapse clustering. */
const LAPSE_CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000

/** Safety cap — no ideal interval is ever scheduled beyond this many days. */
export const MAX_INTERVAL_DAYS = 1825 // ~5 years

/** How long the post-"Again" relearn retry waits before coming due again. */
const RELEARN_RETRY_MINUTES = 10
const RELEARN_RETRY_DAYS = RELEARN_RETRY_MINUTES / (24 * 60)

/** Below this fraction of the scheduled interval, a correct review is a pure no-op. */
const VERY_EARLY_THRESHOLD = 0.30

/** Each "again"/"?" press multiplies the pending interval by this factor (40% reduction). */
const AGAIN_REDUCTION = 0.60

/** Minimum output interval for Hard and Good ratings (after multiplier). */
const HARD_GOOD_MIN_DAYS = 1

/** Minimum output interval for Easy rating (after multiplier). */
const EASY_MIN_DAYS = 2

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function addDays(d: Date, days: number): string {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
}

function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)
}

/**
 * Decays a base multiplier toward 1 as `currentIntervalDays` grows:
 *   effective = 1 + (base - 1) / (1 + currentInterval / decayConstantDays)
 */
export function applyMultiplierDecay(
  baseMultiplier: number,
  currentIntervalDays: number,
  decayConstantDays = DECAY_CONSTANT_DAYS,
): number {
  const decayFactor = 1 / (1 + currentIntervalDays / decayConstantDays)
  return 1 + (baseMultiplier - 1) * decayFactor
}

export interface EffectiveMultiplierRange {
  min:   number
  ideal: number
  max:   number
}

/**
 * Decays each of [min, ideal, max] toward 1 as `currentIntervalDays` grows,
 * then floors each at MIN_EFFECTIVE_MULTIPLIER[rating].
 */
export function effectiveMultiplierRange(
  rating: 'hard' | 'good' | 'easy',
  currentIntervalDays: number,
): EffectiveMultiplierRange {
  const range = MULTIPLIER_RANGE[rating]
  const floor = MIN_EFFECTIVE_MULTIPLIER[rating]
  return {
    min:   Math.max(applyMultiplierDecay(range.min,   currentIntervalDays), floor),
    ideal: Math.max(applyMultiplierDecay(range.ideal, currentIntervalDays), floor),
    max:   Math.max(applyMultiplierDecay(range.max,   currentIntervalDays), floor),
  }
}

/**
 * Like effectiveMultiplierRange but for fast-tracked cards. `penalty` linearly
 * blends the boost from accelerated toward normal (0 = full acceleration,
 * 3+ = normal multipliers). Same decay formula and floors as the normal path.
 */
export function acceleratedEffectiveMultiplierRange(
  rating:              'hard' | 'good' | 'easy',
  currentIntervalDays: number,
  penalty:             number,
): EffectiveMultiplierRange {
  const accel  = ACCEL_MULTIPLIER_RANGE[rating]
  const normal = MULTIPLIER_RANGE[rating]
  const blend  = Math.min(penalty / 3, 1)   // 0 = full accel, 1 = full normal

  const blended = {
    min:   normal.min   + (accel.min   - normal.min)   * (1 - blend),
    ideal: normal.ideal + (accel.ideal - normal.ideal) * (1 - blend),
    max:   normal.max   + (accel.max   - normal.max)   * (1 - blend),
  }

  const floor = MIN_EFFECTIVE_MULTIPLIER[rating]
  return {
    min:   Math.max(applyMultiplierDecay(blended.min,   currentIntervalDays), floor),
    ideal: Math.max(applyMultiplierDecay(blended.ideal, currentIntervalDays), floor),
    max:   Math.max(applyMultiplierDecay(blended.max,   currentIntervalDays), floor),
  }
}

/**
 * The [min, ideal, max] interval-day range (around the ideal new interval)
 * that review-density smoothing may pick a due date from. Intervals shorter
 * than the smoothing threshold (engine/density.ts) aren't smoothed at all.
 */
export function idealIntervalRange(
  rating: 'hard' | 'good' | 'easy',
  currentIntervalDays: number,
): { minDays: number; idealDays: number; maxDays: number } {
  const r = effectiveMultiplierRange(rating, currentIntervalDays)
  return {
    minDays:   clamp(round3(currentIntervalDays * r.min),   1, MAX_INTERVAL_DAYS),
    idealDays: clamp(round3(currentIntervalDays * r.ideal), 1, MAX_INTERVAL_DAYS),
    maxDays:   clamp(round3(currentIntervalDays * r.max),   1, MAX_INTERVAL_DAYS),
  }
}

function newEaseFor(rating: Rating, ease: number): number {
  if (rating === 'hard') return clamp(ease - 0.15, 1.3, 3.0)
  if (rating === 'easy') return clamp(ease + 0.15, 1.3, 3.0)
  return ease
}

/** Was the most recent post-graduation lapse "close together" with `now`? */
function lapseClusterCountFor(state: CardState, now: Date): number {
  const closeTogether = !!state.lastLapseAt
    && (now.getTime() - new Date(state.lastLapseAt).getTime()) <= LAPSE_CLUSTER_WINDOW_MS
  return closeTogether ? state.lapseClusterCount + 1 : 1
}

/**
 * Classifies an *upcoming* review of `state` as 'elective' (the card isn't
 * due yet) or 'due' (on-time, overdue, first-ever, or pre-graduation) —
 * based on `dueAt`/`scheduledIntervalDays`, per the spec. Callers compute
 * this BEFORE calling scheduleNext/progressAfterReview, since it describes
 * the review that's about to happen.
 */
export function classifyReviewMode(state: CardState, now: Date = new Date()): 'elective' | 'due' {
  if (!state.graduated || !state.lastReviewedAt || state.relearningStep > 0) return 'due'
  const scheduledInterval = state.scheduledIntervalDays > 0 ? state.scheduledIntervalDays : state.intervalDays
  if (scheduledInterval <= 0) return 'due'
  const elapsed  = daysSince(state.lastReviewedAt, now)
  const progress = elapsed / scheduledInterval
  return progress < 1 ? 'elective' : 'due'
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

class AdaptiveScheduler implements Scheduler {
  schedule(state: CardState, rating: Rating, ctx: ScheduleContext = {}): ScheduleResult {
    const now = ctx.now ?? new Date()

    // ── Graduation / first long-term review ────────────────────────────────
    // No prior interval to base the adaptive formula on — use a flat
    // starting interval keyed off the rating that just graduated the card.
    if (!state.lastReviewedAt || state.intervalDays <= 0) {
      const interval = INITIAL_INTERVAL[rating]
      return {
        dueAt:                 addDays(now, interval),
        intervalDays:          interval,
        scheduledIntervalDays: interval,
        ease:                  state.ease,
        lapseClusterCount:     rating === 'again' ? 1 : 0,
        lastLapseAt:           rating === 'again' ? now.toISOString() : state.lastLapseAt,
        relearningStep:        0,
        pendingIntervalDays:   null,
        reviewMode:            'due',
      }
    }

    const currentInterval = state.intervalDays
    const elapsed         = Math.max(0, daysSince(state.lastReviewedAt, now))
    // Timing classification is based on the actual scheduled calendar gap
    // (dueAt - lastReviewedAt), not the "ideal" interval — falls back to
    // `currentInterval` for rows from before this field existed.
    const scheduledInterval = state.scheduledIntervalDays > 0 ? state.scheduledIntervalDays : currentInterval
    const progress = scheduledInterval > 0 ? elapsed / scheduledInterval : 1
    const early    = progress < 1

    // ── Recovery / continuation of the 10-minute relearn loop ──────────────
    if (state.relearningStep > 0) {
      if (rating === 'again') {
        const clusterCount = lapseClusterCountFor(state, now)

        if (clusterCount >= 3) {
          return {
            dueAt: addDays(now, 1), intervalDays: 1, scheduledIntervalDays: 1, ease: state.ease,
            lapseClusterCount: clusterCount, lastLapseAt: now.toISOString(), relearn: true,
            relearningStep: 0, pendingIntervalDays: null, reviewMode: 'due',
          }
        }

        // Failed the retry again — shrink the pending interval further and
        // schedule another 10-minute retry.
        const basePending = state.pendingIntervalDays ?? currentInterval
        const pending      = round3(basePending * AGAIN_REDUCTION)
        return {
          dueAt: addDays(now, RELEARN_RETRY_DAYS), intervalDays: currentInterval,
          scheduledIntervalDays: RELEARN_RETRY_DAYS, ease: state.ease,
          lapseClusterCount: clusterCount, lastLapseAt: now.toISOString(),
          relearningStep: state.relearningStep + 1, pendingIntervalDays: pending, reviewMode: 'due',
        }
      }

      // Recovered — apply the multiplier to the pending interval.
      const pendingInterval = state.pendingIntervalDays ?? currentInterval
      const recoverRange    = effectiveMultiplierRange(rating as 'hard' | 'good' | 'easy', pendingInterval)
      const outputFloorR    = rating === 'easy' ? EASY_MIN_DAYS : HARD_GOOD_MIN_DAYS
      const interval        = clamp(Math.max(outputFloorR, round3(pendingInterval * recoverRange.ideal)), outputFloorR, MAX_INTERVAL_DAYS)
      return {
        dueAt: addDays(now, interval), intervalDays: interval, scheduledIntervalDays: interval,
        ease: newEaseFor(rating, state.ease), lapseClusterCount: 0, lastLapseAt: state.lastLapseAt,
        relearningStep: 0, pendingIntervalDays: null, reviewMode: 'due',
      }
    }

    const reviewMode: 'elective' | 'due' = early ? 'elective' : 'due'

    // ── Very-early correct guard ────────────────────────────────────────────
    // A correct answer well before the card is due records practice but does
    // not change the schedule at all.
    // Exception: if the card IS past its dueAt, never treat it as very-early.
    // Fast-track cards can have scheduledIntervalDays (30) much larger than
    // the actual spread gap (e.g. 1 day), causing progress << threshold even
    // when the card is genuinely due.
    const cardIsDue = state.dueAt ? new Date(state.dueAt) <= now : false
    if (rating !== 'again' && progress < VERY_EARLY_THRESHOLD && !cardIsDue) {
      return {
        dueAt: state.dueAt ?? addDays(now, currentInterval),
        intervalDays: currentInterval, scheduledIntervalDays: scheduledInterval,
        ease: state.ease, lapseClusterCount: state.lapseClusterCount, lastLapseAt: state.lastLapseAt,
        relearningStep: 0, pendingIntervalDays: null, reviewMode: 'elective', noChange: true,
      }
    }

    // ── Wrong answer — start the 10-minute relearn loop ─────────────────────
    if (rating === 'again') {
      const clusterCount = lapseClusterCountFor(state, now)

      if (clusterCount >= 3) {
        // 3+ wrongs within a lapse cluster — ALWAYS send back to the
        // learning pipeline, regardless of elective/due timing.
        return {
          dueAt: addDays(now, 1), intervalDays: 1, scheduledIntervalDays: 1, ease: state.ease,
          lapseClusterCount: clusterCount, lastLapseAt: now.toISOString(), relearn: true,
          relearningStep: 0, pendingIntervalDays: null, reviewMode,
        }
      }

      // Reduce the current interval by AGAIN_REDUCTION — applied to the
      // pending interval once the learner recovers, not the card's stored
      // interval (so the multiplier has something to work with on recovery).
      const pending = round3(currentInterval * AGAIN_REDUCTION)

      return {
        dueAt: addDays(now, RELEARN_RETRY_DAYS), intervalDays: currentInterval,
        scheduledIntervalDays: RELEARN_RETRY_DAYS, ease: state.ease,
        lapseClusterCount: clusterCount, lastLapseAt: now.toISOString(),
        relearningStep: 1, pendingIntervalDays: pending, reviewMode,
      }
    }

    // ── Correct answer (hard / good / easy) ─────────────────────────────────
    const isAccelerated = state.acceleratedMode === 'import_known'
                       && state.acceleratedWrongStreak < 2
    const range = isAccelerated
      ? acceleratedEffectiveMultiplierRange(rating, currentInterval, state.acceleratedPenalty)
      : effectiveMultiplierRange(rating, currentInterval)
    let newInterval: number
    let smoothMinDays: number
    let smoothMaxDays: number
    if (early) {
      // Blend toward "no change" the further ahead of schedule we are.
      const blend = (m: number) => 1 + progress * (m - 1)
      newInterval   = currentInterval * blend(range.ideal)
      smoothMinDays = currentInterval * blend(range.min)
      smoothMaxDays = currentInterval * blend(range.max)
    } else {
      // On-time or overdue: reward the longer real-world gap, then apply
      // the (decayed) multiplier on top of it.
      const baseInterval = Math.max(elapsed, currentInterval)
      newInterval   = baseInterval * range.ideal
      smoothMinDays = baseInterval * range.min
      smoothMaxDays = baseInterval * range.max
    }
    const outputFloor = rating === 'easy' ? EASY_MIN_DAYS : HARD_GOOD_MIN_DAYS
    newInterval   = clamp(Math.max(outputFloor, round3(newInterval)),   outputFloor, MAX_INTERVAL_DAYS)
    smoothMinDays = clamp(Math.max(outputFloor, round3(smoothMinDays)), outputFloor, MAX_INTERVAL_DAYS)
    smoothMaxDays = clamp(Math.max(outputFloor, round3(smoothMaxDays)), outputFloor, MAX_INTERVAL_DAYS)

    return {
      dueAt:                 addDays(now, newInterval),
      intervalDays:          newInterval,
      scheduledIntervalDays: newInterval,
      ease:                  newEaseFor(rating, state.ease),
      lapseClusterCount:     0,
      lastLapseAt:           state.lastLapseAt,
      relearningStep:        0,
      pendingIntervalDays:   null,
      reviewMode,
      smoothMinDays,
      smoothMaxDays,
    }
  }
}

let _activeScheduler: Scheduler = new AdaptiveScheduler()

export function getActiveScheduler(): Scheduler { return _activeScheduler }
export function setActiveScheduler(s: Scheduler): void { _activeScheduler = s }
export function scheduleNext(state: CardState, rating: Rating, ctx?: ScheduleContext): ScheduleResult {
  return getActiveScheduler().schedule(state, rating, ctx)
}
