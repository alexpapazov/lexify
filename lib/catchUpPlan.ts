/**
 * lib/catchUpPlan.ts — remembering a catch-up so it can be tracked and re-levelled.
 *
 * Spreading a backlog is a one-shot write; a PLAN is the thin record that makes it followable: how
 * many cards it claimed, by when, so a progress bar can say "51 of 81 done" and Reassign can re-deal
 * whatever is still owed.
 *
 * ── What is stored, and what is not ───────────────────────────────────────────
 * Stored: `targetDate`, `startedOn`, `total` — all three are HISTORICAL FACTS about the moment the
 * plan was made. None of them changes, so none of them can drift.
 *
 * NOT stored: how many are left. That is derived from the live cards every time (`countOwed`). This
 * split is the whole discipline — the earlier version of this feature stored a changing quantity and
 * went stale the moment reality diverged. Store what happened; derive what is true now.
 *
 * ── How a claimed card is recognised without a marker column ──────────────────
 * `CardState.scheduledIntervalDays` is defined as the actual calendar gap between `lastReviewedAt`
 * and `dueAt` after smoothing. So for a card nobody has touched, `due − lastReviewed ≈
 * scheduledIntervalDays`. Catch-up pushes `dueAt` further out WITHOUT a review, which makes that gap
 * strictly larger — a card carrying debt. That, plus falling inside the plan's window, identifies
 * exactly the cards a plan is still owed, with no new column and nothing to keep in sync.
 *
 * Reviewing a card rewrites both `lastReviewedAt` and `scheduledIntervalDays` together, so it stops
 * carrying debt the instant it is done. That is what makes the progress bar move.
 */

import type { CardState } from '@/domain'

const DAY_MS = 86_400_000

/**
 * Slack allowed before a gap counts as debt. Redistribute moves a due date within the FSRS fuzz
 * window (±5%) without touching `scheduledIntervalDays`, so a redistributed card must not read as
 * planned; the +1 day absorbs time-of-day and turnover rounding.
 */
export const DEBT_FUZZ = 1.05
export const DEBT_GRACE_DAYS = 1

export interface CatchUpPlanRecord {
  /** YYYY-MM-DD the backlog should be cleared by. */
  targetDate: string
  /** YYYY-MM-DD the plan was created — for display, and to date a stale plan. */
  startedOn:  string
  /** How many cards the plan claimed when it was made. A fact; never recomputed. */
  total:      number
}

/** Keyed by `scopeKey()` from `lib/catchUp.ts`. */
export type CatchUpPlanRecords = Record<string, CatchUpPlanRecord>

/** Which schedule a due date belongs to — each track has its own interval. */
export type TrackKind = 'prod' | 'recall' | 'reverse'

/**
 * The interval that describes ONE track's schedule. Never the row-level `scheduledIntervalDays`
 * without knowing the track: that field is overwritten by whichever track was reviewed LAST, so
 * judging a recall date against a production interval (or vice versa) flags half the library as
 * debt — the bug behind a "3,241 spread earlier" reading when only ~1,500 rows had ever been spread.
 */
function trackOwnInterval(s: CardState, kind: TrackKind): number {
  const fallback = s.scheduledIntervalDays > 0 ? s.scheduledIntervalDays
    : s.intervalDays > 0 ? s.intervalDays : 0
  if (kind === 'prod')   return s.smartIntervalDays ?? s.typedIntervalDays ?? fallback
  /* recall + reverse */ return s.recallIntervalDays ?? fallback
}

/**
 * Whether this track's due date sits further out than its own schedule put it — i.e. it was pushed
 * by a catch-up and has not been reviewed since.
 *
 * A row whose interval cannot be established reads as NOT carrying debt. Claiming a card is the
 * consequential outcome (it becomes re-spreadable), so unprovable must mean unclaimed.
 */
export function isCarryingDebt(s: CardState, dueIso: string | null | undefined, kind: TrackKind): boolean {
  if (!dueIso) return false
  const anchor = s.lastReviewedAt ?? s.graduatedAt
  if (!anchor) return false
  const due = Date.parse(dueIso)
  const from = Date.parse(anchor)
  if (Number.isNaN(due) || Number.isNaN(from)) return false

  const own = trackOwnInterval(s, kind)
  if (own <= 0) return false
  const gapDays = (due - from) / DAY_MS
  return gapDays > own * DEBT_FUZZ + DEBT_GRACE_DAYS
}

/** The due dates this row is scheduled on, each tagged with the track it belongs to. */
export function trackDueDates(s: CardState): Array<{ due: string; kind: TrackKind }> {
  if (s.reviewDirection === 'reverse') {
    const d = s.recallDueAt ?? s.dueAt
    return d ? [{ due: d, kind: 'reverse' }] : []
  }
  const out: Array<{ due: string; kind: TrackKind }> = []
  const prod = s.smartDueAt ?? s.typedDueAt ?? s.dueAt
  if (prod) out.push({ due: prod, kind: 'prod' })
  if (s.recallDueAt) out.push({ due: s.recallDueAt, kind: 'recall' })
  return out
}

/**
 * Whether a plan still owes this row: it is scheduled inside the plan's window and carrying debt.
 *
 * Both halves matter. The window alone would sweep in every normally-arriving review that happens to
 * land in the same fortnight; the debt check alone would count cards pushed by an older, longer plan.
 */
export function isOwedByPlan(
  s: CardState,
  plan: CatchUpPlanRecord,
  today: string,
  tz: string,
): boolean {
  if (!s.graduated || s.dormant) return false
  return trackDueDates(s).some(({ due, kind }) => {
    const day = new Date(due).toLocaleDateString('en-CA', { timeZone: tz })
    return day >= today && day <= plan.targetDate && isCarryingDebt(s, due, kind)
  })
}

export interface PlanProgress {
  total:     number
  remaining: number
  done:      number
  /** 0–1. A plan whose total was 0 reads as complete rather than dividing by zero. */
  fraction:  number
  complete:  boolean
  /** Days left including today; 0 once the target has passed. */
  daysLeft:  number
  /** The target has passed and cards are still owed. */
  overdue:   boolean
}

export function planProgress(plan: CatchUpPlanRecord, remaining: number, today: string): PlanProgress {
  const total = Math.max(0, plan.total)
  // Clamped: a plan can end up owing MORE than it claimed if a card lapses back into the window, and
  // a progress bar that runs backwards past its own start is just confusing.
  const done = Math.max(0, Math.min(total, total - remaining))
  const msLeft = Date.parse(`${plan.targetDate}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)
  const daysLeft = Math.max(0, Math.round(msLeft / DAY_MS))
  return {
    total,
    remaining,
    done,
    fraction: total === 0 ? 1 : done / total,
    complete: remaining === 0,
    daysLeft,
    overdue: daysLeft === 0 && remaining > 0,
  }
}

/**
 * Scope keys whose plans would overlap a new plan on `key`, and so must be replaced by it.
 *
 * A language plan and a card-type plan inside it claim some of the same cards, so letting both stand
 * would double-count every progress bar. Creating either one clears the other.
 */
export function conflictingScopes(key: string, existing: CatchUpPlanRecords): string[] {
  const pair = key.split(':')[0]!
  return Object.keys(existing).filter(k => k !== key && k.split(':')[0] === pair)
}
