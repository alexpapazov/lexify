/**
 * engine/scheduler.ts
 *
 * Long-term remembering algorithm — governs how *graduated* cards are
 * re-scheduled after each review. Pre-graduation pipeline progression
 * (engine/pipeline.ts) is unaffected by anything in this file.
 *
 * Core ideas (see "Language Learning App Brainstorm" spec):
 *  - Each rating (hard/good/easy) has a base interval multiplier that decays
 *    toward a floor as the card's interval grows (long-stable cards get
 *    smaller relative boosts).
 *  - Reviews are classified by `progress = elapsed / currentInterval`:
 *      progress < 1  → early/elective review (reviewed ahead of schedule)
 *      progress >= 1 → on-time or overdue review
 *  - Wrong ("again") answers shrink the interval based on whether the
 *    review was early/elective or due/overdue, how severe the mistake was
 *    (wrongSeverity, 0-1), and whether this is part of a "lapse cluster"
 *    (repeated wrongs close together).
 *
 * Swap in a different algorithm later by calling setActiveScheduler() —
 * nothing else changes.
 */

import type { CardState, Rating } from '@/domain'

export interface ScheduleResult {
  dueAt:             string
  /** "Ideal" interval in days (continuous, memory-state-based) — used as `currentInterval` next time. */
  intervalDays:      number
  ease:              number
  lapseClusterCount: number
  lastLapseAt:       string | null
  /**
   * Set when a 3rd+ "again" on an early/elective review should send the
   * card back into the learning pipeline rather than just shrinking its
   * interval.
   */
  relearn?:          boolean
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

/** "<7 days" base multipliers from the spec. */
export const BASE_MULTIPLIER: Record<'hard' | 'good' | 'easy', number> = {
  hard: 1.2,
  good: 2.25,
  easy: 3.5,
}

/** Floors that `BASE_MULTIPLIER` decays toward as the interval grows. */
export const MIN_EFFECTIVE_MULTIPLIER: Record<'hard' | 'good' | 'easy', number> = {
  hard: 1.0,
  good: 1.15,
  easy: 1.25,
}

/** First interval (days) assigned the moment a card graduates. */
const INITIAL_INTERVAL: Record<Rating, number> = { again: 1, hard: 1, good: 3, easy: 7 }

/** How quickly multipliers decay toward their floor as intervals grow. */
const DECAY_CONSTANT_DAYS = 90

/** "Close together" window for lapse clustering. */
const LAPSE_CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000

// Wrong-answer interval multiplier ranges, by lapse-cluster position.
// [low, high] — `wrongSeverity` interpolates between them (0 = high/mild, 1 = low/severe).
const EARLY_WRONG_RANGE_1 = [0.5, 0.8] as const
const EARLY_WRONG_RANGE_2 = [0.25, 0.5] as const
const DUE_WRONG_RANGE_1   = [0.3, 0.5] as const
const DUE_WRONG_RANGE_2   = [0.15, 0.25] as const

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

function effectiveMultiplier(rating: 'hard' | 'good' | 'easy', currentIntervalDays: number): number {
  const decayed = applyMultiplierDecay(BASE_MULTIPLIER[rating], currentIntervalDays)
  return Math.max(decayed, MIN_EFFECTIVE_MULTIPLIER[rating])
}

/** Interpolates a [low, high] range by severity — 0 → high, 1 → low. */
function severityMultiplier(range: readonly [number, number], severity: number): number {
  const [lo, hi] = range
  return hi - (hi - lo) * clamp(severity, 0, 1)
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

class AdaptiveScheduler implements Scheduler {
  schedule(state: CardState, rating: Rating, ctx: ScheduleContext = {}): ScheduleResult {
    const now      = ctx.now ?? new Date()
    const severity = ctx.wrongSeverity ?? 0.5

    // ── Graduation / first long-term review ────────────────────────────────
    // No prior interval to base the adaptive formula on — use a flat
    // starting interval keyed off the rating that just graduated the card.
    if (!state.lastReviewedAt || state.intervalDays <= 0) {
      const interval = INITIAL_INTERVAL[rating]
      return {
        dueAt:             addDays(now, interval),
        intervalDays:      interval,
        ease:              state.ease,
        lapseClusterCount: rating === 'again' ? 1 : 0,
        lastLapseAt:       rating === 'again' ? now.toISOString() : state.lastLapseAt,
      }
    }

    const currentInterval = state.intervalDays
    const elapsed         = Math.max(0, daysSince(state.lastReviewedAt, now))
    const progress        = currentInterval > 0 ? elapsed / currentInterval : 1
    const early           = progress < 1

    // ── Wrong answer ─────────────────────────────────────────────────────
    if (rating === 'again') {
      const closeTogether = !!state.lastLapseAt
        && (now.getTime() - new Date(state.lastLapseAt).getTime()) <= LAPSE_CLUSTER_WINDOW_MS
      const clusterCount = closeTogether ? state.lapseClusterCount + 1 : 1

      if (early) {
        if (clusterCount >= 3) {
          // Three wrongs in a row on an elective review — send back to the
          // learning pipeline rather than just shrinking the interval further.
          return {
            dueAt: addDays(now, 1), intervalDays: 1, ease: state.ease,
            lapseClusterCount: clusterCount, lastLapseAt: now.toISOString(), relearn: true,
          }
        }
        const range    = clusterCount === 1 ? EARLY_WRONG_RANGE_1 : EARLY_WRONG_RANGE_2
        const mult     = severityMultiplier(range, severity)
        const interval = Math.max(1, round3(elapsed * mult))
        return {
          dueAt: addDays(now, interval), intervalDays: interval, ease: state.ease,
          lapseClusterCount: clusterCount, lastLapseAt: now.toISOString(),
        }
      }

      // Due / overdue wrong — "don't reward overdue failure": shrink from
      // currentInterval (the memory-state interval), never from elapsed.
      if (clusterCount >= 3) {
        return {
          dueAt: addDays(now, 1), intervalDays: 1, ease: state.ease,
          lapseClusterCount: clusterCount, lastLapseAt: now.toISOString(),
        }
      }
      const range    = clusterCount === 1 ? DUE_WRONG_RANGE_1 : DUE_WRONG_RANGE_2
      const mult     = severityMultiplier(range, severity)
      const interval = Math.max(1, round3(currentInterval * mult))
      return {
        dueAt: addDays(now, interval), intervalDays: interval, ease: state.ease,
        lapseClusterCount: clusterCount, lastLapseAt: now.toISOString(),
      }
    }

    // ── Correct answer (hard / good / easy) ────────────────────────────────
    const mult = effectiveMultiplier(rating, currentInterval)
    let newInterval: number
    if (early) {
      // Blend toward "no change" the further ahead of schedule we are.
      const blended = 1 + progress * (mult - 1)
      newInterval = currentInterval * blended
    } else {
      // On-time or overdue: reward the longer real-world gap, then apply
      // the (decayed) multiplier on top of it.
      const baseInterval = Math.max(elapsed, currentInterval)
      newInterval = baseInterval * mult
    }
    newInterval = Math.max(1, round3(newInterval))

    const newEase =
      rating === 'hard' ? clamp(state.ease - 0.15, 1.3, 3.0) :
      rating === 'easy' ? clamp(state.ease + 0.15, 1.3, 3.0) :
      state.ease

    return {
      dueAt:             addDays(now, newInterval),
      intervalDays:      newInterval,
      ease:              newEase,
      lapseClusterCount: 0,
      lastLapseAt:       state.lastLapseAt,
    }
  }
}

let _activeScheduler: Scheduler = new AdaptiveScheduler()

export function getActiveScheduler(): Scheduler { return _activeScheduler }
export function setActiveScheduler(s: Scheduler): void { _activeScheduler = s }
export function scheduleNext(state: CardState, rating: Rating, ctx?: ScheduleContext): ScheduleResult {
  return getActiveScheduler().schedule(state, rating, ctx)
}
