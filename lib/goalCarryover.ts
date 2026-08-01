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

/**
 * A day's goal can never exceed this multiple of that day's CONFIGURED goal, however much carryover
 * debt has piled up — an 8/day pair tops out at 20, not 33. Carryover is meant to keep you honest,
 * not to hand you an unclearable wall.
 *
 * The excess is NOT forgiven. Debt is derived from history (`plannedGoalSum` sums the CONFIGURED
 * goals, never the capped ones), so whatever the cap withholds is still owed and simply reappears in
 * tomorrow's total — where it is capped again. An 8/day pair carrying 25 owed therefore drains
 * 20 → 20 → 9 → 8, exactly as if the overflow had been queued forward. Do NOT "fix" this by capping
 * `plannedGoalSum` too; that would delete the debt instead of deferring it.
 */
export const MAX_GOAL_MULTIPLE = 2.5

/**
 * Clamps a carryover-adjusted goal to `MAX_GOAL_MULTIPLE ×` the base. Floors, so the result is never
 * strictly above the multiple (a base of 5 caps at 12, not 13). A base of 0 (rest day) caps at 0 —
 * a rest day stays a rest day and pushes its share of the debt forward.
 */
export function capGoal(goal: number, baseGoal: number): number {
  return Math.min(goal, Math.max(0, Math.floor(Math.max(0, baseGoal) * MAX_GOAL_MULTIPLE)))
}

type GoalCarryover = {
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

  // Floor at 0 — a big surplus can fully cover today, but the goal can't go negative — and ceiling
  // at MAX_GOAL_MULTIPLE × base so a big shortfall can't produce an unclearable day.
  const goal = capGoal(Math.max(0, baseGoal + delta), baseGoal)
  // Report the delta actually applied, not the raw one, so the UI never claims a -50 credit
  // against a goal of 20 when only -20 of it could land.
  return { goal, delta: goal - baseGoal }
}

/**
 * Sum of the goal OWED on every day in [sinceDate, throughDate] inclusive (local YYYY-MM-DD).
 * `goalForDay(dateStr)` returns that day's owed goal (0 for a rest day; deferral-adjusted — see
 * `owedGoalForDate`). If since > through (e.g. enabled today, measuring through yesterday) the range is
 * empty and this returns 0.
 */
export function plannedGoalSum(
  goalForDay: (dateStr: string) => number,
  sinceDate: string,
  throughDate: string,
): number {
  const start = new Date(sinceDate + 'T12:00:00Z').getTime()
  const end   = new Date(throughDate + 'T12:00:00Z').getTime()
  let sum = 0
  for (let t = start; t <= end; t += 86_400_000) {
    sum += Math.max(0, goalForDay(new Date(t).toISOString().slice(0, 10)))
  }
  return sum
}

/**
 * The goal actually OWED on a date, after "move to tomorrow" deferrals.
 *   owed(D) = (D deferred ? 0 : configured(D)) + (D-1 deferred ? configured(D-1) : 0)
 * i.e. a deferred day owes nothing and hands its goal to the next day. Threading this single function
 * through the base goal AND the carryover history keeps every mode consistent — the deferred amount just
 * shifts one day within the running total, never doubled or lost.
 */
export function owedGoalForDate(
  date: string,
  configuredForWeekday: (weekday: number) => number,
  isDeferred: (dateStr: string) => boolean,
): number {
  const wd = (d: string) => new Date(d + 'T12:00:00Z').getUTCDay()
  const prev = new Date(new Date(date + 'T12:00:00Z').getTime() - 86_400_000).toISOString().slice(0, 10)
  const todayPart = isDeferred(date) ? 0 : Math.max(0, configuredForWeekday(wd(date)))
  const carriedIn = isDeferred(prev) ? Math.max(0, configuredForWeekday(wd(prev))) : 0
  return todayPart + carriedIn
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
  // Capped at MAX_GOAL_MULTIPLE × base. The withheld remainder stays in the running deficit (this
  // function is stateless — `net` is recomputed from history each day), so it rolls to tomorrow.
  const goal = capGoal(Math.max(0, args.baseGoal - net), args.baseGoal)
  return { goal, delta: goal - args.baseGoal }
}

/**
 * Where a language's full-debt sum should start, given the profile-wide enable date and any
 * per-language reset (migration 109).
 *
 * The LATER of the two wins. The debt is derived from history rather than stored, so "reset this
 * language" can only mean "start counting from today" — and taking the max means a global reset still
 * overrides a stale per-pair entry, and neither can resurrect a balance the other cleared.
 *
 * Returns null when full debt was never enabled, which callers treat as "not in full-debt mode".
 */
export function effectiveDebtSince(
  globalSince: string | null,
  resets: Record<string, string> | null | undefined,
  pairKey: string,
): string | null {
  if (!globalSince) return null
  const perPair = resets?.[pairKey]
  return perPair && perPair > globalSince ? perPair : globalSince
}

/**
 * The running balance since full debt was switched on: how far ahead or behind you are RIGHT NOW,
 * counting today.
 *
 * `standing = (everything graduated since the enable date) − (everything owed over the same span)`,
 * where "owed" includes today's configured goal. So it reads as the answer to "how many cards would I
 * need to have done by now to be level": negative = that many owed, positive = that many banked.
 *
 * Deliberately counts TODAY on both sides. A balance through yesterday alone would sit at a flattering
 * number all day and then lurch at turnover; including today means it starts each morning down by
 * today's goal and climbs to zero as you study, which is what "on track" actually means.
 *
 * Same `exemptionAdjustment` convention as `fullDebtGoal` — waived days cancel out of the total — and
 * the same statelessness: this is recomputed from history, never stored, so the 2.5× display cap on a
 * single day's goal never truncates the real balance.
 */
export function goalStanding(args: {
  plannedThroughYesterday: number
  gradsThroughYesterday:   number
  todayGoal:               number
  todayGrads:              number
  exemptionAdjustment?:    number
}): number {
  const planned = args.plannedThroughYesterday + Math.max(0, args.todayGoal)
  const grads   = args.gradsThroughYesterday + args.todayGrads
  return grads - planned + (args.exemptionAdjustment ?? 0)
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
