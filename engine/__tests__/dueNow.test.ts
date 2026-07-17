import type { TypedStrictness } from '@/domain'
import { reviewDueNow, gradeFromTyped, scheduleGraduatedFsrs, seedDifficulty, seedStability, RELEARN_MINUTES, type DueNowState } from '@/engine/dueNow'

const clean = (over: Partial<DueNowState> = {}): DueNowState =>
  ({ difficulty: 5, stability: 10, relearning: false, goodStreak: 0, againStreak: 0, ...over })

describe('reviewDueNow — clean card', () => {
  it('Good/Easy advance; Hard advances too (just slower growth)', () => {
    for (const g of ['hard', 'good', 'easy'] as const) {
      const r = reviewDueNow(clean(), g, 10)
      expect(r.action.kind).toBe('schedule')
      expect(r.state.relearning).toBe(false)
    }
    const hard = reviewDueNow(clean(), 'hard', 10)
    const good = reviewDueNow(clean(), 'good', 10)
    if (hard.action.kind === 'schedule' && good.action.kind === 'schedule') {
      expect(hard.action.intervalDays).toBeLessThan(good.action.intervalDays)  // Hard grows slower
    }
  })

  it('Again drops into the relearn loop (5 min) and raises difficulty', () => {
    const r = reviewDueNow(clean(), 'again', 10)
    expect(r.action).toEqual({ kind: 'relearn', minutes: RELEARN_MINUTES.again })
    expect(r.state.relearning).toBe(true)
    expect(r.state.difficulty).toBeCloseTo(6.8)   // 5+2, mean-reverted 0.1 toward baseline
    expect(r.state.stability).toBeLessThan(10)
  })
})

describe('reviewDueNow — the relearn gate', () => {
  const relearning = (over: Partial<DueNowState> = {}) => clean({ relearning: true, ...over })

  it('Hard keeps you in a 10-min loop and never advances or resets', () => {
    const r = reviewDueNow(relearning(), 'hard', 0.01)
    expect(r.action).toEqual({ kind: 'relearn', minutes: RELEARN_MINUTES.hard })
    expect(r.state.relearning).toBe(true)
  })

  it('needs two Goods IN A ROW to escape (first Good = 20-min loop)', () => {
    const first = reviewDueNow(relearning(), 'good', 0.01)
    expect(first.action).toEqual({ kind: 'relearn', minutes: RELEARN_MINUTES.good })
    expect(first.state.goodStreak).toBe(1)
    const second = reviewDueNow(first.state, 'good', 0.01)
    expect(second.action.kind).toBe('schedule')
    expect(second.state.relearning).toBe(false)
  })

  it('a Hard between Goods resets the streak', () => {
    const g1 = reviewDueNow(relearning(), 'good', 0.01)
    const h  = reviewDueNow(g1.state, 'hard', 0.01)
    expect(h.state.goodStreak).toBe(0)
    expect(reviewDueNow(h.state, 'good', 0.01).action.kind).toBe('relearn')  // needs 2 again
  })

  it('Easy escapes immediately', () => {
    const r = reviewDueNow(relearning(), 'easy', 0.01)
    expect(r.action.kind).toBe('schedule')
    expect(r.state.relearning).toBe(false)
  })

  it('three Agains in a row sends the card back to the ladder', () => {
    let s = relearning({ againStreak: 1 })
    const a2 = reviewDueNow(s, 'again', 0.01)
    expect(a2.action.kind).toBe('relearn')
    const a3 = reviewDueNow(a2.state, 'again', 0.01)
    expect(a3.action.kind).toBe('sendToLadder')
  })
})

describe('gradeFromTyped', () => {
  const strict:  TypedStrictness = { spelling: 'penalize', accents: 'penalize', articles: 'penalize' }
  const middle:  TypedStrictness = { spelling: 'retype',   accents: 'retype',   articles: 'retype' }
  const lenient: TypedStrictness = { spelling: 'accept',   accents: 'accept',   articles: 'accept' }

  it('a wrong word is always Again', () => {
    expect(gradeFromTyped({ status: 'wrong', slip: null, strictness: lenient, chosen: 'good' })).toBe('again')
  })
  it('a slip: strict → Again, middle → Hard, lenient → the chosen rating', () => {
    expect(gradeFromTyped({ status: 'almost', slip: 'accent', strictness: strict,  chosen: 'good' })).toBe('again')
    expect(gradeFromTyped({ status: 'almost', slip: 'accent', strictness: middle,  chosen: 'good' })).toBe('hard')
    expect(gradeFromTyped({ status: 'almost', slip: 'accent', strictness: lenient, chosen: 'easy' })).toBe('easy')
  })
  it('a clean answer uses the chosen rating', () => {
    expect(gradeFromTyped({ status: 'correct', slip: null, strictness: strict, chosen: 'easy' })).toBe('easy')
  })
})

describe('scheduleGraduatedFsrs', () => {
  const cur = { difficulty: null, stability: null, intervalDays: 20, lapses: 3, relearning: false, goodStreak: 0, againStreak: 0, elapsedDays: 20 }
  it('seeds D/S for a pre-FSRS card (D from lapses, S from interval)', () => {
    expect(seedDifficulty(3)).toBeCloseTo(7.1)
    expect(seedStability(20)).toBe(20)
  })
  it('a Good schedules a longer interval', () => {
    const out = scheduleGraduatedFsrs(cur, 'good')
    expect(out.intervalDays).not.toBeNull()
    expect(out.intervalDays!).toBeGreaterThan(20)
    expect(out.relearning).toBe(false)
  })
  it('an Again enters the relearn loop (dueInMinutes set, no interval)', () => {
    const out = scheduleGraduatedFsrs(cur, 'again')
    expect(out.dueInMinutes).toBe(RELEARN_MINUTES.again)
    expect(out.intervalDays).toBeNull()
    expect(out.relearning).toBe(true)
  })
})

describe('reviewDueNow — near-miss (softLapse) does not un-graduate', () => {
  const relearning = (againStreak: number) => ({ difficulty: 5, stability: 2, relearning: true, goodStreak: 0, againStreak })

  it('a full-wrong Again x3 in the relearn loop sends the card back to the ladder', () => {
    let s = relearning(2)
    const r = reviewDueNow(s, 'again', 1)   // 3rd full wrong
    expect(r.action).toEqual({ kind: 'sendToLadder' })
  })

  it('a near-miss Again does NOT increment the counter — never reaches sendToLadder', () => {
    // Sitting at 2 full-wrongs, a near-miss must not tip it to 3.
    const soft = reviewDueNow(relearning(2), 'again', 1, undefined, { softLapse: true })
    expect(soft.action).toEqual({ kind: 'relearn', minutes: RELEARN_MINUTES.again })
    expect(soft.state.againStreak).toBe(2)   // unchanged, not 3
    expect(soft.state.relearning).toBe(true)

    // Even many near-misses in a row never un-graduate.
    let st = { difficulty: 5, stability: 2, relearning: false, goodStreak: 0, againStreak: 0 }
    for (let i = 0; i < 10; i++) {
      const r = reviewDueNow(st, 'again', 1, undefined, { softLapse: true })
      expect(r.action).not.toEqual({ kind: 'sendToLadder' })
      st = r.state
    }
    expect(st.againStreak).toBe(0)
  })
})
