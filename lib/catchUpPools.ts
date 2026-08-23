/**
 * lib/catchUpPools.ts — turning due `card_states` rows into the per-scope backlogs a catch-up
 * spreads, and the write patch that moves them.
 *
 * One pass over the rows produces, per scope, the OVERDUE list — the backlog `assignBacklogDays`
 * deals out. Cards merely due TODAY are deliberately not collected: they are today's legitimate
 * work, and a spread must never push them into the future (`cardStateDueBucket` is what tells the
 * two apart).
 *
 * Every row is filed under BOTH its language key (`"bg|en"`) and its type key (`"bg|en:typing"`), so a
 * language-level plan and a type-level plan each find a pool without a second pass. The type split is
 * the same one the "Study all due" popover already shows — deliberately, so the number a plan quotes
 * matches the bucket you clicked to create it.
 *
 * Due-ness comes from `lib/dueStatus.ts`, never from the forecast simulation. Those two disagree by a
 * handful of rows (the forecast counts projected reviews, the status helper counts what the session
 * will actually serve), and a quota that doesn't match the button is a bug report waiting to happen.
 */

import type { CardState } from '@/domain'
import { cardStateDueBucket, daysOverdue, isDueByLocalDate } from '@/lib/dueStatus'
import { scopeKey, elapsedDaysFor, type CatchUpCandidate, type CatchUpType } from '@/lib/catchUp'
import { activeProductionTrack, forwardProductionMode, trackEnabled, type EnabledTracks } from '@/lib/sessionLimits'
import { seedStability } from '@/lib/forecastFsrs'
import { isCarryingDebt, trackDueDates } from '@/lib/catchUpPlan'

export interface ScopePool {
  overdue: CatchUpCandidate[]
  /**
   * Rows scheduled today or later that are CARRYING CATCH-UP DEBT (`isCarryingDebt`) — cards an
   * earlier spread placed, still unreviewed. A fresh spread may reclaim these (it supersedes the
   * earlier plan for its scope), which is also the repair path when a bad spread piled cards onto
   * one day. Normally-scheduled future cards never appear here.
   */
  plannedDebt: CatchUpCandidate[]
}

/** Identity for a queue item. A card's forward and reverse rows are separate reviews. */
export function candidateKey(s: CardState): string {
  return `${s.cardId}:${s.reviewDirection}`
}

/**
 * Which of the popover's three buckets a due row belongs to. Mirrors the dashboard: the ACTIVE
 * production lane decides presentation, not whichever date column happens to be populated — a legacy
 * card scheduled on `due_at` is classified the way the session will actually present it.
 */
export function catchUpTypeOf(
  s: CardState,
  opts: { tracks?: EnabledTracks; threshold: number; tz: string; today: string },
): CatchUpType {
  if (s.reviewDirection === 'reverse') return 'sgReverse'
  const { tracks, tz, today } = opts
  const prodEnabled = trackEnabled(tracks, 'typed', false) || trackEnabled(tracks, 'smart', false)
  const prodDue = !s.dormant && prodEnabled &&
    isDueByLocalDate(s.smartDueAt ?? s.typedDueAt ?? s.dueAt, tz, today)
  const prodTrack = activeProductionTrack(tracks)
  if (prodTrack && prodDue && forwardProductionMode(s, prodTrack, opts.threshold) === 'typed') return 'typing'
  return 'sgForward'
}

/** The interval that describes this row's schedule, per direction. */
function trackInterval(s: CardState): number | null {
  if (s.reviewDirection === 'reverse') return s.recallIntervalDays ?? s.intervalDays
  return s.smartIntervalDays ?? s.typedIntervalDays ?? s.intervalDays
}

/**
 * One due row as a ranking candidate. Shared by the dashboard (which builds whole pools) and the
 * session (which describes the queue it already built), so the two can't measure decay differently.
 */
export function candidateFor(
  s: CardState,
  opts: {
    tracks?: EnabledTracks
    tz: string
    today: string
    forwardState?: CardState | null
    retention: number
    now: number
  },
): CatchUpCandidate {
  const interval = trackInterval(s)
  return {
    key: candidateKey(s),
    elapsedDays: elapsedDaysFor({
      lastReviewedAt: s.lastReviewedAt,
      intervalDays:   interval,
      daysOverdue:    daysOverdue(s, opts),
      now:            opts.now,
    }),
    stability: seedStability(s.stability, interval ?? 1, opts.retention),
  }
}

export function buildCatchUpPools(args: {
  rows:            Array<{ pairKey: string; state: CardState }>
  /** Forward counterpart per cardId — reverse rows gate on it for graduation. */
  forwardByCard:   Map<string, CardState>
  tracksByPair:    Map<string, EnabledTracks>
  thresholdByPair: Map<string, number>
  /** Target retention per pair, for seeding stability on rows that have none stored. */
  retentionByPair: Map<string, number>
  tz:              string
  today:           string
  now:             number
}): Map<string, ScopePool> {
  const pools = new Map<string, ScopePool>()
  const add = (key: string, bucket: 'overdue' | 'plannedDebt', c: CatchUpCandidate) => {
    let pool = pools.get(key)
    if (!pool) { pool = { overdue: [], plannedDebt: [] }; pools.set(key, pool) }
    pool[bucket].push(c)
  }

  for (const { pairKey, state } of args.rows) {
    const tracks = args.tracksByPair.get(pairKey)
    const opts = { tracks, tz: args.tz, today: args.today, forwardState: args.forwardByCard.get(state.cardId) }
    // Two ways in: strictly overdue (the backlog), or scheduled today-or-later while still carrying
    // an earlier spread's debt (reclaimable). A normally-scheduled card — including one genuinely
    // due today — is neither: that is real work, not backlog, and must never be spread.
    let bucket: 'overdue' | 'plannedDebt'
    if (cardStateDueBucket(state, opts) === 'overdue') bucket = 'overdue'
    else if (state.graduated && !state.dormant &&
             trackDueDates(state).some(d => isCarryingDebt(state, d))) bucket = 'plannedDebt'
    else continue

    const candidate = candidateFor(state, {
      ...opts, retention: args.retentionByPair.get(pairKey) ?? 0.9, now: args.now,
    })

    const type = catchUpTypeOf(state, {
      tracks, threshold: args.thresholdByPair.get(pairKey) ?? 20, tz: args.tz, today: args.today,
    })
    add(pairKey, bucket, candidate)
    add(scopeKey(pairKey, type), bucket, candidate)
  }
  return pools
}

/**
 * A fresh empty pool, so callers can read a scope with no due cards without a null check. A function
 * rather than a shared constant: one exported object would be handed to every such read at once, and
 * a single stray push would leak one scope's cards into all the others.
 */
export function emptyPool(): ScopePool {
  return { overdue: [], plannedDebt: [] }
}

/**
 * The patch that moves a row's OVERDUE tracks onto `newDay`, keeping each column's time-of-day (due
 * dates are snapped to the start of the study day, so the time part carries the turnover offset).
 *
 * Only overdue tracks move. A card whose production is three weeks late but whose recognition is due
 * next month must keep that recognition date — rewriting a FUTURE due date would genuinely change an
 * interval the scheduler chose, which spreading a backlog has no business doing.
 *
 * Moving a PAST due date changes nothing about the memory model: FSRS measures elapsed time from
 * `lastReviewedAt`, never from `dueAt` (see `engine/dueNow.ts`), so difficulty and stability are
 * untouched and the review, whenever it lands, is scored exactly as it would have been.
 *
 * Returns null when the row has nothing overdue to move.
 */
export function rescheduleOverdueTracks(
  s: CardState,
  newDay: string,
  opts: {
    tracks?: EnabledTracks
    tz: string
    today: string
    forwardState?: CardState | null
    /**
     * Reassign mode. When set, a track already scheduled on or before this date may ALSO move —
     * but only if the row is carrying catch-up debt, i.e. an earlier plan is what put it there.
     *
     * The debt check is deliberately inside this function rather than left to the caller: it is the
     * guarantee that "unplanned cards stay unchanged", and a guarantee a caller has to remember is
     * not a guarantee. Without it, re-levelling would drag every normally-scheduled review that
     * happens to fall in the window along with it.
     */
    replanThrough?: string
  },
): Partial<CardState> | null {
  const { tracks, tz, today } = opts
  const dayOf = (d: string) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz })
  const movable = (d: string | null | undefined) => {
    if (!d) return false
    const day = dayOf(d)
    if (day < today) return true                                  // overdue: always claimable
    if (!opts.replanThrough || day > opts.replanThrough) return false
    return isCarryingDebt(s, d)                                   // in-window, but only if planned
  }
  const overdue = movable
  /** Keep the original time-of-day; only the calendar day moves. */
  const shift = (iso: string) => newDay + iso.slice(10)

  const patch: Partial<CardState> = {}

  if (s.reviewDirection === 'reverse') {
    if (!trackEnabled(tracks, 'recall', true) || s.dormant) return null
    if (opts.forwardState?.graduated !== true) return null
    const ref = s.recallDueAt ?? s.dueAt
    if (!overdue(ref)) return null
    patch.recallDueAt = shift(ref!)
    // A legacy reverse row scheduled on due_at: move both, or the stale column keeps reading as due
    // for anything that falls back to it.
    if (!s.recallDueAt && s.dueAt) patch.dueAt = shift(s.dueAt)
    return patch
  }

  if (s.dormant) return null

  const prodEnabled = trackEnabled(tracks, 'typed', false) || trackEnabled(tracks, 'smart', false)
  const prodRef = s.smartDueAt ?? s.typedDueAt ?? s.dueAt
  if (prodEnabled && overdue(prodRef)) {
    const moved = shift(prodRef!)
    // Write whichever lane actually holds the schedule, and keep due_at in step — queue building
    // reads the lane column, several counts still read due_at.
    if (s.smartDueAt) patch.smartDueAt = moved
    else if (s.typedDueAt) patch.typedDueAt = moved
    patch.dueAt = moved
  }
  if (trackEnabled(tracks, 'recall', false) && overdue(s.recallDueAt)) {
    patch.recallDueAt = shift(s.recallDueAt!)
  }
  return Object.keys(patch).length > 0 ? patch : null
}
