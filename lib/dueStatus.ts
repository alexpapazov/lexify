/**
 * The single source of truth for "is this graduated card due now" — used by every surface that shows
 * a "Due Now" count (Study dashboard, Library language view + folder rollups, deck detail) so they can
 * never disagree again. It mirrors how the SESSION actually serves cards:
 *
 *  - DATE-LEVEL, turnover-aware: due if the due date's local calendar day is today or earlier. A raw
 *    `dueAt <= now` timestamp check is wrong — due dates are snapped to the start of the study day, so
 *    a card due "today" can carry a timestamp still ahead of the wall clock and get missed.
 *  - Reads the REAL per-track columns: production = `smart_due_at ?? typed_due_at ?? due_at`,
 *    recall/reverse = `recall_due_at` (falling back to `due_at` only for legacy reverse rows). Reading
 *    `due_at` alone counts stale legacy dates and misses smart/recall schedules.
 *  - Honours the pair's ENABLED tracks (a ghosted/disabled track never counts) and dormancy.
 *
 * Historically each surface re-implemented this inline and they drifted apart (deck detail read only
 * `due_at` date-level with no track filter → 7; the Library read `due_at <= now` → 0; the dashboard was
 * correct). Route everything through here instead.
 */

import type { CardState } from '@/domain'
import type { EnabledTracks } from './sessionLimits'
import { trackEnabled } from './sessionLimits'

/** Due if the date's local calendar day (in `tz`) is `today` (turnover-adjusted YYYY-MM-DD) or earlier. */
export function isDueByLocalDate(dateStr: string | null | undefined, tz: string, today: string): boolean {
  return !!dateStr && new Date(dateStr).toLocaleDateString('en-CA', { timeZone: tz }) <= today
}

/**
 * Whether a `card_states` row is due now. `forwardState` is the row's FORWARD counterpart — required
 * for reverse rows, whose graduation and whole-card dormancy live on the forward side. `tracks`
 * undefined = the pair's defaults (typed/recall/reverse on, smart off).
 */
/**
 * Every due date this row can actually be served on, after track-enablement and dormancy gating.
 *
 * Extracted so `isCardStateDueNow` and `cardStateDueBucket` can never disagree about what "due" means
 * — this file exists because five surfaces each had their own copy of this and they drifted.
 */
function activeDueDates(
  s: CardState,
  opts: { tracks?: EnabledTracks; forwardState?: CardState | null },
): string[] {
  const { tracks } = opts
  const dates: (string | null | undefined)[] = []

  if (s.reviewDirection === 'reverse') {
    // Dormancy is PER-DIRECTION: recognition is gated on the REVERSE row's own `dormant` only. The
    // forward row's dormancy is deliberately NOT checked here — pausing production must not force
    // recognition off, or "Resume recognition" on a dormant card would be a no-op. (The forward
    // GRADUATED check stays: a card can't be recognised before it has graduated.)
    if (trackEnabled(tracks, 'recall', true) && opts.forwardState?.graduated === true && !s.dormant) {
      dates.push(s.recallDueAt ?? s.dueAt)
    }
    return dates.filter((d): d is string => !!d)
  }

  // Production is a single lane (typed/smart mutually exclusive); visible if EITHER is enabled.
  const prodEnabled = trackEnabled(tracks, 'typed', false) || trackEnabled(tracks, 'smart', false)
  if (!s.dormant && prodEnabled) dates.push(s.smartDueAt ?? s.typedDueAt ?? s.dueAt)
  if (!s.dormant && trackEnabled(tracks, 'recall', false)) dates.push(s.recallDueAt)
  return dates.filter((d): d is string => !!d)
}

/**
 * Whether a `card_states` row is due now. `forwardState` is the row's FORWARD counterpart — required
 * for reverse rows, whose graduation and whole-card dormancy live on the forward side. `tracks`
 * undefined = the pair's defaults (typed/recall/reverse on, smart off).
 */
export function isCardStateDueNow(
  s: CardState,
  opts: { tracks?: EnabledTracks; tz: string; today: string; forwardState?: CardState | null },
): boolean {
  if (!s.graduated) return false
  return activeDueDates(s, opts).some(d => isDueByLocalDate(d, opts.tz, opts.today))
}

/** `'overdue'` = due before today, `'today'` = due today, `null` = not due. */
export type DueBucket = 'overdue' | 'today' | null

/**
 * Which side of today a due row falls on — the split a catch-up plan is built from
 * (`lib/catchUp.ts`): cards due TODAY are non-negotiable, everything older is the backlog being
 * drained. A row with one track overdue and another due today counts as overdue, since it is the
 * older debt that decides how far behind you are.
 */
export function cardStateDueBucket(
  s: CardState,
  opts: { tracks?: EnabledTracks; tz: string; today: string; forwardState?: CardState | null },
): DueBucket {
  if (!s.graduated) return null
  const days = activeDueDates(s, opts)
    .map(d => new Date(d).toLocaleDateString('en-CA', { timeZone: opts.tz }))
    .filter(d => d <= opts.today)
  if (days.length === 0) return null
  return days.some(d => d < opts.today) ? 'overdue' : 'today'
}

/** How many days late a due row is (0 when it came due today). Feeds the FSRS decay estimate. */
export function daysOverdue(
  s: CardState,
  opts: { tracks?: EnabledTracks; tz: string; today: string; forwardState?: CardState | null },
): number {
  const days = activeDueDates(s, opts)
    .map(d => new Date(d).toLocaleDateString('en-CA', { timeZone: opts.tz }))
    .filter(d => d <= opts.today)
  if (days.length === 0) return 0
  const earliest = days.reduce((a, b) => (a < b ? a : b))
  return Math.max(0, Math.round(
    (Date.parse(`${opts.today}T00:00:00.000Z`) - Date.parse(`${earliest}T00:00:00.000Z`)) / 86_400_000,
  ))
}
