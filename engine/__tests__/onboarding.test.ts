import { ONBOARD_BANDS, onboardMemoryState, bandWindow, bandGraduates } from '../onboarding'
import { intervalForRetention, initialDifficulty, BASE_DIFFICULTY } from '../fsrs'
import { claimSpreadDay, onboardDueIso } from '../density'

describe('onboarding bands', () => {
  it('band 1 does not graduate; 2-4 do', () => {
    expect(bandGraduates(1)).toBe(false)
    expect(bandGraduates(2)).toBe(true)
    expect(bandGraduates(3)).toBe(true)
    expect(bandGraduates(4)).toBe(true)
  })

  it('centres on a week, a month and ~six months', () => {
    expect(ONBOARD_BANDS[2].center).toBe(7)
    expect(ONBOARD_BANDS[3].center).toBe(30)
    expect(ONBOARD_BANDS[4].center).toBe(180)
  })

  it('windows do not overlap, so a higher band is never seen sooner', () => {
    expect(ONBOARD_BANDS[2].max).toBeLessThan(ONBOARD_BANDS[3].min)
    expect(ONBOARD_BANDS[3].max).toBeLessThan(ONBOARD_BANDS[4].min)
  })

  it('every window contains its centre', () => {
    for (const band of [2, 3, 4] as const) {
      const w = bandWindow(band)
      expect(w.min).toBeLessThanOrEqual(ONBOARD_BANDS[band].center)
      expect(w.max).toBeGreaterThanOrEqual(ONBOARD_BANDS[band].center)
    }
  })
})

describe('onboardMemoryState', () => {
  it('seeds stability so the assigned day IS the scheduled interval', () => {
    for (const days of [3, 7, 30, 180, 234]) {
      const { stability } = onboardMemoryState(3, days, 0.9)
      expect(intervalForRetention(stability, 0.9)).toBeCloseTo(days, 5)
    }
  })

  it('respects the pair target retention rather than assuming 0.9', () => {
    const { stability } = onboardMemoryState(3, 30, 0.85)
    expect(intervalForRetention(stability, 0.85)).toBeCloseTo(30, 5)
    // A lower retention target means the same 30 days is explained by LESS stability.
    expect(stability).toBeLessThan(onboardMemoryState(3, 30, 0.95).stability)
  })

  it('uses the assigned day, not the band centre', () => {
    const early = onboardMemoryState(4, 126, 0.9)
    const late  = onboardMemoryState(4, 234, 0.9)
    expect(late.stability).toBeGreaterThan(early.stability)
  })

  it('grades confidence into difficulty: band 2 hardest, band 4 easiest', () => {
    const d2 = onboardMemoryState(2, 7,   0.9).difficulty
    const d3 = onboardMemoryState(3, 30,  0.9).difficulty
    const d4 = onboardMemoryState(4, 180, 0.9).difficulty
    expect(d2).toBeGreaterThan(d3)
    expect(d3).toBeGreaterThan(d4)
    // Anchored to the same scale the ladder graduates on.
    expect(d2).toBeCloseTo(initialDifficulty(['hard']), 10)
    expect(d3).toBeCloseTo(BASE_DIFFICULTY, 10)
    expect(d4).toBeCloseTo(initialDifficulty(['easy']), 10)
  })
})

describe('claimSpreadDay', () => {
  const window3 = { ...bandWindow(3), center: ONBOARD_BANDS[3].center }

  it('puts the first card on the band centre when nothing is scheduled', () => {
    expect(claimSpreadDay(new Map(), window3)).toBe(30)
  })

  it('mutates the load map so consecutive claims spread instead of stacking', () => {
    const load = new Map<number, number>()
    const days = Array.from({ length: 5 }, () => claimSpreadDay(load, window3))
    expect(new Set(days).size).toBe(5)
  })

  it('never leaves the band window', () => {
    const load = new Map<number, number>()
    for (let i = 0; i < 500; i++) {
      const d = claimSpreadDay(load, window3)
      expect(d).toBeGreaterThanOrEqual(window3.min)
      expect(d).toBeLessThanOrEqual(window3.max)
    }
  })

  it('a big import fills the whole window rather than piling on the centre', () => {
    const load = new Map<number, number>()
    const counts = new Map<number, number>()
    for (let i = 0; i < 310; i++) {
      const d = claimSpreadDay(load, window3)
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    // Every day in the 31-day window used, and no day carrying a runaway share.
    expect(counts.size).toBe(31)
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(11)
  })

  it('routes around days that are already busy', () => {
    const load = new Map<number, number>([[30, 50]])
    expect(claimSpreadDay(load, window3)).not.toBe(30)
  })

  it('respects a narrow band window too', () => {
    const window2 = { ...bandWindow(2), center: ONBOARD_BANDS[2].center }
    const load = new Map<number, number>()
    for (let i = 0; i < 100; i++) {
      const d = claimSpreadDay(load, window2)
      expect(d).toBeGreaterThanOrEqual(3)
      expect(d).toBeLessThanOrEqual(11)
    }
  })
})

describe('onboardDueIso', () => {
  it('is the start date plus the offset, at mid-day UTC', () => {
    const start = new Date('2026-07-30T09:15:00.000Z')
    expect(onboardDueIso(start, 7)).toBe('2026-08-06T12:00:00.000Z')
    expect(onboardDueIso(start, 180)).toBe('2027-01-26T12:00:00.000Z')
  })
})
