import {
  retrievability, intervalForRetention, nextDifficulty, initialDifficulty,
  initialStability, stabilityAfterSuccess, stabilityAfterLapse, reviewCard,
  DIFFICULTY_DELTA, BASE_DIFFICULTY, fsrsFuzzRange, type FsrsState,
} from '@/engine/fsrs'

describe('fsrsFuzzRange', () => {
  it('does not fuzz very short intervals', () => {
    expect(fsrsFuzzRange(1)).toEqual([1, 1])
    expect(fsrsFuzzRange(2)).toEqual([2, 2])
  })
  it('widens by ~5% (at least a day) and stays >= 1', () => {
    expect(fsrsFuzzRange(7)).toEqual([6, 8])       // ±1
    expect(fsrsFuzzRange(30)).toEqual([28, 32])    // ±round(1.5)=±2
    expect(fsrsFuzzRange(100)).toEqual([95, 105])  // ±5
    const [min] = fsrsFuzzRange(3)
    expect(min).toBeGreaterThanOrEqual(1)
  })
})

describe('retrievability', () => {
  it('is 1 right after review, 0.9 at one stability, and decays further with time', () => {
    expect(retrievability(0, 10)).toBe(1)
    expect(retrievability(10, 10)).toBeCloseTo(0.9)
    expect(retrievability(20, 10)).toBeCloseTo(0.81)
    expect(retrievability(5, 10)).toBeGreaterThan(0.9)
  })
})

describe('intervalForRetention', () => {
  it('≈ stability at 90%, longer at lower retention, shorter at higher', () => {
    expect(intervalForRetention(10, 0.9)).toBeCloseTo(10)
    expect(intervalForRetention(10, 0.8)).toBeCloseTo(21.2, 0)   // ~2.12× S
    expect(intervalForRetention(10, 0.95)).toBeCloseTo(4.87, 1)  // ~0.49× S
  })
  it('lower retention target always gives a longer interval', () => {
    expect(intervalForRetention(10, 0.8)).toBeGreaterThan(intervalForRetention(10, 0.95))
  })
})

describe('difficulty', () => {
  it('deltas: Again +2, Hard +0.6, Good 0, Easy −2', () => {
    expect(DIFFICULTY_DELTA).toEqual({ again: 2.0, hard: 0.6, good: 0, easy: -2.0 })
  })
  it('updates cumulatively and clamps to 1–10', () => {
    expect(nextDifficulty(5, 'again')).toBe(7)
    expect(nextDifficulty(5, 'easy')).toBe(3)
    expect(nextDifficulty(9.5, 'again')).toBe(10)   // clamp high
    expect(nextDifficulty(2, 'easy')).toBe(1)       // clamp low
  })
  it('initializes from the whole learning history', () => {
    expect(initialDifficulty([])).toBe(BASE_DIFFICULTY)                       // 5
    expect(initialDifficulty(['again', 'hard', 'good', 'good'])).toBeCloseTo(7.6)
    expect(initialDifficulty(['easy'])).toBe(3)
  })
})

describe('initialStability', () => {
  it('rises with the graduating grade: again < hard < good < easy', () => {
    const s = (g: Parameters<typeof initialStability>[0]) => initialStability(g)
    expect(s('again')).toBeLessThan(s('hard'))
    expect(s('hard')).toBeLessThan(s('good'))
    expect(s('good')).toBeLessThan(s('easy'))
  })
})

describe('stabilityAfterSuccess', () => {
  const state: FsrsState = { difficulty: 5, stability: 10 }
  it('always increases stability', () => {
    expect(stabilityAfterSuccess(state, 'good', 10)).toBeGreaterThan(10)
  })
  it('Easy grows more than Good, Good more than Hard', () => {
    const hard = stabilityAfterSuccess(state, 'hard', 10)
    const good = stabilityAfterSuccess(state, 'good', 10)
    const easy = stabilityAfterSuccess(state, 'easy', 10)
    expect(hard).toBeLessThan(good)
    expect(good).toBeLessThan(easy)
  })
  it('a harder card grows less', () => {
    const easyCard = stabilityAfterSuccess({ difficulty: 2, stability: 10 }, 'good', 10)
    const hardCard = stabilityAfterSuccess({ difficulty: 9, stability: 10 }, 'good', 10)
    expect(hardCard).toBeLessThan(easyCard)
  })
  it('reviewing later (lower retrievability) grows stability more', () => {
    const early = stabilityAfterSuccess(state, 'good', 5)   // R high
    const late  = stabilityAfterSuccess(state, 'good', 15)  // R low
    expect(late).toBeGreaterThan(early)
  })
})

describe('stabilityAfterLapse', () => {
  it('never increases stability, and harder cards fall further', () => {
    const easyCard = stabilityAfterLapse({ difficulty: 2, stability: 30 }, 30)
    const hardCard = stabilityAfterLapse({ difficulty: 9, stability: 30 }, 30)
    expect(easyCard).toBeLessThanOrEqual(30)
    expect(hardCard).toBeLessThan(easyCard)
  })
})

describe('reviewCard', () => {
  const state: FsrsState = { difficulty: 5, stability: 10 }
  it('a Good raises stability and leaves difficulty put', () => {
    const r = reviewCard(state, 'good', 10)
    expect(r.stability).toBeGreaterThan(10)
    expect(r.difficulty).toBe(5)
    expect(r.intervalDays).toBeCloseTo(r.stability)   // at default 90% retention
  })
  it('an Again drops stability and raises difficulty', () => {
    const r = reviewCard(state, 'again', 10)
    expect(r.stability).toBeLessThan(10)
    expect(r.difficulty).toBe(7)
  })
  it('an Easy graduates to a longer interval than a Good would', () => {
    const good = reviewCard(state, 'good', 10)
    const easy = reviewCard(state, 'easy', 10)
    expect(easy.intervalDays).toBeGreaterThan(good.intervalDays)
  })
})
