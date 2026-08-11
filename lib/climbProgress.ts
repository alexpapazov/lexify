/**
 * lib/climbProgress.ts — is this card IN the learning pipeline, judging by its climb row alone?
 *
 * The climb row's `state` column is opaque JSON holding either a ladder `ClimbState` (`rungIndex`,
 * `rungHistory`) or a pathway `RouteState` (`stateId`, `history`) — so anything classifying cards as
 * Learning has to read both shapes. The old inline check read only `rungIndex >= 1`, which had two
 * consequences the user hit:
 *
 *   1. A PATHWAY card was never "Learning" (no `rungIndex` on a RouteState, and pre-graduation there
 *      is no card_state row to fall back on) — it stayed "New" however far it had advanced.
 *   2. A ladder card DROPPED BACK to rung 0 read "New" again, even though its history records the
 *      whole journey. Once a card has left the first state at least once it has been studied, and
 *      falling back is part of studying — it must stay "Learning".
 *
 * The rule here: **a card is in progress once it has ever left its starting position**, read from the
 * HISTORY (which survives drop-backs), with the live position as a fallback for climbs saved before
 * the history fields existed.
 */

/** Loosely-shaped climb state — a ladder ClimbState or a pathway RouteState, straight from JSONB. */
type AnyClimb = {
  graduated?: boolean
  rungIndex?: number
  rungHistory?: unknown[]
  history?: unknown[]
}

export function climbInProgress(cl: unknown): boolean {
  if (!cl || typeof cl !== 'object') return false
  const c = cl as AnyClimb
  if (c.graduated) return false
  // Ladder: past the first rung now, or EVER past it — `rungHistory` keeps every rung visited, so a
  // drop-back to rung 0 still shows the trip ([0,1,0]). Climbs saved before rungHistory existed
  // (pre 2026-07-17) fall back to the live rungIndex, which just can't see drop-backs to 0.
  if (typeof c.rungIndex === 'number') {
    return c.rungIndex >= 1 || (Array.isArray(c.rungHistory) && c.rungHistory.length > 1)
  }
  // Pathway: `history` starts as [startStateId] and appends on every fired transition — including
  // one pointing BACK to the start — so length > 1 means "has moved at least once".
  if (Array.isArray(c.history)) return c.history.length > 1
  return false
}
