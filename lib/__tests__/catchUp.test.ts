import {
  LAPSED_R,
  scopeKey, daysBetween, addDays,
  candidateMetrics, elapsedDaysFor,
  assignBacklogDays, previewCatchUp, isLapsed, scopeDirection,
  type CatchUpCandidate,
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
})

describe('scopeDirection', () => {
  // Pair key is `${learned}|${native}` — bg|en means "learning Bulgarian, native English".
  const BG = 'bg', EN = 'en'

  it('reads native → learned for typing, because production is prompted in your own language', () => {
    // The bug this exists to prevent: labelling a Bulgarian typing review "Bulgarian → English" when
    // the prompt is English and you type Bulgarian.
    expect(scopeDirection(BG, EN, 'typing')).toEqual({ from: EN, to: BG, bidirectional: false })
  })

  it('reads native → learned for self-graded forward production too', () => {
    expect(scopeDirection(BG, EN, 'sgForward')).toEqual({ from: EN, to: BG, bidirectional: false })
  })

  it('reads learned → native for reverse recognition', () => {
    expect(scopeDirection(BG, EN, 'sgReverse')).toEqual({ from: BG, to: EN, bidirectional: false })
  })

  it('marks a whole-language scope bidirectional, since it covers both', () => {
    expect(scopeDirection(BG, EN, null).bidirectional).toBe(true)
  })

  it('holds for a pair whose native language is not English', () => {
    expect(scopeDirection('es', 'fr', 'typing')).toEqual({ from: 'fr', to: 'es', bidirectional: false })
    expect(scopeDirection('es', 'fr', 'sgReverse')).toEqual({ from: 'es', to: 'fr', bidirectional: false })
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

// ─── Spreading the backlog ────────────────────────────────────────────────────

describe('assignBacklogDays', () => {
  it('gives every overdue card a day inside the window', () => {
    const overdue = band('o', 140, 40, 30)
    const r = assignBacklogDays({ overdue, today: TODAY, days: 14 })

    expect(r.assignments.size).toBe(140)
    expect(r.days).toHaveLength(14)
    expect(r.days[0]).toBe(TODAY)                       // starts today — the backlog is due NOW
    for (const day of r.assignments.values()) expect(r.days).toContain(day)
    expect([...r.perDay.values()].reduce((a, b) => a + b, 0)).toBe(140)
  })

  it('spreads evenly when nothing is already scheduled', () => {
    const r = assignBacklogDays({ overdue: band('o', 140, 40, 30), today: TODAY, days: 14 })
    const counts = [...r.perDay.values()]
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  it('pours the backlog into the gaps rather than flat on top of existing load', () => {
    // A day already carrying 200 arrivals must take less backlog than an empty one, or the "Coming
    // up" chart stays as spiky as before.
    const existingLoad = new Map([[TODAY, 0], [addDays(TODAY, 1), 200], [addDays(TODAY, 2), 0]])
    const r = assignBacklogDays({ overdue: band('o', 90, 40, 30), today: TODAY, days: 3, existingLoad })

    expect(r.perDay.get(addDays(TODAY, 1))!).toBeLessThan(r.perDay.get(TODAY)!)
    expect(r.assignments.size).toBe(90)
  })

  it('assigns nothing to a day that is already busier than the levelled total', () => {
    const existingLoad = new Map([[TODAY, 500], [addDays(TODAY, 1), 0]])
    const r = assignBacklogDays({ overdue: band('o', 20, 40, 30), today: TODAY, days: 2, existingLoad })
    expect(r.perDay.get(TODAY)).toBe(0)
    expect(r.perDay.get(addDays(TODAY, 1))).toBe(20)
  })

  it('puts the cards that lose most by waiting on the earliest days', () => {
    const overdue = [
      ...band('slip', 14, 12, 15),    // fragile, still mostly remembered → highest deferral damage
      ...band('solid', 14, 5, 300),   // rock solid → loses almost nothing by waiting
    ]
    const r = assignBacklogDays({ overdue, today: TODAY, days: 14 })
    const dayOf = (k: string) => r.days.indexOf(r.assignments.get(k)!)
    const avg = (p: string) => [...r.assignments.keys()].filter(k => k.startsWith(p))
      .reduce((t, k) => t + dayOf(k), 0) / 14

    expect(avg('slip')).toBeLessThan(avg('solid'))
  })

  it('spreads deeply lapsed cards across every day instead of blocking them together', () => {
    const overdue = [...band('slip', 140, 12, 15), ...band('gone', 28, 400, 15)]
    const r = assignBacklogDays({ overdue, today: TODAY, days: 14 })

    const lapsedDays = new Set(
      [...r.assignments.entries()].filter(([k]) => k.startsWith('gone')).map(([, d]) => d))
    expect(r.lapsedCount).toBe(28)
    // Present on most days rather than piled onto two or three.
    expect(lapsedDays.size).toBeGreaterThanOrEqual(10)
  })

  it('still places a lapsed pool smaller than the window, one day at a time', () => {
    // Fractional accumulation matters here: rounding 3/14 to zero per day would dump all three on
    // the final day.
    const r = assignBacklogDays({
      overdue: [...band('slip', 70, 12, 15), ...band('gone', 3, 400, 15)], today: TODAY, days: 14,
    })
    const lapsedDays = [...r.assignments.entries()].filter(([k]) => k.startsWith('gone')).map(([, d]) => d)
    expect(lapsedDays).toHaveLength(3)
    expect(new Set(lapsedDays).size).toBe(3)
  })

  it('flags when the lapsed pool is too big to spread comfortably', () => {
    const r = assignBacklogDays({ overdue: band('gone', 140, 400, 15), today: TODAY, days: 14 })
    expect(r.lapsedCapped).toBe(true)
    expect(r.assignments.size).toBe(140)   // flagged, never dropped
  })

  it('puts everything on today when the window is a single day', () => {
    const r = assignBacklogDays({ overdue: band('o', 25, 40, 30), today: TODAY, days: 1 })
    expect(r.perDay.get(TODAY)).toBe(25)
  })

  it('handles an empty backlog', () => {
    const r = assignBacklogDays({ overdue: [], today: TODAY, days: 14 })
    expect(r.assignments.size).toBe(0)
    expect(r.lapsedCapped).toBe(false)
  })

  it('never assigns a card twice', () => {
    const overdue = [...band('slip', 200, 12, 15), ...band('gone', 90, 400, 15)]
    const r = assignBacklogDays({ overdue, today: TODAY, days: 21 })
    expect(r.assignments.size).toBe(290)
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
