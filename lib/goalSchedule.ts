/**
 * lib/goalSchedule.ts — deadline-driven goal scheduling (migration 114).
 *
 * The weekday goals in `language_pairs.goals` answer "how many words a day do I want to do".
 * A SCHEDULE answers the opposite question — "I want N words by date D, so what do I owe today?" —
 * and derives the daily number from the deadline instead of the other way round.
 *
 * ── The one rule everything else falls out of ────────────────────────────────
 * Today's goal is RE-DERIVED every morning from (words still to go ÷ capacity still available).
 * It is never stored, never accumulated. Miss a day and the remaining words don't change while the
 * remaining days do, so tomorrow's number rises on its own — 100 words in 20 days is 5/day, and after
 * a missed day it is 100 in 19, i.e. 6/day. That IS the make-up mechanism; there is no debt ledger.
 *
 * This is the same statelessness `lib/goalCarryover.ts` depends on, and for the same reason: a number
 * recomputed from history can never drift out of step with it. Do not "optimise" this into a stored
 * running total.
 *
 * ── Consequences worth knowing before you change anything ────────────────────
 * • **Schedule mode SUPERSEDES the carryover modes for that language.** Never stack them. The
 *   re-derived goal has already absorbed the miss; running full-debt on top would charge for it a
 *   second time. (Same relationship full debt already has to the two yesterday-only toggles.)
 * • **Per-day limits are CAPS, not weights.** The load is spread by water-filling, not in proportion
 *   to capacity: given an even split of 2/day, a Friday limited to 3 gets 2, not a proportional share
 *   of everything. Days at 0 (days off) drop out of the split entirely.
 * • **The tightest active segment wins.** Each checkpoint, plus the final deadline, is its own
 *   window; today's goal is the largest demand among them. A missed checkpoint therefore raises the
 *   next window's number automatically, because checkpoint counts are CUMULATIVE.
 * • **`dailyCeiling` bounds the number, so an impossible schedule stays impossible** rather than
 *   quietly printing 40/day. That's the point of `feasible`/`remedies` — see `scheduleRemedies`.
 * • **A schedule need not have a target at all.** `targetCount === null` is a PATTERN schedule —
 *   "8 a day, none on Sundays", open-ended. Each day's goal is simply that day's capacity. It keeps
 *   days off, per-date caps and its place on the combined calendar; what it doesn't have is a finish
 *   line, so pace, feasibility and re-spreading are all inapplicable and report neutral values.
 */

import type { GoalSchedule, GoalScheduleCheckpoint } from '@/domain'

const DAY_MS = 86_400_000

/**
 * All date maths anchors at NOON UTC, matching `lib/goalCarryover.ts`. Midnight anchoring lands on
 * the DST boundary in half the world's zones and silently skips or repeats a day over a long span.
 */
const noon = (date: string): number => new Date(date + 'T12:00:00Z').getTime()
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** `date` shifted by `n` days (negative goes back), as local YYYY-MM-DD. */
export function addScheduleDays(date: string, n: number): string {
  return isoOf(noon(date) + n * DAY_MS)
}

/** JS day-of-week (0 = Sunday) for a YYYY-MM-DD string. */
export function weekdayOfDate(date: string): number {
  return new Date(noon(date)).getUTCDay()
}

/** Inclusive day count between two dates. `from` after `to` yields 0, not a negative. */
export function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((noon(to) - noon(from)) / DAY_MS) + 1)
}

/**
 * A schedule may not span more than this. Purely a guard against a mistyped year turning every
 * preview into a multi-million-iteration loop that freezes the settings page.
 */
export const MAX_SCHEDULE_DAYS = 1830   // ~5 years

/**
 * How far ahead an OPEN-ENDED (deadline-less) pattern schedule is drawn. It has no finish line, so
 * something has to bound the calendar and the plan; six months is enough to plan around without
 * rendering a decade of identical weeks.
 */
export const PATTERN_HORIZON_DAYS = 180

/** True for a schedule with no finish line — see the header. */
export function isPatternSchedule(schedule: GoalSchedule): boolean {
  return schedule.targetCount == null
}

/** The last date a schedule plans for: its deadline, or a rolling horizon when open-ended. */
export function planEnd(schedule: GoalSchedule, today: string): string {
  if (schedule.deadline) return schedule.deadline
  const from = today > schedule.startDate ? today : schedule.startDate
  return addScheduleDays(from, PATTERN_HORIZON_DAYS)
}

/** Every date in [from, to] inclusive, bounded by `MAX_SCHEDULE_DAYS`. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = []
  const end = noon(to)
  let t = noon(from)
  for (let i = 0; t <= end && i < MAX_SCHEDULE_DAYS; i++, t += DAY_MS) out.push(isoOf(t))
  return out
}

// ─── Capacity ─────────────────────────────────────────────────────────────────

/**
 * How many words this schedule allows on one date.
 *
 * Precedence, most specific first:
 *   1. A `dateExceptions` entry for exactly that date — wins OUTRIGHT, including over `dailyCeiling`.
 *      That's deliberate: it's how you say "I have a free Saturday, I'll do 30" on a 10/day schedule,
 *      as well as "I'm away on the 12th" (0).
 *   2. That weekday's `weekdayLimits` entry, clamped by `dailyCeiling`.
 *   3. `dailyCeiling` alone.
 *
 * Returns `Infinity` when nothing caps the day (no ceiling, no limit) — the water-fill and the
 * feasibility check both handle that correctly, and it keeps "I haven't set a ceiling yet" from
 * reading as "I can do zero".
 *
 * Dates outside [startDate, deadline] have capacity 0: a schedule can't demand work before it begins
 * or after it's over.
 */
export function dayCapacity(schedule: GoalSchedule, date: string): number {
  if (date < schedule.startDate) return 0
  if (schedule.deadline && date > schedule.deadline) return 0

  const exception = schedule.dateExceptions?.[date]
  if (exception != null) return Math.max(0, exception)

  const ceiling = schedule.dailyCeiling == null ? Infinity : Math.max(0, schedule.dailyCeiling)
  const limit = schedule.weekdayLimits?.[String(weekdayOfDate(date))]
  if (limit == null) return ceiling
  return Math.min(ceiling, Math.max(0, limit))
}

/**
 * A PATTERN schedule's planned words for one date — the number the day actually asks for.
 *
 * Daily framing (no `weeklyTarget`): identical to `dayCapacity` — the weekday number, clamped by the
 * ceiling, with date exceptions winning outright.
 *
 * Weekly framing: `weeklyTarget` is water-filled across that Monday-week's capacities, so days off
 * take nothing and the rest split evenly — the same cap-not-weight rule as everywhere else. The
 * spread is per-week deterministic: every week asks for the same total, shaped by that week's days.
 */
export function patternPlanForDate(schedule: GoalSchedule, date: string): number {
  if (schedule.weeklyTarget == null) {
    const cap = dayCapacity(schedule, date)
    return isFinite(cap) ? cap : 0
  }
  // Monday of the week containing `date` (JS getDay: 0 = Sunday → Monday-first column index).
  const monday = addScheduleDays(date, -((weekdayOfDate(date) + 6) % 7))
  const week = eachDate(monday, addScheduleDays(monday, 6))
  const caps = week.map(d => dayCapacity(schedule, d))
  const { values } = waterFill(schedule.weeklyTarget, caps)
  const whole = distributeIntegers(values, caps)
  return whole[week.indexOf(date)] ?? 0
}

/**
 * Where a schedule's PROGRESS window starts. For a pattern schedule with debt on, the Reset button
 * moves it forward (`debtResetAt`) — the balance is derived from planned-vs-done since this date, so
 * "reset the debt" can only mean "start counting from today", exactly like the full-debt resets.
 */
export function progressStart(schedule: GoalSchedule): string {
  const usesDebt = schedule.targetCount == null && (schedule.debtCarryMissed || schedule.debtCarryExtra)
  if (usesDebt && schedule.debtResetAt && schedule.debtResetAt > schedule.startDate) return schedule.debtResetAt
  return schedule.startDate
}

/** Capacity for each date in [from, to], and their total. `Infinity` propagates to the total. */
export function capacityWindow(schedule: GoalSchedule, from: string, to: string): { dates: string[]; caps: number[]; total: number } {
  const dates = eachDate(from, to)
  const caps = dates.map(d => dayCapacity(schedule, d))
  return { dates, caps, total: caps.reduce((a, b) => a + b, 0) }
}

// ─── Spreading the load ───────────────────────────────────────────────────────

/**
 * Water-filling: split `remaining` as evenly as possible across days, except that no day may exceed
 * its capacity — the overflow from a capped day redistributes across the days that still have room.
 *
 * Why not simply `remaining × cap(d) / Σcap`: that treats a limit as a WEIGHT, so a Friday capped at
 * 3 would be handed 3/43 of the total even when the even split is only 2. A limit is a ceiling on a
 * day, not a statement about how much of the work belongs to it.
 *
 * Returns fractional values (the caller rounds — see `scheduleGoalToday` and `schedulePlan`) and a
 * `shortfall` for whatever could not be placed because every day hit its cap. Days of capacity 0
 * always receive 0.
 */
export function waterFill(remaining: number, caps: number[]): { values: number[]; shortfall: number } {
  const capAt = (i: number) => caps[i] ?? 0
  const values: number[] = new Array(caps.length).fill(0)
  let rem = Math.max(0, remaining)
  let active = caps.map((_, i) => i).filter(i => capAt(i) > 0)

  while (active.length > 0 && rem > 0) {
    const share = rem / active.length
    // Days that can't absorb an even share are pinned at their cap; the rest re-split what's left.
    const pinned = active.filter(i => capAt(i) < share)
    if (pinned.length === 0) {
      for (const i of active) values[i] = share
      rem = 0
      break
    }
    for (const i of pinned) {
      values[i] = capAt(i)
      rem -= capAt(i)
    }
    const pinnedSet = new Set(pinned)
    active = active.filter(i => !pinnedSet.has(i))
  }

  return { values, shortfall: Math.max(0, rem) }
}

/**
 * Rounds a fractional per-day split to whole words while keeping the total exact (largest-remainder,
 * i.e. Hamilton apportionment). Used for the multi-day PREVIEW only — today's own number is ceiled
 * instead (see `scheduleGoalToday`), because a plan that rounds today down quietly misses the
 * deadline by a word.
 */
export function distributeIntegers(values: number[], caps: number[]): number[] {
  const floors = values.map(v => Math.floor(v))
  const target = Math.round(values.reduce((a, b) => a + b, 0))
  let deficit = target - floors.reduce((a, b) => a + b, 0)

  // Hand the rounding remainder to the largest fractional parts first, skipping any day that is
  // already at its cap — otherwise rounding could push a day past a limit the user set explicitly.
  const order = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)

  for (const { i } of order) {
    if (deficit <= 0) break
    if ((floors[i] ?? 0) + 1 > (caps[i] ?? 0)) continue
    floors[i] = (floors[i] ?? 0) + 1
    deficit -= 1
  }
  return floors
}

// ─── Segments (checkpoints + the deadline) ────────────────────────────────────

/**
 * The still-binding targets, soonest first: every checkpoint dated today or later, then the deadline
 * itself. Checkpoint counts are CUMULATIVE (measured in the same units as `targetCount`), which is
 * what makes a missed checkpoint self-correcting — it simply drops out of the list and its words stay
 * inside the next window's `remaining`.
 *
 * Checkpoints beyond the deadline, or above the final target, are ignored rather than treated as
 * binding; `validateSchedule` reports them so they can be fixed rather than silently obeyed.
 */
export function activeSegments(schedule: GoalSchedule, today: string): GoalScheduleCheckpoint[] {
  const target = schedule.targetCount
  const deadline = schedule.deadline
  const checkpoints = (schedule.checkpoints ?? [])
    .filter(c => c.date >= today
      && (!deadline || c.date < deadline)
      && (target == null || c.count <= target))
    .sort((a, b) => a.date.localeCompare(b.date))
  // A pattern schedule has no finish line, so there is no final segment — only whatever checkpoints
  // the learner hung on it.
  if (target == null || !deadline) return checkpoints
  return [...checkpoints, { date: deadline, count: target }]
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface ScheduleSegmentStatus {
  /** The date this target must be met by. */
  date: string
  /** Cumulative target at that date, in the schedule's target units. */
  target: number
  /** Words still to go for this segment. */
  remaining: number
  /** Total capacity in [today, date] inclusive. */
  capacity: number
  /** Eligible (capacity > 0) days in [today, date] inclusive. */
  days: number
  /** What this segment alone demands today. */
  demand: number
  /** `remaining - capacity` when positive — words that cannot fit before this date. */
  shortfall: number
  /** True for the final deadline, false for a checkpoint. */
  isDeadline: boolean
}

export interface ScheduleRemedies {
  /**
   * The smallest `dailyCeiling` that makes the schedule fit. Null when raising the ceiling can't
   * help — because `weekdayLimits`/`dateExceptions` are what's binding, or there are no days left.
   */
  minimumCeiling: number | null
  /** The largest target still reachable by the deadline under the current limits. */
  reducedTarget: number
  /** The earliest deadline that fits the current target, or null if not found within a year. */
  feasibleDeadline: string | null
}

export interface ScheduleStatus {
  /** Words to graduate today. This is the number every goal surface should show. */
  goal: number
  /** The segment that set `goal` — the tightest one. Null once the schedule is done or expired. */
  binding: ScheduleSegmentStatus | null
  segments: ScheduleSegmentStatus[]
  /** Words still to go to the FINAL target. */
  remaining: number
  /** Eligible days left, including today. */
  daysLeft: number
  /** Total capacity left, including today. */
  capacityLeft: number
  /** False when some segment can't fit in the capacity before it. */
  feasible: boolean
  /** The worst segment shortfall — how many words are impossible under the current limits. */
  shortfall: number
  /** Target already reached. */
  done: boolean
  /** Past the deadline (and not done). */
  expired: boolean
  /**
   * `doneSoFar - expectedByNow`, where "expected" walks the target in proportion to the CAPACITY
   * consumed rather than to calendar days — so a week off doesn't read as falling behind. Negative =
   * behind by that many words.
   */
  pace: number
  /** Only present when `feasible` is false. */
  remedies: ScheduleRemedies | null
  /** True for a schedule with no finish line — `remaining`/`pace`/`feasible` carry no meaning. */
  isPattern: boolean
  /**
   * Pattern debt: planned-since-start minus done-through-yesterday, filtered by the carry flags
   * (>0 = words owed, <0 = banked surplus). Always 0 for target schedules and debt-off patterns.
   */
  debtBalance: number
}

/**
 * Which of a pair's live schedules is ACTIVE today — the heart of sequential goals (migration 120).
 *
 * Rule: sort by start date; the earliest-starting schedule whose deadline hasn't passed owns the
 * pair. When one's deadline passes, the next in line takes over AUTOMATICALLY — no retiring needed.
 * A pattern schedule has no deadline and so never hands over on its own; retire it to move on.
 *
 * When EVERY schedule has expired, the most recent one is returned rather than null — the "deadline
 * passed, retire or re-date it" warning must stay visible, not vanish the day the date slips by.
 */
export function pickCurrentSchedule(schedules: GoalSchedule[], today: string): GoalSchedule | null {
  const live = schedules.filter(s => !s.archivedAt)
  if (live.length === 0) return null
  const sorted = [...live].sort((a, b) =>
    a.startDate.localeCompare(b.startDate) || a.createdAt.localeCompare(b.createdAt))
  return sorted.find(s => s.deadline == null || s.deadline >= today) ?? sorted[sorted.length - 1]!
}

/**
 * Groups live schedules by pair and picks each pair's active one — the ONE way every goal surface
 * turns `listActive` rows into its per-pair map. Building the map with `new Map(rows.map(...))`
 * would silently keep whichever row came last once a pair can hold a queue.
 */
export function currentSchedulesByPair(schedules: GoalSchedule[], today: string): Map<string, GoalSchedule> {
  const byPair = new Map<string, GoalSchedule[]>()
  for (const s of schedules) {
    const k = `${s.sourceLanguage}|${s.targetLanguage}`
    const a = byPair.get(k)
    if (a) a.push(s); else byPair.set(k, [s])
  }
  const out = new Map<string, GoalSchedule>()
  for (const [k, list] of byPair) {
    const cur = pickCurrentSchedule(list, today)
    if (cur) out.set(k, cur)
  }
  return out
}

export interface ScheduleStatusArgs {
  schedule: GoalSchedule
  /** Local study-day (turnover-aware), from `getToday(tz, turnoverHour)`. */
  today: string
  /**
   * Progress in the schedule's target units:
   *   'new_words'   → words graduated through the ladder since `startDate` (auto-graduated excluded)
   *   'total_words' → the pair's current total graduated count (auto-graduated INCLUDED)
   * Both are cumulative, which is what lets checkpoint counts be cumulative too.
   */
  doneSoFar: number
  /**
   * Today's portion of `doneSoFar`. Only pattern DEBT needs it — the balance must compare planned
   * against done-through-YESTERDAY, or studying today would both fill the goal and shrink it.
   * Omitting it makes the debt goal deflate as you study today; harmless for previews.
   */
  doneToday?: number
}

/**
 * Everything a surface needs to render a schedule: today's number, why it's that number, whether the
 * schedule is still possible, and what to do about it if not.
 */
export function scheduleStatus({ schedule, today, doneSoFar, doneToday }: ScheduleStatusArgs): ScheduleStatus {
  const end = planEnd(schedule, today)
  const from = today > schedule.startDate ? today : schedule.startDate

  // ── Pattern schedule: no finish line, so today's goal IS today's planned number ──
  // Everything downstream of a target (remaining, feasibility, re-spreading) is inapplicable rather
  // than zero-by-accident, so it reports neutral values instead of pretending to measure.
  if (schedule.targetCount == null) {
    const base = patternPlanForDate(schedule, today)
    let goal = base
    let debtBalance = 0

    // The running position vs the CONFIGURED plan — computed for EVERY pattern, debt or not, because
    // "am I ahead or behind my 8-a-day" is a fact of history, not something debt-carry invents.
    // Counts TODAY on both sides, matching `schedulePace` and `goalStanding`: the day starts down by
    // today's goal and climbs to zero as you study.
    const start = progressStart(schedule)
    const yesterday = addScheduleDays(today, -1)
    let planned = 0
    if (yesterday >= start) for (const d of eachDate(start, yesterday)) planned += patternPlanForDate(schedule, d)
    const pace = (doneSoFar - (planned + base)) || 0 // `|| 0` normalizes -0

    // ── Debt (opt-in, per flag) — whether that position also ADJUSTS the goal ──
    // Derived, never stored: planned-since-start minus done-through-yesterday. carryMissed keeps
    // the deficit side, carryExtra the surplus side; either alone clips the other to zero. The
    // ceiling caps the adjusted goal and — because the balance is recomputed from history each
    // day — whatever the cap withholds simply reappears tomorrow, capped again. Exactly the
    // deferral contract `capGoal` documents; do not turn this into a stored counter.
    if (schedule.debtCarryMissed || schedule.debtCarryExtra) {
      const doneThroughYesterday = Math.max(0, doneSoFar - (doneToday ?? 0))
      let balance = planned - doneThroughYesterday
      if (!schedule.debtCarryMissed) balance = Math.min(balance, 0)
      if (!schedule.debtCarryExtra)  balance = Math.max(balance, 0)
      debtBalance = balance
      // The cap: the schedule's own ceiling, else 2.5× the day's base — the same multiple the
      // carryover system uses, so debt can never pile an unclearable wall onto one day.
      const cap = schedule.dailyCeiling ?? Math.floor(base * 2.5)
      goal = Math.min(Math.max(0, base + balance), Math.max(cap, 0))
    }

    const window = capacityWindow(schedule, from, end)
    return {
      goal,
      binding: null,
      segments: [],
      remaining: 0,
      daysLeft: window.caps.filter(c => c > 0).length,
      capacityLeft: window.total,
      feasible: true,
      shortfall: 0,
      done: false,
      expired: !!schedule.deadline && today > schedule.deadline,
      pace,
      remedies: null,
      isPattern: true,
      debtBalance,
    }
  }

  const remaining = Math.max(0, schedule.targetCount - doneSoFar)
  const window = capacityWindow(schedule, from, end)
  const capacityLeft = window.total
  const daysLeft = window.caps.filter(c => c > 0).length

  const done = remaining <= 0
  const expired = !done && !!schedule.deadline && today > schedule.deadline

  const segments: ScheduleSegmentStatus[] = activeSegments(schedule, today).map(seg => {
    const segWindow = capacityWindow(schedule, from, seg.date)
    const segRemaining = Math.max(0, seg.count - doneSoFar)
    const { values, shortfall } = waterFill(segRemaining, segWindow.caps)
    // The first entry is today only when today is inside the schedule; before it starts, nothing is
    // owed yet and the demand is 0.
    const todayIndex = segWindow.dates.indexOf(today)
    const raw = todayIndex >= 0 ? (values[todayIndex] ?? 0) : 0
    return {
      date: seg.date,
      target: seg.count,
      remaining: segRemaining,
      capacity: segWindow.total,
      days: segWindow.caps.filter(c => c > 0).length,
      // Ceil, then clamp to what today can actually hold: asking for 5.26 means asking for 6, or the
      // last day of the schedule silently comes up a word short.
      demand: Math.min(Math.ceil(raw), dayCapacity(schedule, today)),
      shortfall,
      isDeadline: seg.date === schedule.deadline,
    }
  })

  // The tightest segment sets today's number — you must satisfy the soonest binding target as well
  // as the eventual one.
  let binding: ScheduleSegmentStatus | null = null
  for (const seg of segments) if (!binding || seg.demand > binding.demand) binding = seg
  const goal = done || expired ? 0 : (binding?.demand ?? 0)

  const shortfall = segments.reduce((worst, s) => Math.max(worst, s.shortfall), 0)
  const feasible = shortfall <= 0

  return {
    goal,
    binding: done || expired ? null : binding,
    segments,
    remaining,
    daysLeft,
    capacityLeft,
    feasible,
    shortfall,
    done,
    expired,
    pace: schedulePace(schedule, today, doneSoFar),
    remedies: feasible ? null : scheduleRemedies(schedule, today, doneSoFar),
    isPattern: false,
    debtBalance: 0,
  }
}

/**
 * How far ahead or behind the schedule's own straight line you are, in words.
 *
 * Measured against CAPACITY consumed, not days elapsed: a weekend off does not erode your standing,
 * because those days were never expected to carry any words. Returns 0 before the schedule starts.
 *
 * TODAY counts on both sides, matching `goalStanding` in `lib/goalCarryover.ts` — so this opens each
 * morning down by today's share and climbs back to level as you study, rather than sitting at a
 * flattering number all day and lurching at turnover.
 */
export function schedulePace(schedule: GoalSchedule, today: string, doneSoFar: number): number {
  // A pattern schedule has no line to be ahead or behind of.
  if (schedule.targetCount == null || !schedule.deadline) return 0
  if (today < schedule.startDate) return 0
  const whole = capacityWindow(schedule, schedule.startDate, schedule.deadline)
  const upTo = capacityWindow(schedule, schedule.startDate, today < schedule.deadline ? today : schedule.deadline)

  // With no ceiling every day's capacity is Infinity, which carries no information about how the work
  // divides up — so weight each eligible day equally instead. (Without this the whole measure
  // collapses to Infinity/Infinity and an uncapped schedule could never report being behind.)
  const finite = isFinite(whole.total)
  const denominator = finite ? whole.total : whole.caps.filter(c => c > 0).length
  const numerator = finite ? upTo.total : upTo.caps.filter(c => c > 0).length
  if (denominator <= 0) return 0

  const span = (schedule.targetCount ?? 0) - schedule.baselineCount
  const expected = schedule.baselineCount + span * (numerator / denominator)
  return Math.round(doneSoFar - expected)
}

/**
 * The three ways out of an impossible schedule, matching the three levers a learner actually has:
 * do more per day, want less, or allow more time.
 *
 * `minimumCeiling` is found by binary search rather than division because `weekdayLimits` and
 * `dateExceptions` also cap each day — raising the global ceiling past a Friday limit of 3 buys
 * nothing on Fridays, so the answer isn't `remaining / daysLeft`.
 */
export function scheduleRemedies(schedule: GoalSchedule, today: string, doneSoFar: number): ScheduleRemedies {
  const from = today > schedule.startDate ? today : schedule.startDate
  const deadline = schedule.deadline
  // Only a schedule with a finish line can be infeasible, so there is nothing to remedy without one.
  if (schedule.targetCount == null || !deadline) {
    return { minimumCeiling: null, reducedTarget: doneSoFar, feasibleDeadline: null }
  }
  const remaining = Math.max(0, schedule.targetCount - doneSoFar)

  // ── Raise the ceiling ──
  let minimumCeiling: number | null = null
  {
    let lo = 1
    let hi = Math.max(1, remaining)
    const fits = (ceiling: number) => capacityWindow({ ...schedule, dailyCeiling: ceiling }, from, deadline).total >= remaining
    if (fits(hi)) {
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        if (fits(mid)) hi = mid
        else lo = mid + 1
      }
      minimumCeiling = lo
    }
    // else: even an unbounded ceiling doesn't fit — the weekday limits or days off are what bind,
    // so there is no ceiling that helps and null is the honest answer.
  }

  // ── Want less ──
  const reachable = capacityWindow(schedule, from, deadline).total
  const reducedTarget = Math.floor(doneSoFar + (isFinite(reachable) ? reachable : remaining))

  // ── Allow more time ── walk the deadline forward until the accumulated capacity covers it.
  let feasibleDeadline: string | null = null
  {
    let accumulated = capacityWindow(schedule, from, deadline).total
    let date = deadline
    for (let i = 0; i < 366 && accumulated < remaining; i++) {
      date = addScheduleDays(date, 1)
      // Capacity past the deadline is what the weekday limits/ceiling would allow, since the
      // deadline itself is the thing being moved.
      accumulated += dayCapacity({ ...schedule, deadline: date }, date)
    }
    if (accumulated >= remaining) feasibleDeadline = date
  }

  return { minimumCeiling, reducedTarget, feasibleDeadline }
}

// ─── Plans ────────────────────────────────────────────────────────────────────

export interface SchedulePlanDay {
  date: string
  /** Whole words planned for that day. */
  words: number
  /** Running total including this day, offset by the schedule's baseline. */
  cumulative: number
  capacity: number
  /** True when a checkpoint or the deadline falls on this date. */
  milestone: GoalScheduleCheckpoint | null
}

/**
 * The forward plan from `today` to the deadline — what the preview chart and table render.
 *
 * Built segment by segment so checkpoints actually bend the curve: the days before a checkpoint are
 * filled to meet it first, and only the leftover is spread across the days after. Filling the whole
 * span in one pass would draw a straight line that quietly misses every checkpoint.
 */
export function schedulePlan(schedule: GoalSchedule, today: string, doneSoFar: number): SchedulePlanDay[] {
  const from = today > schedule.startDate ? today : schedule.startDate
  const end = planEnd(schedule, today)
  if (from > end) return []

  const { dates, caps } = capacityWindow(schedule, from, end)

  // No finish line: each day carries its planned number (daily = capacity; weekly = the spread).
  if (schedule.targetCount == null) {
    let running = doneSoFar
    const milestones = new Map(activeSegments(schedule, today).map(c => [c.date, c]))
    return dates.map((date, i) => {
      const words = patternPlanForDate(schedule, date)
      running += words
      return { date, words, cumulative: running, capacity: caps[i] ?? 0, milestone: milestones.get(date) ?? null }
    })
  }

  const words = new Array(dates.length).fill(0)
  const indexOf = new Map(dates.map((d, i) => [d, i]))

  let cursor = 0              // first day not yet planned
  let placed = doneSoFar      // cumulative words accounted for
  for (const seg of activeSegments(schedule, today)) {
    const end = indexOf.get(seg.date)
    if (end == null) continue
    const need = Math.max(0, seg.count - placed)
    const slice = caps.slice(cursor, end + 1)
    const { values } = waterFill(need, slice)
    const whole = distributeIntegers(values, slice)
    for (let i = 0; i < whole.length; i++) words[cursor + i] = whole[i] ?? 0
    placed += whole.reduce((a, b) => a + b, 0)
    cursor = end + 1
  }

  const milestones = new Map(activeSegments(schedule, today).map(c => [c.date, c]))
  let running = doneSoFar
  return dates.map((date, i) => {
    const w = words[i] ?? 0
    running += w
    return { date, words: w, cumulative: running, capacity: caps[i] ?? 0, milestone: milestones.get(date) ?? null }
  })
}

/**
 * The whole plan as ASSIGNED at the start — every date in the schedule mapped to the target it was
 * given, computed from the schedule as it stood when it was drawn up.
 *
 * Deliberately NOT the re-spread numbers days actually showed: a past day's goal is a historical
 * record (the same reasoning `ReviewCalendar` already applies to weekday goals), and re-deriving it
 * from today's remaining would rewrite history every time you study. Deterministic and independent of
 * progress.
 *
 * Callers rendering many dates at once (the calendar) MUST use this rather than looping
 * `plannedForDate`: that recomputes the whole water-fill per date, which is O(n²) across a grid and
 * visibly freezes a multi-year schedule on every keystroke.
 */
export function assignedPlan(schedule: GoalSchedule, today?: string): Map<string, number> {
  const end = schedule.deadline ?? planEnd(schedule, today ?? schedule.startDate)
  const { dates, caps } = capacityWindow(schedule, schedule.startDate, end)
  // Pattern schedule: the assignment was always just that day's planned number.
  if (schedule.targetCount == null) {
    return new Map(dates.map(d => [d, patternPlanForDate(schedule, d)]))
  }
  const { values } = waterFill(Math.max(0, schedule.targetCount - schedule.baselineCount), caps)
  const whole = distributeIntegers(values, caps)
  return new Map(dates.map((d, i) => [d, whole[i] ?? 0]))
}

/** One date's assigned target. For more than a couple of dates, use `assignedPlan` instead. */
export function plannedForDate(schedule: GoalSchedule, date: string): number {
  if (date < schedule.startDate) return 0
  if (schedule.deadline && date > schedule.deadline) return 0
  return assignedPlan(schedule, date).get(date) ?? 0
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Everything wrong with a schedule, as sentences fit to show under the editor. Empty = saveable.
 * Feasibility is NOT checked here — an over-ambitious schedule is still a valid one, and
 * `scheduleStatus` reports it with remedies rather than blocking the save.
 */
export function validateSchedule(schedule: GoalSchedule): string[] {
  const errors: string[] = []

  const target = schedule.targetCount
  const deadline = schedule.deadline

  if (!schedule.startDate) errors.push('Set a start date.')
  if (deadline) {
    if (deadline < schedule.startDate) errors.push('The deadline is before the start date.')
    else if (daysBetween(schedule.startDate, deadline) > MAX_SCHEDULE_DAYS) {
      errors.push(`A schedule can span at most ${Math.floor(MAX_SCHEDULE_DAYS / 365)} years.`)
    }
  }

  // A pattern schedule (no target) is perfectly valid — but a target with nowhere to land is not.
  if (target != null) {
    if (!Number.isFinite(target) || target <= 0) errors.push('Set a target of at least 1 word.')
    if (!deadline) errors.push('A target needs a deadline to spread it across.')
    if (schedule.targetKind === 'total_words' && target <= schedule.baselineCount) {
      errors.push(`You already know ${schedule.baselineCount} words in this language — set a total above that.`)
    }
  }
  if (schedule.dailyCeiling != null && schedule.dailyCeiling <= 0) errors.push('A daily ceiling of 0 leaves no room to study. Leave it blank for no ceiling.')

  const end = deadline ?? addScheduleDays(schedule.startDate, PATTERN_HORIZON_DAYS)
  if (schedule.startDate && daysBetween(schedule.startDate, end) <= MAX_SCHEDULE_DAYS) {
    if (capacityWindow(schedule, schedule.startDate, end).total <= 0) {
      errors.push('Every day is set to 0 — there is nowhere to put any words.')
    }
  }
  if (schedule.weeklyTarget != null) {
    if (schedule.weeklyTarget <= 0) errors.push('Set a weekly number of at least 1 word.')
    if (target != null) errors.push('A weekly number and a long-term target are different kinds of goal — pick one.')
  }
  // Without a target OR a weekly number OR a ceiling OR any weekday number, it states nothing at all.
  if (target == null && schedule.weeklyTarget == null && schedule.dailyCeiling == null && !schedule.weekdayLimits) {
    errors.push('Set a target and deadline, or a daily number, or per-weekday numbers.')
  }

  for (const c of schedule.checkpoints ?? []) {
    if (c.date < schedule.startDate || (deadline && c.date > deadline)) {
      errors.push(`Checkpoint ${c.date} is outside the schedule.`)
    }
    if (target != null && c.count > target) {
      errors.push(`Checkpoint ${c.date} asks for more words (${c.count}) than the final target (${target}).`)
    }
    if (c.count <= 0) errors.push(`Checkpoint ${c.date} needs a target above 0.`)
  }

  const dates = (schedule.checkpoints ?? []).map(c => c.date)
  if (new Set(dates).size !== dates.length) errors.push('Two checkpoints share a date.')

  // Cumulative counts must not go backwards, or the earlier one is unreachable-then-undone.
  const sorted = [...(schedule.checkpoints ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    const prev = sorted[i - 1]
    if (cur && prev && cur.count < prev.count) {
      errors.push(`Checkpoint ${cur.date} asks for fewer words than the checkpoint before it — counts are cumulative.`)
      break
    }
  }

  return errors
}
