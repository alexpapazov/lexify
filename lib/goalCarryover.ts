/**
 * Goal carryover — yesterday's shortfall or surplus adjusts today's goal for a language pair.
 *
 * Deliberately scoped to *yesterday only*: a week away leaves you owing one day, not seven, so the
 * debt can never spiral into a backlog you'd never clear. This adjusts the goal NUMBER only — the
 * card-serving cap (`daily_new_cards`) is untouched, so a raised goal is a target, not permission
 * to be served more new cards.
 */

export type GoalCarryover = {
  /** The goal to show and measure against today. Never negative. */
  goal: number
  /** Signed adjustment applied to the base goal: +n carried debt, -n carried credit, 0 none. */
  delta: number
}

export function carriedGoal(args: {
  /** Today's configured goal for this pair (from `language_pairs.goals[weekday]`). */
  baseGoal: number
  /** Yesterday's configured goal, or null if yesterday was a rest day / had no goal. */
  yesterdayGoal: number | null
  /** Words actually graduated yesterday for this pair. */
  yesterdayCount: number
  carryShortfall: boolean
  carrySurplus: boolean
}): GoalCarryover {
  const { baseGoal, yesterdayGoal, yesterdayCount, carryShortfall, carrySurplus } = args

  // A rest day neither earns credit nor incurs debt — there was no target to miss or beat.
  if (yesterdayGoal === null || yesterdayGoal <= 0) return { goal: baseGoal, delta: 0 }

  const diff = yesterdayCount - yesterdayGoal  // >0 surplus, <0 shortfall

  let delta = 0
  if (diff < 0 && carryShortfall) delta = -diff      // owed: raise today's goal
  else if (diff > 0 && carrySurplus) delta = -diff   // credit: lower today's goal

  // Floor at 0 — a big surplus can fully cover today, but the goal can't go negative.
  const goal = Math.max(0, baseGoal + delta)
  // Report the delta actually applied, not the raw one, so the UI never claims a -50 credit
  // against a goal of 20 when only -20 of it could land.
  return { goal, delta: goal - baseGoal }
}
