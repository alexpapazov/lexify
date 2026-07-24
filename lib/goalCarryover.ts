/**
 * Goal carryover — yesterday's shortfall or surplus adjusts today's goal for a language pair.
 *
 * Deliberately scoped to *yesterday only*: a week away leaves you owing one day, not seven, so the
 * debt can never spiral into a backlog you'd never clear. This adjusts the goal NUMBER only — the
 * card-serving cap (`daily_new_cards`) is untouched, so a raised goal is a target, not permission
 * to be served more new cards.
 */

/**
 * Auto-graduated cards NEVER count toward a daily goal — you didn't learn them that day. Covers both
 * paths: fast-tracked import ('import_known') and bulk "I already knew these" ('bulk_known'). Treats
 * ANY non-'none' mode as auto-graduated, so a future mode is excluded by default rather than silently
 * counting.
 */
export function isAutoGraduated(acceleratedMode: string | null | undefined): boolean {
  return acceleratedMode != null && acceleratedMode !== 'none'
}

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

/**
 * Sum of configured goals for every day in [sinceDate, throughDate] inclusive (local YYYY-MM-DD).
 * `goalForWeekday(0..6)` returns that weekday's configured goal (0 for a rest day). If since > through
 * (e.g. enabled today, measuring through yesterday) the range is empty and this returns 0.
 */
export function plannedGoalSum(
  goalForWeekday: (weekday: number) => number,
  sinceDate: string,
  throughDate: string,
): number {
  const start = new Date(sinceDate + 'T12:00:00Z').getTime()
  const end   = new Date(throughDate + 'T12:00:00Z').getTime()
  let sum = 0
  for (let t = start; t <= end; t += 86_400_000) {
    sum += Math.max(0, goalForWeekday(new Date(t).getUTCDay()))
  }
  return sum
}

/**
 * Full-debt (unbounded) carryover: today's goal absorbs the ENTIRE running deficit/surplus accumulated
 * since the toggle was enabled — not just yesterday. `net = gradsThroughYesterday - plannedThroughYesterday`
 * (>0 surplus, <0 debt). Today's goal = base - net, floored at 0. So a week of shortfalls all pile onto
 * today, and a big study day rolls credit forward across as many future days as it takes to burn off.
 */
export function fullDebtGoal(args: {
  baseGoal: number
  plannedThroughYesterday: number
  gradsThroughYesterday: number
  /** From `fullDebtExemptionAdjustment` — cancels waived days' deficit/credit. */
  exemptionAdjustment?: number
}): GoalCarryover {
  const net  = args.gradsThroughYesterday - args.plannedThroughYesterday + (args.exemptionAdjustment ?? 0)
  const goal = Math.max(0, args.baseGoal - net)
  return { goal, delta: goal - args.baseGoal }
}

/**
 * Per-day exemptions from full-debt carryover, as a correction to add to `grads - planned`.
 *
 * A day in `skipShortfallDays` never contributes a DEFICIT (falling short is forgiven); a day in
 * `skipSurplusDays` never contributes CREDIT (extra study doesn't bank). A day listed in both
 * contributes nothing either way. Days outside [since, through] — or rest days — are ignored.
 *
 * These persist historically on purpose: the checkbox auto-unchecks once the day turns over, but the
 * day you waived stays waived in the cumulative total forever.
 */
export function fullDebtExemptionAdjustment(args: {
  skipShortfallDays: string[]
  skipSurplusDays:   string[]
  goalForDay:  (dateStr: string) => number
  gradsForDay: (dateStr: string) => number
  since:   string
  through: string
}): number {
  const { skipShortfallDays, skipSurplusDays, goalForDay, gradsForDay, since, through } = args
  const days = new Set([...skipShortfallDays, ...skipSurplusDays].filter(d => d >= since && d <= through))
  let adj = 0
  for (const d of days) {
    const goal = Math.max(0, goalForDay(d))
    if (goal <= 0) continue                       // rest day: contributes nothing regardless
    const contribution = gradsForDay(d) - goal
    if (contribution < 0 && skipShortfallDays.includes(d)) adj -= contribution   // cancel the deficit
    if (contribution > 0 && skipSurplusDays.includes(d))   adj -= contribution   // cancel the credit
  }
  return adj
}
