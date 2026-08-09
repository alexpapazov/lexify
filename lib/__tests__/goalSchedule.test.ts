import {
  addScheduleDays, weekdayOfDate, daysBetween, eachDate, MAX_SCHEDULE_DAYS,
  dayCapacity, capacityWindow, waterFill, distributeIntegers, activeSegments,
  scheduleStatus, schedulePace, scheduleRemedies, schedulePlan, plannedForDate, assignedPlan, validateSchedule,
  isPatternSchedule, planEnd, PATTERN_HORIZON_DAYS,
} from '../goalSchedule'
import type { GoalSchedule } from '@/domain'

/** A 100-words-in-20-days schedule with nothing capping it. 2026-09-01 is a Tuesday. */
function makeSchedule(over: Partial<GoalSchedule> = {}): GoalSchedule {
  return {
    id: 's1', userId: 'u1', sourceLanguage: 'es', targetLanguage: 'en', name: null,
    targetKind: 'new_words', targetCount: 100,
    startDate: '2026-09-01', deadline: '2026-09-20',
    baselineCount: 0, dailyCeiling: null, weekdayLimits: null, dateExceptions: null,
    checkpoints: [], archivedAt: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  }
}

describe('date helpers', () => {
  it('walks days without drifting across a DST boundary', () => {
    // US DST ends 2026-11-01; noon anchoring must keep this a clean 1-day step.
    expect(addScheduleDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addScheduleDays('2026-11-01', 1)).toBe('2026-11-02')
    expect(addScheduleDays('2026-09-05', -4)).toBe('2026-09-01')
  })

  it('knows weekdays', () => {
    expect(weekdayOfDate('2026-09-01')).toBe(2)   // Tuesday
    expect(weekdayOfDate('2026-09-07')).toBe(1)   // Monday
    expect(weekdayOfDate('2026-09-12')).toBe(6)   // Saturday
    expect(weekdayOfDate('2026-09-13')).toBe(0)   // Sunday
  })

  it('counts days inclusively and never negatively', () => {
    expect(daysBetween('2026-09-01', '2026-09-20')).toBe(20)
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(1)
    expect(daysBetween('2026-09-20', '2026-09-01')).toBe(0)
  })

  it('bounds enumeration so a mistyped year cannot freeze the page', () => {
    expect(eachDate('2026-09-01', '2026-09-03')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(eachDate('2026-01-01', '2999-01-01')).toHaveLength(MAX_SCHEDULE_DAYS)
  })
})

describe('dayCapacity', () => {
  it('is Infinity when nothing caps the day', () => {
    expect(dayCapacity(makeSchedule(), '2026-09-02')).toBe(Infinity)
  })

  it('is 0 outside the schedule — no back-work, no overtime', () => {
    const s = makeSchedule({ dailyCeiling: 10 })
    expect(dayCapacity(s, '2026-08-31')).toBe(0)
    expect(dayCapacity(s, '2026-09-21')).toBe(0)
  })

  it('clamps a weekday limit by the ceiling, and vice versa', () => {
    const s = makeSchedule({ dailyCeiling: 10, weekdayLimits: { '2': 3 } })
    expect(dayCapacity(s, '2026-09-01')).toBe(3)    // Tuesday: the limit binds
    expect(dayCapacity(s, '2026-09-02')).toBe(10)   // Wednesday: the ceiling binds
  })

  it('treats a weekday limit of 0 as a day off', () => {
    const s = makeSchedule({ dailyCeiling: 10, weekdayLimits: { '0': 0, '6': 0 } })
    expect(dayCapacity(s, '2026-09-12')).toBe(0)
    expect(dayCapacity(s, '2026-09-13')).toBe(0)
    expect(dayCapacity(s, '2026-09-14')).toBe(10)
  })

  it('lets a date exception override BOTH the weekday limit and the ceiling', () => {
    const s = makeSchedule({
      dailyCeiling: 10,
      weekdayLimits: { '6': 0 },
      dateExceptions: { '2026-09-12': 30, '2026-09-14': 0 },
    })
    expect(dayCapacity(s, '2026-09-12')).toBe(30)   // free Saturday, above the ceiling
    expect(dayCapacity(s, '2026-09-14')).toBe(0)    // away that Monday
  })
})

describe('waterFill', () => {
  it('splits evenly when nothing is capped', () => {
    expect(waterFill(100, [Infinity, Infinity, Infinity, Infinity])).toEqual({
      values: [25, 25, 25, 25], shortfall: 0,
    })
  })

  it('pins capped days and redistributes their overflow', () => {
    // 30 across four days, but one can only take 2 -> the other three absorb 28/3 each.
    const { values, shortfall } = waterFill(30, [2, 20, 20, 20])
    expect(values[0]).toBe(2)
    expect(values.slice(1)).toEqual([28 / 3, 28 / 3, 28 / 3])
    expect(shortfall).toBe(0)
  })

  it('cascades when redistribution overflows a second day', () => {
    const { values, shortfall } = waterFill(30, [2, 3, 20, 20])
    expect(values).toEqual([2, 3, 12.5, 12.5])
    expect(shortfall).toBe(0)
  })

  it('skips zero-capacity days entirely', () => {
    const { values } = waterFill(20, [10, 0, 10, 0])
    expect(values).toEqual([10, 0, 10, 0])
  })

  it('reports what could not be placed once every day is at its cap', () => {
    expect(waterFill(100, [10, 10, 10])).toEqual({ values: [10, 10, 10], shortfall: 70 })
  })

  it('treats a limit as a ceiling, not a weight', () => {
    // Proportional spreading would give the capped day 3/43 of 20 ≈ 1.4; water-filling gives it the
    // even share of 4 clamped to 3 — the point of the whole algorithm.
    const { values } = waterFill(20, [3, 20, 20, 20, 20])
    expect(values[0]).toBe(3)
    expect(values.slice(1)).toEqual([4.25, 4.25, 4.25, 4.25])
  })
})

describe('distributeIntegers', () => {
  it('keeps the total exact while rounding', () => {
    const values = [4 + 1 / 3, 4 + 1 / 3, 4 + 1 / 3]
    expect(distributeIntegers(values, [10, 10, 10]).reduce((a, b) => a + b, 0)).toBe(13)
  })

  it('never rounds a day past its cap', () => {
    const out = distributeIntegers([3, 3.5, 3.5], [3, 10, 10])
    expect(out[0]).toBe(3)
    expect(out.reduce((a, b) => a + b, 0)).toBe(10)
  })
})

describe('scheduleStatus — the daily number', () => {
  it('spreads the target evenly across the whole span', () => {
    const s = makeSchedule()
    const status = scheduleStatus({ schedule: s, today: '2026-09-01', doneSoFar: 0 })
    expect(status.goal).toBe(5)             // 100 / 20
    expect(status.remaining).toBe(100)
    expect(status.daysLeft).toBe(20)
    expect(status.feasible).toBe(true)
  })

  it('RE-SPREADS after a missed day instead of spiking tomorrow', () => {
    const s = makeSchedule()
    // Day 1 missed entirely: 100 words still to go, now over 19 days -> 5.26 -> 6.
    const status = scheduleStatus({ schedule: s, today: '2026-09-02', doneSoFar: 0 })
    expect(status.goal).toBe(6)
    expect(status.daysLeft).toBe(19)
    // Not the debt behaviour: a debt model would have asked for 10 today.
    expect(status.goal).toBeLessThan(10)
  })

  it('eases off when you are ahead', () => {
    const s = makeSchedule()
    // Studied 40 on day one; 60 left over the remaining 19 days -> 3.16 -> 4.
    expect(scheduleStatus({ schedule: s, today: '2026-09-02', doneSoFar: 40 }).goal).toBe(4)
  })

  it('pushes the load onto working days when weekends are off', () => {
    // Mon 2026-09-07 → Fri 2026-09-18 is 12 days, of which Sep 12/13 are the weekend: 10 working days.
    const s = makeSchedule({
      startDate: '2026-09-07', deadline: '2026-09-18', targetCount: 50,
      weekdayLimits: { '0': 0, '6': 0 },
    })
    const status = scheduleStatus({ schedule: s, today: '2026-09-07', doneSoFar: 0 })
    expect(status.daysLeft).toBe(10)
    expect(status.goal).toBe(5)             // 50 / 10 working days, not 50 / 12
    // The weekend itself asks for nothing.
    expect(scheduleStatus({ schedule: s, today: '2026-09-12', doneSoFar: 25 }).goal).toBe(0)
  })

  it('holds the line at the ceiling and reports the overflow as infeasible', () => {
    const s = makeSchedule({ startDate: '2026-09-01', deadline: '2026-09-10', dailyCeiling: 5 })
    const status = scheduleStatus({ schedule: s, today: '2026-09-01', doneSoFar: 0 })
    expect(status.goal).toBe(5)             // never above the ceiling
    expect(status.capacityLeft).toBe(50)
    expect(status.feasible).toBe(false)
    expect(status.shortfall).toBe(50)       // 100 wanted, 50 possible
  })

  it('owes nothing before it starts, and stops once the target is met', () => {
    const s = makeSchedule()
    expect(scheduleStatus({ schedule: s, today: '2026-08-25', doneSoFar: 0 }).goal).toBe(0)
    const met = scheduleStatus({ schedule: s, today: '2026-09-10', doneSoFar: 100 })
    expect(met.done).toBe(true)
    expect(met.goal).toBe(0)
    expect(met.binding).toBeNull()
  })

  it('marks an unmet schedule expired once the deadline passes', () => {
    const status = scheduleStatus({ schedule: makeSchedule(), today: '2026-09-25', doneSoFar: 60 })
    expect(status.expired).toBe(true)
    expect(status.done).toBe(false)
    expect(status.goal).toBe(0)
  })
})

describe('scheduleStatus — checkpoints', () => {
  const s = makeSchedule({
    checkpoints: [{ date: '2026-09-05', count: 50 }],   // half the words in the first quarter
  })

  it('lets the tightest segment set today’s number', () => {
    const status = scheduleStatus({ schedule: s, today: '2026-09-01', doneSoFar: 0 })
    // Deadline alone wants 5/day; the checkpoint wants 50 over 5 days = 10/day. The checkpoint binds.
    expect(status.goal).toBe(10)
    expect(status.binding?.date).toBe('2026-09-05')
    expect(status.binding?.isDeadline).toBe(false)
  })

  it('hands a missed checkpoint’s words to the next window rather than losing them', () => {
    // The 5th passed with only 20 done. The checkpoint drops out; the deadline still wants all 100.
    const status = scheduleStatus({ schedule: s, today: '2026-09-06', doneSoFar: 20 })
    expect(status.segments).toHaveLength(1)
    expect(status.segments[0]!.isDeadline).toBe(true)
    expect(status.remaining).toBe(80)       // nothing forgiven
    expect(status.goal).toBe(6)             // 80 over the 15 days left
  })

  it('falls back to the deadline once the checkpoint is satisfied', () => {
    const status = scheduleStatus({ schedule: s, today: '2026-09-03', doneSoFar: 50 })
    expect(status.binding?.isDeadline).toBe(true)
    expect(status.goal).toBe(3)             // 50 left over 18 days
  })

  it('ignores checkpoints outside the schedule instead of obeying them', () => {
    const bad = makeSchedule({ checkpoints: [{ date: '2026-10-01', count: 60 }] })
    expect(activeSegments(bad, '2026-09-01')).toEqual([{ date: '2026-09-20', count: 100 }])
  })
})

describe('schedulePace', () => {
  it('is level when progress matches the plan', () => {
    const s = makeSchedule({ dailyCeiling: 5 })
    // Through 2026-09-10 the plan has spent 10 of 20 days: 50 words expected.
    expect(schedulePace(s, '2026-09-10', 50)).toBe(0)
    expect(schedulePace(s, '2026-09-10', 30)).toBe(-20)
    expect(schedulePace(s, '2026-09-10', 65)).toBe(15)
  })

  it('does not let a scheduled day off erode your standing', () => {
    const s = makeSchedule({
      startDate: '2026-09-07', deadline: '2026-09-18', targetCount: 50,
      dailyCeiling: 5, weekdayLimits: { '0': 0, '6': 0 },
    })
    // Level on Friday evening, having done all 5 working days so far.
    expect(schedulePace(s, '2026-09-11', 25)).toBe(0)
    // Two untouched weekend days must leave that standing exactly where it was.
    expect(schedulePace(s, '2026-09-12', 25)).toBe(0)
    expect(schedulePace(s, '2026-09-13', 25)).toBe(0)
    // Monday counts today's own share, per the goalStanding convention — down by one day's worth.
    expect(schedulePace(s, '2026-09-14', 25)).toBe(-5)
    expect(schedulePace(s, '2026-09-14', 30)).toBe(0)
  })

  it('works on an uncapped schedule, where capacity carries no information', () => {
    expect(schedulePace(makeSchedule(), '2026-09-10', 50)).toBe(0)
    expect(schedulePace(makeSchedule(), '2026-09-10', 20)).toBe(-30)
  })

  it('expects nothing before the start date', () => {
    expect(schedulePace(makeSchedule(), '2026-08-01', 0)).toBe(0)
  })

  it('measures a total-words schedule from its baseline, not from zero', () => {
    const s = makeSchedule({ targetKind: 'total_words', targetCount: 1000, baselineCount: 900, dailyCeiling: 5 })
    // Halfway through, half of the 100-word span should be done: 950 total.
    expect(schedulePace(s, '2026-09-10', 950)).toBe(0)
    expect(schedulePace(s, '2026-09-10', 900)).toBe(-50)
  })
})

describe('scheduleRemedies', () => {
  const tight = makeSchedule({ startDate: '2026-09-01', deadline: '2026-09-10', dailyCeiling: 5 })

  it('names the smallest ceiling that would fit', () => {
    // 100 words across 10 days needs 10/day.
    expect(scheduleRemedies(tight, '2026-09-01', 0).minimumCeiling).toBe(10)
  })

  it('names the largest target still reachable', () => {
    expect(scheduleRemedies(tight, '2026-09-01', 0).reducedTarget).toBe(50)
    // Already 20 in: the reachable total includes what's done.
    expect(scheduleRemedies(tight, '2026-09-01', 20).reducedTarget).toBe(70)
  })

  it('names the earliest deadline that would fit', () => {
    // 100 words at 5/day needs 20 days, so the deadline has to move out by 10.
    expect(scheduleRemedies(tight, '2026-09-01', 0).feasibleDeadline).toBe('2026-09-20')
  })

  it('returns no ceiling when the weekday limits are what actually bind', () => {
    // Every day is capped at 2 regardless of the global ceiling, so raising it buys nothing.
    const capped = makeSchedule({
      startDate: '2026-09-01', deadline: '2026-09-10',
      weekdayLimits: { '0': 2, '1': 2, '2': 2, '3': 2, '4': 2, '5': 2, '6': 2 },
    })
    const remedies = scheduleRemedies(capped, '2026-09-01', 0)
    expect(remedies.minimumCeiling).toBeNull()
    expect(remedies.reducedTarget).toBe(20)
  })

  it('accounts for days already gone when re-planning mid-schedule', () => {
    // Five days left, 90 to go -> 18/day.
    expect(scheduleRemedies(tight, '2026-09-06', 10).minimumCeiling).toBe(18)
  })
})

describe('schedulePlan', () => {
  it('reaches exactly the target on the deadline', () => {
    const plan = schedulePlan(makeSchedule({ dailyCeiling: 10 }), '2026-09-01', 0)
    expect(plan).toHaveLength(20)
    expect(plan[plan.length - 1]!.cumulative).toBe(100)
    expect(plan.every(d => d.words === 5)).toBe(true)
  })

  it('bends the curve so checkpoints are actually met', () => {
    const s = makeSchedule({ dailyCeiling: 20, checkpoints: [{ date: '2026-09-05', count: 50 }] })
    const plan = schedulePlan(s, '2026-09-01', 0)
    const atCheckpoint = plan.find(d => d.date === '2026-09-05')!
    expect(atCheckpoint.cumulative).toBe(50)      // front-loaded to hit it
    expect(atCheckpoint.milestone).toEqual({ date: '2026-09-05', count: 50 })
    expect(plan[plan.length - 1]!.cumulative).toBe(100)
    // The days after the checkpoint carry the lighter remainder.
    expect(plan[0]!.words).toBe(10)
    expect(plan[plan.length - 1]!.words).toBeLessThan(10)
  })

  it('starts from what is already done', () => {
    const plan = schedulePlan(makeSchedule({ dailyCeiling: 10 }), '2026-09-11', 50)
    expect(plan).toHaveLength(10)
    expect(plan[plan.length - 1]!.cumulative).toBe(100)
  })

  it('is empty once the deadline has passed', () => {
    expect(schedulePlan(makeSchedule(), '2026-09-21', 0)).toEqual([])
  })

  it('places nothing on a day off', () => {
    const s = makeSchedule({
      startDate: '2026-09-07', deadline: '2026-09-18', targetCount: 50,
      dailyCeiling: 10, weekdayLimits: { '0': 0, '6': 0 },
    })
    const plan = schedulePlan(s, '2026-09-07', 0)
    expect(plan.find(d => d.date === '2026-09-12')!.words).toBe(0)
    expect(plan.find(d => d.date === '2026-09-13')!.words).toBe(0)
    expect(plan[plan.length - 1]!.cumulative).toBe(50)
  })
})

describe('plannedForDate', () => {
  it('reports a past day’s assigned target, unchanged by what happened since', () => {
    const s = makeSchedule({ dailyCeiling: 10 })
    expect(plannedForDate(s, '2026-09-03')).toBe(5)
    // The same answer regardless of progress — a past day's goal is a historical record.
    expect(plannedForDate(s, '2026-09-03')).toBe(5)
    expect(plannedForDate(s, '2026-08-31')).toBe(0)
    expect(plannedForDate(s, '2026-09-21')).toBe(0)
  })

  it('assigns nothing to a day off', () => {
    const s = makeSchedule({
      startDate: '2026-09-07', deadline: '2026-09-18', targetCount: 50,
      dailyCeiling: 10, weekdayLimits: { '0': 0, '6': 0 },
    })
    expect(plannedForDate(s, '2026-09-12')).toBe(0)
    expect(plannedForDate(s, '2026-09-14')).toBe(5)
  })
})

describe('assignedPlan', () => {
  it('agrees with plannedForDate on every date', () => {
    const s = makeSchedule({ dailyCeiling: 10, weekdayLimits: { '0': 0, '6': 0 }, checkpoints: [] })
    const plan = assignedPlan(s)
    for (const [date, words] of plan) expect(words).toBe(plannedForDate(s, date))
  })

  it('covers the whole span and sums to the target', () => {
    const s = makeSchedule({ dailyCeiling: 10 })
    const plan = assignedPlan(s)
    expect(plan.size).toBe(20)
    expect([...plan.values()].reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('measures a total-words schedule from its baseline', () => {
    const s = makeSchedule({ targetKind: 'total_words', targetCount: 1000, baselineCount: 900, dailyCeiling: 10 })
    expect([...assignedPlan(s).values()].reduce((a, b) => a + b, 0)).toBe(100)
  })
})

describe('pattern schedules (no finish line)', () => {
  /** "8 a day, none at the weekend", running on indefinitely. */
  const pattern = () => makeSchedule({
    targetCount: null, deadline: null, dailyCeiling: 8, weekdayLimits: { '0': 0, '6': 0 },
  })

  it('is recognised as a pattern', () => {
    expect(isPatternSchedule(pattern())).toBe(true)
    expect(isPatternSchedule(makeSchedule())).toBe(false)
  })

  it("today's goal is simply today's capacity", () => {
    const s = pattern()
    expect(scheduleStatus({ schedule: s, today: '2026-09-07', doneSoFar: 0 }).goal).toBe(8)  // Monday
    expect(scheduleStatus({ schedule: s, today: '2026-09-12', doneSoFar: 0 }).goal).toBe(0)  // Saturday
  })

  it('reports the measures that need a finish line as neutral, not as zero progress', () => {
    const st = scheduleStatus({ schedule: pattern(), today: '2026-09-07', doneSoFar: 40 })
    expect(st.isPattern).toBe(true)
    expect(st.feasible).toBe(true)     // nothing to be infeasible against
    expect(st.pace).toBe(0)            // nothing to be behind
    expect(st.done).toBe(false)        // never "finished"
    expect(st.remedies).toBeNull()
  })

  it('draws an open-ended plan over a rolling horizon', () => {
    const plan = schedulePlan(pattern(), '2026-09-07', 0)
    expect(plan).toHaveLength(PATTERN_HORIZON_DAYS + 1)
    expect(plan[0]!.words).toBe(8)                                    // Monday
    expect(plan.find(d => d.date === '2026-09-12')!.words).toBe(0)    // Saturday off
    expect(planEnd(pattern(), '2026-09-07')).toBe('2027-03-06')
  })

  it('asks for nothing when it states no number at all', () => {
    // No target, no ceiling, no weekday numbers: there is nothing to derive a goal from.
    const empty = makeSchedule({ targetCount: null, deadline: null, dailyCeiling: null })
    expect(scheduleStatus({ schedule: empty, today: '2026-09-07', doneSoFar: 0 }).goal).toBe(0)
    expect(validateSchedule(empty).some(e => /a daily number/.test(e))).toBe(true)
  })

  it('still honours days off and per-date caps', () => {
    const s = makeSchedule({
      targetCount: null, deadline: null, dailyCeiling: 8,
      dateExceptions: { '2026-09-09': 0, '2026-09-10': 3 },
    })
    expect(scheduleStatus({ schedule: s, today: '2026-09-09', doneSoFar: 0 }).goal).toBe(0)
    expect(scheduleStatus({ schedule: s, today: '2026-09-10', doneSoFar: 0 }).goal).toBe(3)
  })

  it('assigns past days the number they were always going to hold', () => {
    expect(plannedForDate(pattern(), '2026-09-07')).toBe(8)
    expect(plannedForDate(pattern(), '2026-09-12')).toBe(0)
    expect(plannedForDate(pattern(), '2026-08-31')).toBe(0)   // before the start
  })

  it('accepts a bare per-weekday pattern with no ceiling', () => {
    const s = makeSchedule({
      targetCount: null, deadline: null, dailyCeiling: null,
      weekdayLimits: { '1': 5, '2': 5, '3': 5, '4': 5, '5': 5, '6': 0, '0': 0 },
    })
    expect(validateSchedule(s)).toEqual([])
    expect(scheduleStatus({ schedule: s, today: '2026-09-07', doneSoFar: 0 }).goal).toBe(5)
  })
})

describe('validateSchedule', () => {
  it('accepts a sane schedule', () => {
    expect(validateSchedule(makeSchedule())).toEqual([])
  })

  it('rejects a target with no deadline to spread it across', () => {
    const s = makeSchedule({ deadline: null })
    expect(validateSchedule(s).some(e => /needs a deadline/.test(e))).toBe(true)
  })

  it('rejects a deadline before the start', () => {
    expect(validateSchedule(makeSchedule({ deadline: '2026-08-01' }))[0]).toMatch(/before the start/)
  })

  it('rejects a target that is already met by the baseline', () => {
    const s = makeSchedule({ targetKind: 'total_words', targetCount: 500, baselineCount: 500 })
    expect(validateSchedule(s)[0]).toMatch(/already know 500/)
  })

  it('rejects a schedule with no capacity anywhere', () => {
    const s = makeSchedule({ weekdayLimits: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 } })
    expect(validateSchedule(s)[0]).toMatch(/nowhere to put/)
  })

  it('catches checkpoint mistakes', () => {
    expect(validateSchedule(makeSchedule({ checkpoints: [{ date: '2026-10-05', count: 50 }] }))[0])
      .toMatch(/outside the schedule/)
    expect(validateSchedule(makeSchedule({ checkpoints: [{ date: '2026-09-05', count: 150 }] }))[0])
      .toMatch(/more words/)
    expect(validateSchedule(makeSchedule({ checkpoints: [
      { date: '2026-09-05', count: 50 }, { date: '2026-09-10', count: 30 },
    ] })).some(e => /cumulative/.test(e))).toBe(true)
    expect(validateSchedule(makeSchedule({ checkpoints: [
      { date: '2026-09-05', count: 50 }, { date: '2026-09-05', count: 60 },
    ] })).some(e => /share a date/.test(e))).toBe(true)
  })

  it('does NOT reject an over-ambitious schedule — that is a warning, not an error', () => {
    const s = makeSchedule({ dailyCeiling: 1 })   // 100 words, 20 days, 1/day
    expect(validateSchedule(s)).toEqual([])
    expect(scheduleStatus({ schedule: s, today: '2026-09-01', doneSoFar: 0 }).feasible).toBe(false)
  })
})

describe('capacityWindow', () => {
  it('sums finite capacity and counts eligible days', () => {
    const s = makeSchedule({ dailyCeiling: 5, weekdayLimits: { '0': 0, '6': 0 } })
    const w = capacityWindow(s, '2026-09-07', '2026-09-18')
    expect(w.dates).toHaveLength(12)
    expect(w.caps.filter(c => c > 0)).toHaveLength(10)
    expect(w.total).toBe(50)
  })
})
