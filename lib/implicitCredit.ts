/**
 * lib/implicitCredit.ts — applying a reading sighting to a card's schedules (Media Intake
 * Stage B; eligibility rules live in engine/implicitCredit.ts).
 *
 * A SIGHTING = the user logged a media page containing this card's lemma and did NOT mark it.
 * It applies a MODEST ×1.3 stretch (user decision 2026-11-08 — not a full passive Good):
 * stability ×1.3 once per ROW (lanes share D/S, so one sighting never compounds), then each
 * eligible LANE's interval is recomputed from the new stability with its own target retention
 * + calibration — exactly how the live scheduler turns stability into days.
 *
 * What a sighting deliberately does NOT do:
 *  - write a review_events row (not a recall: keeping it out keeps measured retention,
 *    calibration, and analytics honest — the media entry log is the audit trail);
 *  - bump reps, lastRating, or lastReviewedAt (a flat stretch consumes no elapsed time, so
 *    the next real review's retrievability math is untouched);
 *  - touch an overdue, short-term, relearning, dormant, or disabled-track schedule;
 *  - ever SHORTEN an interval.
 */

import type { Card, CardState } from '@/domain'
import type { CardStateRepository } from '@/lib/data/interfaces'
import { laneSightingEligible, rowSightingEligible } from '@/engine/implicitCredit'
import { fsrsFuzzRange, intervalForRetention } from '@/engine/fsrs'
import { smoothDueDate } from '@/engine/density'
import { snapDueAtToStartOfDay } from '@/lib/dates'
import { activeProductionTrack, calibrationFor, retentionFor, type EnabledTracks } from '@/lib/sessionLimits'

export interface SightingTarget {
  card:    Card
  /** The card's forward card_states row (production + recall lanes), if any. */
  forward: CardState | null
  /** The card's reverse (recognition) row, if any. */
  reverse: CardState | null
}

export interface SightingOutcome {
  /** Updated forward row + which of its lanes were credited. Absent = row untouched. */
  forward?: { state: CardState; lanes: ('production' | 'recall')[] }
  /** Updated reverse row. Absent = row untouched. */
  reverse?: CardState
}

/** The modest per-sighting stretch (user decision 2026-11-08): stability ×1.3, intervals follow. */
export const SIGHTING_STABILITY_FACTOR = 1.3

export interface SightingContext {
  userId:       string
  now:          Date
  tz:           string
  turnoverHour: number
  /** Per-(pair, answer_field) target retention / interval calibration (lib/sessionLimits maps). */
  retMap:       Map<string, number>
  calMap:       Map<string, number>
  tracks:       EnabledTracks | undefined
  stateRepo:    CardStateRepository
}

/** A lane's days from the row's post-sighting stability — same formula as the live scheduler. */
export function laneIntervalDays(stability: number, retention: number, calibration: number): number {
  return Math.max(1, calibration * intervalForRetention(stability, retention))
}

const dayMs = 86_400_000

async function laneDueAt(days: number, ctx: SightingContext): Promise<string> {
  const [minDays, maxDays] = fsrsFuzzRange(days)
  const ideal = new Date(ctx.now.getTime() + days * dayMs).toISOString()
  const smoothed = (maxDays - minDays >= 1)
    ? await smoothDueDate(ctx.userId, ideal, minDays, maxDays, days, ctx.stateRepo)
    : ideal
  return snapDueAtToStartOfDay(smoothed, ctx.tz, ctx.turnoverHour)
}

/**
 * Applies one sighting to one card. Returns the rows it changed (already persisted), or null
 * when nothing was eligible. Each lane must independently be long-term and not overdue; the
 * row-level gates (graduated / dormant / relearn / daily cap) come from the engine.
 */
export async function creditCardSighting(target: SightingTarget, ctx: SightingContext): Promise<SightingOutcome | null> {
  const { card, forward, reverse } = target
  const outcome: SightingOutcome = {}
  const pair = { src: card.sourceLanguage, tgt: card.targetLanguage }

  // ── Forward row: production lane + recall lane ─────────────────────────────
  if (forward && rowSightingEligible(forward, ctx.now)) {
    const prodTrack = activeProductionTrack(ctx.tracks)
    const prodInterval = forward.smartIntervalDays ?? forward.typedIntervalDays ?? forward.intervalDays
    const prodDueAt    = forward.smartDueAt ?? forward.typedDueAt ?? forward.dueAt

    const lanes: ('production' | 'recall')[] = []
    if (prodTrack && laneSightingEligible({ intervalDays: prodInterval, dueAt: prodDueAt }, ctx.now)) lanes.push('production')
    if (ctx.tracks?.recall && laneSightingEligible({ intervalDays: forward.recallIntervalDays, dueAt: forward.recallDueAt }, ctx.now)) lanes.push('recall')

    if (lanes.length > 0) {
      const prodField = prodTrack === 'smart' ? 'forward_smart' : 'forward_typed'
      // The modest stretch: stability ×1.3 (seeded from the lane interval for pre-FSRS rows);
      // difficulty untouched — a sighting is evidence, not a graded recall.
      const newStability = Math.max(0.5, (forward.stability ?? prodInterval ?? 1)) * SIGHTING_STABILITY_FACTOR

      const newState: CardState = {
        ...forward,
        stability:      newStability,
        lastImplicitAt: ctx.now.toISOString(),
      }

      if (lanes.includes('production')) {
        const days = Math.max(prodInterval, laneIntervalDays(newStability,
          retentionFor(ctx.retMap, pair.src, pair.tgt, prodField),
          calibrationFor(ctx.calMap, pair.src, pair.tgt, prodField)))
        const due = await laneDueAt(days, ctx)
        if (prodTrack === 'smart') { newState.smartIntervalDays = days; newState.smartDueAt = due }
        else                       { newState.typedIntervalDays = days; newState.typedDueAt = due }
        newState.intervalDays          = days
        newState.scheduledIntervalDays = days
        newState.dueAt                 = due
      }
      if (lanes.includes('recall')) {
        const days = Math.max(forward.recallIntervalDays ?? 0, laneIntervalDays(newStability,
          retentionFor(ctx.retMap, pair.src, pair.tgt, 'forward_recall'),
          calibrationFor(ctx.calMap, pair.src, pair.tgt, 'forward_recall')))
        newState.recallIntervalDays = days
        newState.recallDueAt        = await laneDueAt(days, ctx)
      }

      await ctx.stateRepo.upsert(newState)
      outcome.forward = { state: newState, lanes }
    }
  }

  // ── Reverse (recognition) row ──────────────────────────────────────────────
  // Forward graduation gates the reverse row (same rule as isCardStateDueNow); forward DORMANCY
  // does not — dormancy is per-direction.
  if (reverse && ctx.tracks?.reverse && rowSightingEligible(reverse, ctx.now)
      && forward?.graduated === true
      && laneSightingEligible({ intervalDays: reverse.recallIntervalDays ?? reverse.intervalDays, dueAt: reverse.recallDueAt ?? reverse.dueAt }, ctx.now)) {
    const interval = reverse.recallIntervalDays ?? reverse.intervalDays
    const newStability = Math.max(0.5, (reverse.stability ?? interval ?? 1)) * SIGHTING_STABILITY_FACTOR
    const days = Math.max(interval, laneIntervalDays(newStability,
      retentionFor(ctx.retMap, pair.src, pair.tgt, 'reverse_recall'),
      calibrationFor(ctx.calMap, pair.src, pair.tgt, 'reverse_recall')))
    const due = await laneDueAt(days, ctx)
    const newState: CardState = {
      ...reverse,
      stability:          newStability,
      lastImplicitAt:     ctx.now.toISOString(),
      recallIntervalDays: days,
      recallDueAt:        due,
      dueAt:              due,   // reverse rows mirror their schedule onto dueAt
    }
    await ctx.stateRepo.upsert(newState)
    outcome.reverse = newState
  }

  return (outcome.forward || outcome.reverse) ? outcome : null
}
