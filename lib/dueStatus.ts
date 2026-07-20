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
export function isCardStateDueNow(
  s: CardState,
  opts: { tracks?: EnabledTracks; tz: string; today: string; forwardState?: CardState | null },
): boolean {
  if (!s.graduated) return false
  const { tracks, tz, today } = opts
  const due = (d: string | null | undefined) => isDueByLocalDate(d, tz, today)

  if (s.reviewDirection === 'reverse') {
    const fwd = opts.forwardState
    // `!s.dormant` = the reverse row's own (recognition) dormancy; the forward dormant check = whole-card.
    return trackEnabled(tracks, 'recall', true) &&
      fwd?.graduated === true && !fwd?.dormant && !s.dormant &&
      due(s.recallDueAt ?? s.dueAt)
  }

  // Production is a single lane (typed/smart mutually exclusive); visible if EITHER is enabled.
  const prodEnabled = trackEnabled(tracks, 'typed', false) || trackEnabled(tracks, 'smart', false)
  const prodDue = !s.dormant && prodEnabled &&
    (s.smartDueAt ? due(s.smartDueAt) : s.typedDueAt ? due(s.typedDueAt) : due(s.dueAt))
  const recallDue = !s.dormant && trackEnabled(tracks, 'recall', false) && due(s.recallDueAt)
  return prodDue || recallDue
}
