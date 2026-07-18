import type { Rung } from '@/domain'
import { rungReshowMs, rungIsSingleStep, DEFAULT_WRONG_WAIT_SECONDS, DEFAULT_CORRECT_WAIT_SECONDS } from '@/lib/ladderSession'

const rung = (over: Partial<Rung>): Rung => ({
  id: 'r', type: 'typing', direction: 'produce_target',
  selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [], ...over,
})
const GLOBAL = 180 // 3 min

describe('rungIsSingleStep', () => {
  it('true when a single correct advances (advanceTimes 1)', () => {
    expect(rungIsSingleStep(rung({ advanceTimes: 1 }))).toBe(true)
  })
  it('false when several correct are required', () => {
    expect(rungIsSingleStep(rung({ advanceTimes: 4 }))).toBe(false)
  })
  it('reads advanceRules when present', () => {
    expect(rungIsSingleStep(rung({ advanceRules: [{ times: 4, inARow: true }] }))).toBe(false)
    expect(rungIsSingleStep(rung({ advanceRules: [{ times: 3, inARow: true }, { times: 1, inARow: false }] }))).toBe(true)
  })
})

describe('rungReshowMs — auto-checked rungs', () => {
  it('defaults: wrong = 1 min, correct = 6 min', () => {
    const r = rung({ advanceTimes: 4 }) // multi-step
    expect(rungReshowMs(r, { reshow: 'soon', advanced: false }, GLOBAL)).toBe(DEFAULT_WRONG_WAIT_SECONDS * 1000)
    expect(rungReshowMs(r, { reshow: 'medium', advanced: false }, GLOBAL)).toBe(DEFAULT_CORRECT_WAIT_SECONDS * 1000)
  })

  it('honors custom wrong/correct waits', () => {
    const r = rung({ advanceTimes: 4, wrongWaitSeconds: 30, correctWaitSeconds: 120 })
    expect(rungReshowMs(r, { reshow: 'soon', advanced: false }, GLOBAL)).toBe(30_000)
    expect(rungReshowMs(r, { reshow: 'medium', advanced: false }, GLOBAL)).toBe(120_000)
  })

  it('single-step advance uses the correct wait, overriding the global gap', () => {
    const r = rung({ advanceTimes: 1, correctWaitSeconds: 300 })
    expect(rungReshowMs(r, { reshow: 'advanced', advanced: true }, GLOBAL)).toBe(300_000)
  })

  it('multi-step advance uses the global between-rungs gap', () => {
    const r = rung({ advanceTimes: 4, correctWaitSeconds: 300 })
    expect(rungReshowMs(r, { reshow: 'advanced', advanced: true }, GLOBAL)).toBe(GLOBAL * 1000)
  })

  it('a drop-back (advanced but not "advanced" reshow) uses the wrong wait', () => {
    const r = rung({ advanceTimes: 4, wrongWaitSeconds: 45 })
    expect(rungReshowMs(r, { reshow: 'soon', advanced: true }, GLOBAL)).toBe(45_000)
  })
})

describe('rungReshowMs — self-rated rungs keep rating windows', () => {
  it('advance → global gap; otherwise the rating-based delay', () => {
    const r = rung({ selfRated: true, type: 'self_graded' })
    expect(rungReshowMs(r, { reshow: 'advanced', advanced: true }, GLOBAL)).toBe(GLOBAL * 1000)
    expect(rungReshowMs(r, { reshow: 'soon', advanced: false }, GLOBAL)).toBe(60_000)   // reshowDelayMs('soon')
    expect(rungReshowMs(r, { reshow: 'medium', advanced: false }, GLOBAL)).toBe(600_000) // reshowDelayMs('medium')
  })
})
