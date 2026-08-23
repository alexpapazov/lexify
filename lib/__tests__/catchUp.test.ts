import {
  LAPSED_R, MAX_LAPSED_SHARE,
  scopeKey, resolvePlan, daysBetween, addDays,
  catchUpQuota, candidateMetrics, elapsedDaysFor,
  interleaveEvenly, planCatchUpSession, previewCatchUp, isLapsed,
  type CatchUpCandidate, type CatchUpPlans,
} from '@/lib/catchUp'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A candidate at a given (elapsed, stability). Ranking happens inside the planner. */
function cand(key: string, elapsedDays: number, stability: number): CatchUpCandidate {
  return { key, elapsedDays, stability }
}

/** The two ranking numbers a candidate would get over a 14-day window. */
function metrics(c: CatchUpCandidate, daysRemaining = 14) {
  return candidateMetrics(c.elapsedDays, c.stability, daysRemaining)
}

/** `n` interchangeable candidates in a band, so counts can be asserted without ordering noise. */
function band(prefix: string, n: number, elapsedDays: number, stability: number): CatchUpCandidate[] {
  return Array.from({ length: n }, (_, i) => cand(`${prefix}${i}`, elapsedDays, stability))
}

const TODAY = '2026-08-22'

// ─── Scope ────────────────────────────────────────────────────────────────────

describe('scope keys', () => {
  it('separates a whole language from one card type', () => {
    expect(scopeKey('bg|en')).toBe('bg|en')
    expect(scopeKey('bg|en', 'typing')).toBe('bg|en:typing')
  })

  it('resolves most-specific-first, falling back to the language plan', () => {
    const plans: CatchUpPlans = {
      'bg|en':          { targetDate: '2026-09-05' },
      'bg|en:typing':   { targetDate: '2026-08-29' },
    }
    // The type-level plan wins for typing...
    expect(resolvePlan(plans, 'bg|en', 'typing')?.plan.targetDate).toBe('2026-08-29')
    // ...and the language plan still covers the types that have none of their own.
    expect(resolvePlan(plans, 'bg|en', 'sgForward')?.plan.targetDate).toBe('2026-09-05')
    expect(resolvePlan(plans, 'es|en', 'typing')).toBeNull()
  })
})

describe('date helpers', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetween(TODAY, '2026-09-05')).toBe(14)
    expect(daysBetween(TODAY, TODAY)).toBe(0)
    expect(daysBetween(TODAY, '2026-08-20')).toBe(-2)
  })

  it('addDays crosses a month boundary', () => {
    expect(addDays(TODAY, 14)).toBe('2026-09-05')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

// ─── The quota ────────────────────────────────────────────────────────────────

describe('catchUpQuota', () => {
  it('is today\'s arrivals plus an even slice of the backlog', () => {
    const q = catchUpQuota({ overdue: 1500, dueToday: 190, targetDate: '2026-09-05', today: TODAY })
    expect(q.daysRemaining).toBe(14)
    expect(q.fromBacklog).toBe(Math.ceil(1500 / 14))   // 108
    expect(q.fromToday).toBe(190)
    expect(q.quota).toBe(298)
    expect(q.pastTarget).toBe(false)
  })

  it('clears everything on the target date itself', () => {
    const q = catchUpQuota({ overdue: 400, dueToday: 50, targetDate: TODAY, today: TODAY })
    expect(q.daysRemaining).toBe(1)
    expect(q.quota).toBe(450)
    expect(q.pastTarget).toBe(false)   // the date has arrived, it has not passed
  })

  it('holds at the full remaining load once the target has passed', () => {
    // Nothing stops serving on its own — the plan ends when the backlog does, not when the date does.
    const q = catchUpQuota({ overdue: 220, dueToday: 60, targetDate: '2026-08-20', today: TODAY })
    expect(q.pastTarget).toBe(true)
    expect(q.daysRemaining).toBe(1)
    expect(q.quota).toBe(280)
  })

  it('asks for nothing extra when the backlog is already clear', () => {
    const q = catchUpQuota({ overdue: 0, dueToday: 190, targetDate: '2026-09-05', today: TODAY })
    expect(q.fromBacklog).toBe(0)
    expect(q.quota).toBe(190)
  })

  it('drains to exactly zero by the target date, and never asks for more than the day before', () => {
    // The property that matters: recomputing daily from the live backlog trends DOWNWARD. A naive
    // `backlog / totalDays` climbs as new cards arrive, so the target appears to run away from you.
    let overdue = 1500
    const inflow = 190
    let prevSlice = Infinity
    for (let day = 0; day < 14; day++) {
      const q = catchUpQuota({
        overdue, dueToday: inflow, targetDate: '2026-09-05', today: addDays(TODAY, day),
      })
      expect(q.fromBacklog).toBeLessThanOrEqual(prevSlice)
      prevSlice = q.fromBacklog
      overdue -= q.fromBacklog                 // today's slice cleared; the arrivals were cleared too
    }
    expect(overdue).toBe(0)
  })

  it('self-corrects after a day you overshoot', () => {
    const onPlan = catchUpQuota({ overdue: 1392, dueToday: 190, targetDate: '2026-09-05', today: addDays(TODAY, 1) })
    const ahead  = catchUpQuota({ overdue: 1000, dueToday: 190, targetDate: '2026-09-05', today: addDays(TODAY, 1) })
    expect(ahead.quota).toBeLessThan(onPlan.quota)
  })
})

// ─── Ranking ──────────────────────────────────────────────────────────────────

describe('candidateMetrics', () => {
  it('scores deferral damage highest in the about-to-slip band', () => {
    // The whole ordering rests on this being non-monotonic across a real pool: loss = R·(1 − 0.9^(d/S)),
    // so a rock-solid card (high R, huge S) and a long-gone one (tiny R) both lose almost nothing by
    // waiting, while a fragile card still mostly remembered loses a lot.
    const rockSolid   = metrics(cand('solid',  5,   300))  // R ≈ 0.998, very stable
    const aboutToSlip = metrics(cand('slip',   12,  15))   // R ≈ 0.918, fragile
    const longGone    = metrics(cand('gone',   400, 15))   // R ≈ 0.060, already lost

    expect(aboutToSlip.deferralLoss).toBeGreaterThan(rockSolid.deferralLoss)
    expect(aboutToSlip.deferralLoss).toBeGreaterThan(longGone.deferralLoss)
    expect(longGone.retrievability).toBeLessThan(LAPSED_R)
    expect(rockSolid.retrievability).toBeGreaterThan(LAPSED_R)
  })

  it('reports no loss for a zero-length window', () => {
    const c = candidateMetrics(10, 20, 0)
    expect(c.deferralLoss).toBe(0)
  })
})

describe('elapsedDaysFor', () => {
  const now = Date.parse('2026-08-22T12:00:00.000Z')

  it('measures from the last review when there is one', () => {
    const d = elapsedDaysFor({
      lastReviewedAt: '2026-08-12T12:00:00.000Z', intervalDays: 3, daysOverdue: 99, now,
    })
    expect(d).toBeCloseTo(10, 5)
  })

  it('falls back to interval + overdue for a row never reviewed', () => {
    // Bulk-onboarded cards carry a due date with reps 0 and a null lastReviewedAt by design.
    expect(elapsedDaysFor({ lastReviewedAt: null, intervalDays: 30, daysOverdue: 12, now })).toBe(42)
  })

  it('ignores an unparseable timestamp rather than producing NaN', () => {
    expect(elapsedDaysFor({ lastReviewedAt: 'not-a-date', intervalDays: 7, daysOverdue: 1, now })).toBe(8)
  })
})

// ─── Interleaving ─────────────────────────────────────────────────────────────

describe('interleaveEvenly', () => {
  it('spreads the sprinkle out instead of clumping it at either end', () => {
    const main     = Array.from({ length: 12 }, (_, i) => `m${i}`)
    const sprinkle = ['s0', 's1', 's2']
    const out = interleaveEvenly(main, sprinkle)

    expect(out).toHaveLength(15)
    expect(new Set(out).size).toBe(15)
    const at = sprinkle.map(s => out.indexOf(s))
    // Neither the first nor the last slot, and no two adjacent.
    expect(Math.min(...at)).toBeGreaterThan(0)
    expect(Math.max(...at)).toBeLessThan(out.length - 1)
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThan(1)
  })

  it('handles either side being empty', () => {
    expect(interleaveEvenly(['a', 'b'], [])).toEqual(['a', 'b'])
    expect(interleaveEvenly([], ['x'])).toEqual(['x'])
  })

  it('loses nothing even when the sprinkle outnumbers the main list', () => {
    const out = interleaveEvenly(['m0'], ['s0', 's1', 's2', 's3'])
    expect(out).toHaveLength(5)
    expect(new Set(out).size).toBe(5)
  })
})

// ─── Building a day ───────────────────────────────────────────────────────────

describe('planCatchUpSession', () => {
  const TARGET = '2026-09-05'   // 14 days out

  it('serves every card due today plus one slice of the backlog', () => {
    const dueToday = band('t', 20, 3, 30)
    const overdue  = band('o', 140, 40, 30)
    const s = planCatchUpSession({ dueToday, overdue, targetDate: TARGET, today: TODAY })

    expect(s.fromToday).toBe(20)
    expect(s.fromBacklog).toBe(10)          // ceil(140 / 14)
    expect(s.queue).toHaveLength(30)
    // Nothing due today may be dropped — skipping it grows the backlog.
    for (const c of dueToday) expect(s.queue.map(q => q.key)).toContain(c.key)
  })

  it('caps relearning at a quarter of the session however deep the lapsed pool is', () => {
    // 700 long-gone cards over 14 days wants 50/day, but the quota is 20 + 50 = 70, so the cap is 17.
    const dueToday = band('t', 20, 3, 30)
    const overdue  = band('gone', 700, 400, 15)
    const s = planCatchUpSession({ dueToday, overdue, targetDate: TARGET, today: TODAY })

    expect(s.lapsedServed).toBeLessThanOrEqual(Math.floor(s.quota * MAX_LAPSED_SHARE))
    expect(s.lapsedCapped).toBe(true)
    expect(s.lapsedRemaining).toBe(700 - s.lapsedServed)
  })

  it('does not flag the cap when the lapsed pool drains comfortably', () => {
    const dueToday = band('t', 40, 3, 30)
    const overdue  = [...band('slip', 130, 12, 15), ...band('gone', 14, 400, 15)]
    const s = planCatchUpSession({ dueToday, overdue, targetDate: TARGET, today: TODAY })

    expect(s.lapsedCapped).toBe(false)
    expect(s.lapsedServed).toBe(1)          // ceil(14 / 14)
  })

  it('fills the backlog slice with about-to-slip cards, not the most forgotten ones', () => {
    const dueToday = band('t', 10, 3, 30)
    const overdue  = [...band('gone', 100, 400, 15), ...band('slip', 100, 12, 15)]
    const s = planCatchUpSession({ dueToday, overdue, targetDate: TARGET, today: TODAY })

    const served = new Set(s.queue.map(c => c.key))
    const slipServed = [...served].filter(k => k.startsWith('slip')).length
    const goneServed = [...served].filter(k => k.startsWith('gone')).length
    expect(slipServed).toBeGreaterThan(goneServed)
    expect(goneServed).toBe(s.lapsedServed)
  })

  it('sprinkles the relearning through the session rather than front-loading it', () => {
    const dueToday = band('t', 40, 3, 30)
    const overdue  = [...band('slip', 100, 12, 15), ...band('gone', 60, 400, 15)]
    const s = planCatchUpSession({ dueToday, overdue, targetDate: TARGET, today: TODAY })

    expect(s.lapsedServed).toBeGreaterThan(1)
    const at = s.queue
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.retrievability < LAPSED_R)
      .map(({ i }) => i)
    // Not all bunched into the opening stretch.
    expect(Math.max(...at)).toBeGreaterThan(s.queue.length / 2)
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThan(1)
  })

  it('serves the whole remaining backlog on the final day', () => {
    const dueToday = band('t', 5, 3, 30)
    const overdue  = band('o', 22, 40, 30)
    const s = planCatchUpSession({ dueToday, overdue, targetDate: TODAY, today: TODAY })
    expect(s.queue).toHaveLength(27)
  })

  it('handles an empty backlog', () => {
    const s = planCatchUpSession({ dueToday: band('t', 6, 3, 30), overdue: [], targetDate: TARGET, today: TODAY })
    expect(s.queue).toHaveLength(6)
    expect(s.lapsedServed).toBe(0)
    expect(s.lapsedCapped).toBe(false)
  })

  it('never returns a card twice', () => {
    const dueToday = band('t', 30, 3, 30)
    const overdue  = [...band('slip', 200, 12, 15), ...band('gone', 90, 400, 15)]
    const s = planCatchUpSession({ dueToday, overdue, targetDate: TARGET, today: TODAY })
    expect(new Set(s.queue.map(c => c.key)).size).toBe(s.queue.length)
  })
})

// ─── Preview ──────────────────────────────────────────────────────────────────

describe('previewCatchUp', () => {
  it('quotes arrivals plus the backlog slice, and the minutes that costs', () => {
    const p = previewCatchUp({ overdue: 1500, lapsed: 200, inflowPerDay: 190, days: 14, msPerAnswer: 15_000 })
    expect(p.fromBacklog).toBe(108)
    expect(p.fromInflow).toBe(190)
    expect(p.perDay).toBe(298)
    expect(p.minutesPerDay).toBeCloseTo((298 * 15_000) / 60_000, 5)
  })

  it('omits minutes when there is no measured pace', () => {
    expect(previewCatchUp({ overdue: 100, lapsed: 0, inflowPerDay: 10, days: 7 }).minutesPerDay).toBeNull()
  })

  it('reports the later finish when the comfort cap binds the lapsed tail', () => {
    // 900 long-gone cards in 14 days wants 65/day, but a quota of ~254 caps relearning at 63 — so the
    // tail lands after the target, and the picker has to say so up front.
    const p = previewCatchUp({ overdue: 1000, lapsed: 900, inflowPerDay: 180, days: 14 })
    expect(p.lapsedFinishesInDays).toBeGreaterThan(14)
  })

  it('reports no lapsed tail when there is none', () => {
    expect(previewCatchUp({ overdue: 500, lapsed: 0, inflowPerDay: 50, days: 10 }).lapsedFinishesInDays).toBe(0)
  })

  it('cannot claim more lapsed cards than there is backlog', () => {
    const p = previewCatchUp({ overdue: 10, lapsed: 999, inflowPerDay: 5, days: 5 })
    expect(p.lapsedFinishesInDays).toBeLessThanOrEqual(10)
  })
})

describe('isLapsed', () => {
  it('classifies on recall alone, independent of how long the plan runs', () => {
    // R = 0.9^(elapsed/S) has no window term, so the strata never shift when the target date moves.
    const gone = cand('gone', 400, 15)
    const slip = cand('slip', 12, 15)
    expect(isLapsed(gone)).toBe(true)
    expect(isLapsed(slip)).toBe(false)
    expect(metrics(gone, 3).retrievability).toBeCloseTo(metrics(gone, 90).retrievability, 10)
  })
})
