import { cappedInterval, earnedStrength, finalStageRating, pendingBoosts, stagesForDirection, STAGE_STRENGTH, type StageKind } from '../program'

describe('program strength math', () => {
  it('earnedStrength is the max over the cleared prefix', () => {
    const stages: StageKind[] = ['matching', 'cloze', 'typed']
    expect(earnedStrength(stages, 0)).toBe(0)
    expect(earnedStrength(stages, 1)).toBe(0.4)
    expect(earnedStrength(stages, 2)).toBe(0.75)
    expect(earnedStrength(stages, 3)).toBe(1)
    // A weaker stage later never loses strength already earned.
    expect(earnedStrength(['recall', 'matching'], 2)).toBe(1)
  })

  it('cappedInterval moves toward the full interval by strength, grow-only', () => {
    expect(cappedInterval(10, 30, 1)).toBe(30)
    expect(cappedInterval(10, 30, 0.4)).toBe(18)       // 10 + 0.4·20
    expect(cappedInterval(10, 30, 0)).toBe(10)
    expect(cappedInterval(10, 5, 1)).toBe(10)          // full below old → never shrinks
    expect(cappedInterval(0.5, 2, 0.4)).toBeGreaterThanOrEqual(1)
  })

  it('finalStageRating: matching = Good; graded stages pass through, again never', () => {
    expect(finalStageRating('matching', null)).toBe('good')
    expect(finalStageRating('recall', 'easy')).toBe('easy')
    expect(finalStageRating('typed', 'hard')).toBe('hard')
    expect(finalStageRating('recall', 'again')).toBe('good')
  })

  it('direction palettes: production gets all stages, recognition skips the production-flavored', () => {
    expect(stagesForDirection('production')).toEqual(['matching', 'cloze', 'recall', 'typed'])
    expect(stagesForDirection('recognition')).toEqual(['matching', 'recall'])
    expect(STAGE_STRENGTH.matching).toBeLessThan(STAGE_STRENGTH.cloze)
    expect(STAGE_STRENGTH.cloze).toBeLessThan(STAGE_STRENGTH.recall)
  })

  it('pendingBoosts: progressed, not credited, not locked', () => {
    expect(pendingBoosts({
      a: { cleared: 1 },
      b: { cleared: 2, done: 'credited' },
      c: { cleared: 1, done: 'locked' },
      d: { cleared: 0 },
    })).toEqual([{ cardId: 'a', cleared: 1 }])
  })
})
