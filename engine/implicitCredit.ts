/**
 * engine/implicitCredit.ts — maturity phases + reading-sighting eligibility (Media Intake
 * Stages A/B, user design 2026-11-06). Pure, framework-free.
 *
 * TWO maturity phases, no middle band (user decision): a scheduled track is **long-term** once
 * its interval reaches LONG_TERM_THRESHOLD_DAYS, otherwise **short-term**. Only long-term tracks earn
 * IMPLICIT credit: reading a page that contains the word WITHOUT marking it is passive proof of
 * knowledge, applied as a passive Good on the schedule. Short-term tracks get nothing from a
 * sighting — recall that young must be earned in sessions.
 *
 * Eligibility is two-level:
 *  - per ROW (a card_states row): graduated, not dormant, not in the relearn loop, and not
 *    already credited within the last IMPLICIT_CREDIT_MIN_GAP_HOURS (the one-per-day cap —
 *    hours-based so time zones and turnover need no plumbing here);
 *  - per LANE (production / recall / reverse schedule on that row): long-term phase AND not
 *    overdue. An overdue card stays due — a passive sighting must never stand in for the
 *    review you already owe (user default 2026-11-06).
 *
 * The schedule math itself reuses `scheduleGraduatedFsrs` (a plain Good) in lib/implicitCredit;
 * this module only answers "may this sighting count?".
 */

import type { CardState } from '@/domain'

export type MaturityPhase = 'short_term' | 'long_term'

/** The long-term line: a track whose scheduled interval is at or past this is long-term.
 *  Set to 30 (user decision 2026-11-06, from simulated trajectories: a Good-path word crosses
 *  after ~2 reviews, a hard word after ~7 — reading volume takes over maintenance from there;
 *  originally 60). */
export const LONG_TERM_THRESHOLD_DAYS = 30

/** Minimum hours between implicit credits on one row — the "max one per day" cap. */
export const IMPLICIT_CREDIT_MIN_GAP_HOURS = 20

export function maturityPhase(intervalDays: number | null | undefined): MaturityPhase {
  return (intervalDays ?? 0) >= LONG_TERM_THRESHOLD_DAYS ? 'long_term' : 'short_term'
}

/** One schedulable lane on a card_states row (production / recall / reverse). */
export interface SightingLane {
  intervalDays: number | null
  dueAt:        string | null
}

/** Row-level gate: can this card_states row receive ANY implicit credit right now? */
export function rowSightingEligible(
  row: Pick<CardState, 'graduated' | 'dormant' | 'relearning' | 'relearningStep' | 'lastImplicitAt'>,
  now: Date,
): boolean {
  if (!row.graduated || row.dormant || row.relearning || row.relearningStep > 0) return false
  if (row.lastImplicitAt) {
    const hours = (now.getTime() - new Date(row.lastImplicitAt).getTime()) / 3_600_000
    if (hours < IMPLICIT_CREDIT_MIN_GAP_HOURS) return false
  }
  return true
}

/** Lane-level gate: long-term phase, scheduled, and not overdue. */
export function laneSightingEligible(lane: SightingLane, now: Date): boolean {
  if (maturityPhase(lane.intervalDays) !== 'long_term') return false
  if (!lane.dueAt) return false
  return new Date(lane.dueAt).getTime() > now.getTime()
}
