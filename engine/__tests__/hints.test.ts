import { hintPlan, hintGrowthFactor } from '@/lib/hints'
import { scheduleNext } from '../scheduler'
import type { CardState } from '@/domain'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-06-14T00:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS).toISOString()

function baseState(overrides: Partial<CardState> = {}): CardState {
  return {
    userId: 'u', cardId: 'c', pipelineId: 'p',
    currentStepOrder: 0, correctInStep: 0, graduated: true,
    dueAt: daysAgo(0), intervalDays: 10, scheduledIntervalDays: 10, ease: 2.5,
    reps: 5, lapses: 0, lastRating: 'good', lastReviewedAt: daysAgo(10),
    introducedDate: '2026-01-01', lapseClusterCount: 0, lastLapseAt: null,
    graduatedAt: daysAgo(30), relearningStep: 0, pendingIntervalDays: null,
    typedAccuracyWindow: [], typedReviewCount: 0, lastTypedReviewAt: null,
    forcedTypedRemaining: 0, intervalHistory: [], typingMistakeStreak: 0,
    typingFailCycles: 0, stage3EnteredDate: null, iDontKnowCount: 0,
    accentMistakeCount: 0, articleMistakeCount: 0, genderMistakeCount: 0,
    typoMistakeCount: 0, semanticMistakeCount: 0, wrongSynonymCount: 0,
    acceleratedMode: 'none', acceleratedLocked: false, acceleratedWrongStreak: 0,
    acceleratedPenalty: 0, postAccelRestartWindow: 0, postAccelWrongCount: 0,
    typedIntervalDays: null, typedDueAt: null, recallIntervalDays: null,
    recallDueAt: null, reviewDirection: 'forward',
    ...overrides,
  } as CardState
}

describe('hintPlan — alphabetic', () => {
  it('reveals first then first-two letters for a normal word', () => {
    const p = hintPlan('generalizando', 'es')
    expect(p.maxLevel).toBe(2)
    expect(p.isShortWord).toBe(false)
    expect(p.levelText).toEqual(['g', 'ge'])
  })

  it('includes a leading article but counts letters from the content word', () => {
    const p = hintPlan('el codo', 'es')
    expect(p.levelText).toEqual(['el c', 'el co'])
    expect(p.isShortWord).toBe(false)
  })

  it('works for Cyrillic', () => {
    const p = hintPlan('обобщаване', 'bg')
    expect(p.levelText[0]).toBe('о')
    expect(p.levelText[1]).toBe('об')
  })

  it('two-letter word gets a single (short) hint', () => {
    const p = hintPlan('tú', 'es')
    expect(p.maxLevel).toBe(1)
    expect(p.isShortWord).toBe(true)
    expect(p.levelText).toEqual(['t'])
  })

  it('one-letter word has no hint', () => {
    expect(hintPlan('a', 'es').maxLevel).toBe(0)
  })

  it('English infinitive "to pray" skips "to" → reveals p, pr', () => {
    const p = hintPlan('to pray', 'en')
    expect(p.levelText).toEqual(['p', 'pr'])
  })

  it('"to be creepy/disgusting" skips "to be" → reveals c, cr', () => {
    const p = hintPlan('to be creepy/disgusting', 'en')
    expect(p.levelText).toEqual(['c', 'cr'])
  })

  it('quoted phrase reveals the first real letter, not the quote', () => {
    const p = hintPlan('"to crumble / fall apart"', 'en')
    expect(p.levelText[0]).toBe('c')
  })

  it('"to" is only stripped for English answers', () => {
    // In a non-English answer, a leading "to" is a real word and stays.
    expect(hintPlan('to casa', 'es').levelText[0]).toBe('t')
  })
})

describe('hintPlan — Korean (full first syllable, one level only)', () => {
  it('안락 → reveals the full first syllable 안, one level', () => {
    const p = hintPlan('안락', 'ko')
    expect(p.maxLevel).toBe(1)
    expect(p.levelText).toEqual(['안'])
  })

  it('각시 → reveals 각 (full first syllable), one level', () => {
    const p = hintPlan('각시', 'ko')
    expect(p.maxLevel).toBe(1)
    expect(p.levelText).toEqual(['각'])
  })

  it('two-syllable word → one hint, isShortWord true (bigger penalty)', () => {
    const p = hintPlan('가방', 'ko')
    expect(p.maxLevel).toBe(1)
    expect(p.isShortWord).toBe(true)
    expect(p.levelText).toEqual(['가'])
  })

  it('three-syllable word → one hint, isShortWord false', () => {
    const p = hintPlan('사용자', 'ko')
    expect(p.maxLevel).toBe(1)
    expect(p.isShortWord).toBe(false)
    expect(p.levelText).toEqual(['사'])
  })

  it('single-syllable word (with final consonant) → NO hint', () => {
    expect(hintPlan('손', 'ko').maxLevel).toBe(0)
  })

  it('single-syllable word (no final consonant) → NO hint', () => {
    expect(hintPlan('차', 'ko').maxLevel).toBe(0)
  })
})

describe('hintGrowthFactor', () => {
  it('normal word: 0.65 then 0.40', () => {
    expect(hintGrowthFactor(1, false)).toBeCloseTo(0.65)
    expect(hintGrowthFactor(2, false)).toBeCloseTo(0.40)
  })
  it('short word: always 0.35', () => {
    expect(hintGrowthFactor(1, true)).toBeCloseTo(0.35)
  })
  it('no hint: 1 (no dampening)', () => {
    expect(hintGrowthFactor(0, false)).toBe(1)
  })
})

describe('scheduler hint dampening', () => {
  it('a hinted correct review grows less than an un-hinted one', () => {
    const s = baseState()
    const normal = scheduleNext(s, 'good', { now: NOW })
    const hinted = scheduleNext(s, 'good', { now: NOW, hintGrowthFactor: 0.4 })
    expect(hinted.intervalDays).toBeLessThan(normal.intervalDays)
    // Never shrinks below the current interval.
    expect(hinted.intervalDays).toBeGreaterThanOrEqual(s.intervalDays)
  })

  it('does NOT affect an "again" rating (no automatic penalty for hinting)', () => {
    const s = baseState()
    const normal = scheduleNext(s, 'again', { now: NOW })
    const hinted = scheduleNext(s, 'again', { now: NOW, hintGrowthFactor: 0.35 })
    expect(hinted.intervalDays).toBe(normal.intervalDays)
    expect(hinted.dueAt).toBe(normal.dueAt)
  })
})
