/**
 * lib/catchUpPools.ts — turning due `card_states` rows into the pools a catch-up plan draws from.
 *
 * One pass over the rows produces, per scope, the two lists `planCatchUpSession` needs: what came due
 * TODAY (non-negotiable) and what is OVERDUE (the backlog being drained).
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

export interface ScopePool {
  overdue:  CatchUpCandidate[]
  dueToday: CatchUpCandidate[]
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
  const add = (key: string, bucket: 'overdue' | 'today', c: CatchUpCandidate) => {
    let pool = pools.get(key)
    if (!pool) { pool = { overdue: [], dueToday: [] }; pools.set(key, pool) }
    ;(bucket === 'overdue' ? pool.overdue : pool.dueToday).push(c)
  }

  for (const { pairKey, state } of args.rows) {
    const tracks = args.tracksByPair.get(pairKey)
    const opts = { tracks, tz: args.tz, today: args.today, forwardState: args.forwardByCard.get(state.cardId) }
    const bucket = cardStateDueBucket(state, opts)
    if (!bucket) continue

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
  return { overdue: [], dueToday: [] }
}
