import { assignBacklogDays, isLapsed, type CatchUpCandidate } from '@/lib/catchUp'

/**
 * A sanity check against the reported real backlog rather than tidy fixtures: ~1,500 overdue Spanish
 * self-graded reviews on a dashboard whose next fortnight already carries 114–249 arrivals a day.
 */
const TODAY = '2026-08-22'
const EXISTING = [186, 199, 249, 208, 161, 132, 171, 160, 141, 137, 138, 167, 114, 150]

function realisticBacklog(n: number): CatchUpCandidate[] {
  const out: CatchUpCandidate[] = []
  for (let i = 0; i < n; i++) {
    // A spread of stabilities and lateness, with a long-forgotten tail — mirrors "521 behind,
    // 15 deeply lapsed": most of a backlog is recoverable, a minority is not.
    const stability = 3 + (i % 40) * 4
    const elapsed   = i % 17 === 0 ? 200 + (i % 120) : stability * (0.4 + (i % 9) / 10)
    out.push({ key: `c${i}`, elapsedDays: elapsed, stability })
  }
  return out
}

describe('spreading a realistic backlog', () => {
  const overdue = realisticBacklog(1500)
  const existingLoad = new Map(EXISTING.map((n, i) => [
    new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + i * 86_400_000).toISOString().slice(0, 10), n,
  ]))

  it('places every card and leaves no day wildly heavier than the rest', () => {
    const r = assignBacklogDays({ overdue, today: TODAY, days: 14, existingLoad })
    expect(r.assignments.size).toBe(1500)

    const totals = r.days.map(d => (existingLoad.get(d) ?? 0) + (r.perDay.get(d) ?? 0))
    // The point of levelling: after the spread, no day is more than ~15% above the mean.
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length
    expect(Math.max(...totals)).toBeLessThan(mean * 1.15)
    // And the 1699-on-one-day spike is gone.
    expect(Math.max(...totals)).toBeLessThan(400)
  })

  it('front-loads recoverable cards and leaves the long-forgotten tail spread out', () => {
    const r = assignBacklogDays({ overdue, today: TODAY, days: 14, existingLoad })
    const lapsedKeys = new Set(overdue.filter(isLapsed).map(c => c.key))
    expect(lapsedKeys.size).toBeGreaterThan(0)

    const lapsedDays = new Set([...r.assignments.entries()]
      .filter(([k]) => lapsedKeys.has(k)).map(([, d]) => d))
    expect(lapsedDays.size).toBeGreaterThanOrEqual(10)

    // No single day is mostly relearning.
    for (const day of r.days) {
      const onDay = [...r.assignments.entries()].filter(([, d]) => d === day)
      const lapsedOnDay = onDay.filter(([k]) => lapsedKeys.has(k)).length
      expect(lapsedOnDay).toBeLessThanOrEqual(Math.max(1, Math.ceil(onDay.length * 0.35)))
    }
  })

  it('a 3-day target is brutal but still valid — every card placed, evenly', () => {
    const r = assignBacklogDays({ overdue, today: TODAY, days: 3, existingLoad })
    expect(r.assignments.size).toBe(1500)
    const counts = r.days.map(d => r.perDay.get(d) ?? 0)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1500)
    expect(Math.min(...counts)).toBeGreaterThan(0)
  })
})
