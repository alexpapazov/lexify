import {
  isCarryingDebt, isOwedByPlan, planProgress, conflictingScopes, trackDueDates,
  type CatchUpPlanRecord, type CatchUpPlanRecords,
} from '@/lib/catchUpPlan'
import { initialCardState } from '@/engine/pipeline'
import type { CardState } from '@/domain'

const TODAY = '2026-08-22'
const TZ    = 'UTC'

function grad(over: Partial<CardState> = {}): CardState {
  return {
    ...initialCardState('u', 'c', 'p'),
    graduated: true,
    lastReviewedAt: '2026-08-01T04:00:00.000Z',
    scheduledIntervalDays: 30,
    intervalDays: 30,
    ...over,
  }
}

const PLAN: CatchUpPlanRecord = { targetDate: '2026-09-05', startedOn: TODAY, total: 81 }

describe('isCarryingDebt', () => {
  it('is false for a card sitting exactly where its own schedule put it', () => {
    // scheduledIntervalDays IS the recorded gap between lastReviewedAt and dueAt, so an untouched
    // card matches it exactly.
    expect(isCarryingDebt(grad(), '2026-08-31T04:00:00.000Z', 'prod')).toBe(false)
  })

  it('is false for a card nudged within the fuzz window by Redistribute', () => {
    // Redistribute moves due dates ±5% without touching scheduledIntervalDays; those must not read
    // as claimed by a catch-up.
    expect(isCarryingDebt(grad(), '2026-09-01T04:00:00.000Z', 'prod')).toBe(false)   // gap 31 vs 30 × 1.05 + 1
  })

  it('is true for a card pushed well past its own interval without a review', () => {
    // 200 days overdue, dealt onto a catch-up day: the gap dwarfs its interval.
    expect(isCarryingDebt(grad(), '2026-08-27T04:00:00.000Z', 'prod')).toBe(false)
    expect(isCarryingDebt(grad({ lastReviewedAt: '2026-02-01T04:00:00.000Z' }), '2026-08-27T04:00:00.000Z', 'prod')).toBe(true)
  })

  it('catches a card that was only mildly overdue before being dealt', () => {
    // lastReviewed 2026-07-01, interval 30 → its own due was 2026-07-31, so it was 22 days late.
    // Dealt to 2026-08-27 the gap is 57 against a 30-day interval.
    const s = grad({ lastReviewedAt: '2026-07-01T04:00:00.000Z' })
    expect(isCarryingDebt(s, '2026-08-27T04:00:00.000Z', 'prod')).toBe(true)
  })

  it('falls back to graduatedAt for a bulk-onboarded card that has never been reviewed', () => {
    const s = grad({ lastReviewedAt: null, graduatedAt: '2026-02-01T04:00:00.000Z' })
    expect(isCarryingDebt(s, '2026-08-27T04:00:00.000Z', 'prod')).toBe(true)
  })

  it('is false when there is no anchor to measure from at all', () => {
    expect(isCarryingDebt(grad({ lastReviewedAt: null, graduatedAt: null }), '2026-08-27T04:00:00.000Z', 'prod')).toBe(false)
  })

  it('is false for a missing due date', () => {
    expect(isCarryingDebt(grad(), null, 'prod')).toBe(false)
  })
})

describe('trackDueDates', () => {
  it('tags the production lane and recall separately on a forward row', () => {
    const s = grad({ smartDueAt: 'A', recallDueAt: 'B', dueAt: 'C' })
    expect(trackDueDates(s)).toEqual([{ due: 'A', kind: 'prod' }, { due: 'B', kind: 'recall' }])
  })
  it('reads only the recall column on a reverse row', () => {
    expect(trackDueDates(grad({ reviewDirection: 'reverse', recallDueAt: 'R', dueAt: 'C' })))
      .toEqual([{ due: 'R', kind: 'reverse' }])
  })
})

describe('isOwedByPlan', () => {
  const pushed = { lastReviewedAt: '2026-02-01T04:00:00.000Z' }

  it('counts a pushed card inside the window', () => {
    expect(isOwedByPlan(grad({ ...pushed, dueAt: '2026-08-27T04:00:00.000Z' }), PLAN, TODAY, TZ)).toBe(true)
  })

  it('ignores a normally-scheduled card that merely lands in the same window', () => {
    // This is why the window alone is not enough — 186 cards a day arrive in it legitimately.
    expect(isOwedByPlan(grad({ dueAt: '2026-08-31T04:00:00.000Z' }), PLAN, TODAY, TZ)).toBe(false)
  })

  it('ignores a pushed card scheduled beyond the window', () => {
    expect(isOwedByPlan(grad({ ...pushed, dueAt: '2026-10-01T04:00:00.000Z' }), PLAN, TODAY, TZ)).toBe(false)
  })

  it('stops counting a card once it has been reviewed', () => {
    // A review rewrites lastReviewedAt and scheduledIntervalDays together, so the debt vanishes —
    // this is exactly what moves the progress bar.
    const done = grad({ lastReviewedAt: `${TODAY}T10:00:00.000Z`, scheduledIntervalDays: 12, dueAt: '2026-09-03T04:00:00.000Z' })
    expect(isOwedByPlan(done, PLAN, TODAY, TZ)).toBe(false)
  })

  it('ignores dormant and ungraduated rows', () => {
    expect(isOwedByPlan(grad({ ...pushed, dormant: true, dueAt: '2026-08-27T04:00:00.000Z' }), PLAN, TODAY, TZ)).toBe(false)
    expect(isOwedByPlan(grad({ ...pushed, graduated: false, dueAt: '2026-08-27T04:00:00.000Z' }), PLAN, TODAY, TZ)).toBe(false)
  })
})

describe('planProgress', () => {
  it('reports done, remaining and the fraction', () => {
    const p = planProgress(PLAN, 30, TODAY)
    expect(p).toMatchObject({ total: 81, remaining: 30, done: 51, complete: false, overdue: false })
    expect(p.fraction).toBeCloseTo(51 / 81, 6)
    expect(p.daysLeft).toBe(14)
  })

  it('is complete at zero remaining', () => {
    const p = planProgress(PLAN, 0, TODAY)
    expect(p.complete).toBe(true)
    expect(p.fraction).toBe(1)
  })

  it('never runs backwards past its own start when more cards lapse in', () => {
    const p = planProgress(PLAN, 200, TODAY)
    expect(p.done).toBe(0)
    expect(p.fraction).toBe(0)
  })

  it('flags a passed target that still owes cards', () => {
    const p = planProgress({ ...PLAN, targetDate: '2026-08-10' }, 12, TODAY)
    expect(p.daysLeft).toBe(0)
    expect(p.overdue).toBe(true)
  })

  it('does not call a passed target overdue once everything is done', () => {
    expect(planProgress({ ...PLAN, targetDate: '2026-08-10' }, 0, TODAY).overdue).toBe(false)
  })

  it('treats an empty plan as complete rather than dividing by zero', () => {
    expect(planProgress({ ...PLAN, total: 0 }, 0, TODAY).fraction).toBe(1)
  })
})

describe('conflictingScopes', () => {
  it('finds plans on the same language that would double-count', () => {
    const existing: CatchUpPlanRecords = {
      'bg|en':           PLAN,
      'bg|en:typing':    PLAN,
      'es|en:sgReverse': PLAN,
    }
    expect(conflictingScopes('bg|en:sgForward', existing).sort()).toEqual(['bg|en', 'bg|en:typing'])
    expect(conflictingScopes('es|en', existing)).toEqual(['es|en:sgReverse'])
  })

  it('does not report the key being written as its own conflict', () => {
    expect(conflictingScopes('bg|en', { 'bg|en': PLAN })).toEqual([])
  })
})

describe('per-track debt — the 3,241 false-positive regression', () => {
  it('judges a recall date against the RECALL interval, not the last-reviewed track\'s', () => {
    // Production reviewed at a 5-day interval (which wrote scheduledIntervalDays = 5) while
    // recognition is legitimately due 40 days out on its own 40-day schedule. Judged against the
    // production interval this reads as debt; against its own it plainly is not.
    const s = grad({
      scheduledIntervalDays: 5, intervalDays: 5, smartIntervalDays: 5,
      recallIntervalDays: 40,
      lastReviewedAt: '2026-08-20T04:00:00.000Z',
    })
    expect(isCarryingDebt(s, '2026-09-29T04:00:00.000Z', 'recall')).toBe(false)
    // The same 40-day gap on the PRODUCTION track genuinely is debt.
    expect(isCarryingDebt(s, '2026-09-29T04:00:00.000Z', 'prod')).toBe(true)
  })

  it('treats a row with no establishable interval as NOT debt', () => {
    // Claiming a card makes it re-spreadable — unprovable must mean unclaimed, so a
    // bulk-onboarded row with zeroed legacy intervals can never be swept up.
    const s = grad({
      scheduledIntervalDays: 0, intervalDays: 0,
      smartIntervalDays: null, typedIntervalDays: null, recallIntervalDays: null,
      lastReviewedAt: null, graduatedAt: '2026-07-30T04:00:00.000Z',
    })
    expect(isCarryingDebt(s, '2026-09-20T04:00:00.000Z', 'prod')).toBe(false)
    expect(isCarryingDebt(s, '2026-09-20T04:00:00.000Z', 'recall')).toBe(false)
  })

  it('an onboarded card sitting on its own assigned interval is not debt; a spread one is', () => {
    const onboarded = grad({
      lastReviewedAt: null, graduatedAt: '2026-07-30T04:00:00.000Z',
      scheduledIntervalDays: 0, intervalDays: 0, smartIntervalDays: 30,
    })
    // Due exactly 30 days after graduation — where onboarding put it.
    expect(isCarryingDebt(onboarded, '2026-08-29T04:00:00.000Z', 'prod')).toBe(false)
    // The same card dealt far past its interval by a spread.
    expect(isCarryingDebt(onboarded, '2026-10-15T04:00:00.000Z', 'prod')).toBe(true)
  })
})
