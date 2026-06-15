import { progressAfterReview, initialCardState } from '../pipeline'
import type { CardState, Pipeline } from '@/domain'

const PIPELINE: Pipeline = {
  id: 'pipeline-1', ownerId: null, name: 'Default', isDefault: true,
  steps: [
    { pipelineId: 'pipeline-1', stepOrder: 0, stepType: 'recognition', promptSide: 'front', answerSide: 'back',  requiredCorrect: 1 },
    { pipelineId: 'pipeline-1', stepOrder: 1, stepType: 'recognition', promptSide: 'back',  answerSide: 'front', requiredCorrect: 1 },
    { pipelineId: 'pipeline-1', stepOrder: 2, stepType: 'typing',      promptSide: 'back',  answerSide: 'front', requiredCorrect: 2 },
  ],
}

function fresh(): CardState { return initialCardState('user-1', 'card-1', 'pipeline-1') }

describe('pre-graduation', () => {
  it('advances to step 1 after 1 correct on step 0', () => {
    const next = progressAfterReview(fresh(), PIPELINE, { wasCorrect: true, rating: 'good' })
    expect(next.currentStepOrder).toBe(1)
    expect(next.graduated).toBe(false)
  })

  it('stays on step 0 after a wrong answer', () => {
    const next = progressAfterReview(fresh(), PIPELINE, { wasCorrect: false, rating: 'again' })
    expect(next.currentStepOrder).toBe(0)
  })

  it('stays on step 0 after "hard"', () => {
    const next = progressAfterReview(fresh(), PIPELINE, { wasCorrect: true, rating: 'hard' })
    expect(next.currentStepOrder).toBe(0)
  })

  it('accumulates correct count when requiredCorrect > 1', () => {
    let s = fresh()
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    expect(s.currentStepOrder).toBe(2)
    expect(s.correctInStep).toBe(1)
    expect(s.graduated).toBe(false)
  })

  it('graduates after completing all steps', () => {
    let s = fresh()
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    expect(s.graduated).toBe(true)
    expect(s.dueAt).not.toBeNull()
  })

  it('resets correctInStep after wrong answer mid-step', () => {
    let s = fresh()
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: false, rating: 'again' })
    expect(s.correctInStep).toBe(0)
    expect(s.graduated).toBe(false)
  })
})

describe('post-graduation', () => {
  function graduated(): CardState {
    let s = fresh()
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    return s
  }

  it('increments lapses on "again"', () => {
    const next = progressAfterReview(graduated(), PIPELINE, { wasCorrect: false, rating: 'again' })
    expect(next.lapses).toBe(1)
    expect(next.graduated).toBe(true)
  })

  it('advances reps on good review', () => {
    const s = graduated()
    // A review immediately after graduation (elapsed ~0) is "very early"
    // (progress < 0.30 of the 3-day post-good interval) and is a no-op by
    // design (see scheduler.ts VERY_EARLY_THRESHOLD) — so push `now` past
    // that threshold to exercise the normal "reps increments" path.
    const later = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const next = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' }, later)
    expect(next.reps).toBeGreaterThan(s.reps)
  })

  it('sends the card back to the learning pipeline after 3 close-together early lapses', () => {
    let s = graduated() // intervalDays: 3 (good graduation), lastReviewedAt: now, lapseClusterCount: 0

    // First lapse: clusters to 1
    s = progressAfterReview(s, PIPELINE, { wasCorrect: false, rating: 'again' })
    expect(s.graduated).toBe(true)
    expect(s.lapseClusterCount).toBe(1)

    // Second close-together lapse: clusters to 2
    s = progressAfterReview(s, PIPELINE, { wasCorrect: false, rating: 'again' })
    expect(s.graduated).toBe(true)
    expect(s.lapseClusterCount).toBe(2)

    // Third close-together lapse: relearn — back into the pipeline
    s = progressAfterReview(s, PIPELINE, { wasCorrect: false, rating: 'again' })
    expect(s.graduated).toBe(false)
    expect(s.currentStepOrder).toBe(0)
    expect(s.dueAt).toBeNull()
    expect(s.lapses).toBe(3)
  })
})

describe('typing-mistake streak → multiple-choice redo', () => {
  /** Drive a fresh card to its typing step (step 2) via two correct recognition answers. */
  function atTypingStep(): CardState {
    let s = fresh()
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' }) // step 0 -> 1
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' }) // step 1 -> 2 (typing)
    expect(s.currentStepOrder).toBe(2)
    return s
  }

  function typeWrong(s: CardState): CardState {
    return progressAfterReview(s, PIPELINE, { wasCorrect: false, rating: 'again' })
  }

  it('increments typingMistakeStreak on wrong typing answers, without leaving the typing step', () => {
    let s = atTypingStep()
    s = typeWrong(s)
    expect(s.typingMistakeStreak).toBe(1)
    expect(s.typingFailCycles).toBe(0)
    expect(s.currentStepOrder).toBe(2)
  })

  it('a correct typing answer resets the streak', () => {
    let s = atTypingStep()
    s = typeWrong(s)
    s = typeWrong(s)
    expect(s.typingMistakeStreak).toBe(2)
    s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    expect(s.typingMistakeStreak).toBe(0)
  })

  it('3 wrong typing answers in a row rolls into 1 fail-cycle without sending the card back', () => {
    let s = atTypingStep()
    s = typeWrong(s); s = typeWrong(s); s = typeWrong(s)
    expect(s.typingMistakeStreak).toBe(0)
    expect(s.typingFailCycles).toBe(1)
    expect(s.currentStepOrder).toBe(2) // still on typing — no redo yet
  })

  it('on the 3rd fail-cycle (9th wrong-in-a-row, in groups of 3), sends the card back to redo recognition steps', () => {
    let s = atTypingStep()
    for (let cycle = 0; cycle < 3; cycle++) {
      s = typeWrong(s); s = typeWrong(s); s = typeWrong(s)
    }
    expect(s.typingFailCycles).toBe(0)
    expect(s.typingMistakeStreak).toBe(0)
    expect(s.currentStepOrder).toBe(0) // sent back to redo both recognition steps
    expect(s.correctInStep).toBe(0)
    expect(s.graduated).toBe(false)
  })

  it('recognition-step wrong answers do not affect the typing streak', () => {
    let s = fresh()
    s = typeWrong(s) // wrong on step 0 (recognition)
    expect(s.typingMistakeStreak).toBe(0)
    expect(s.typingFailCycles).toBe(0)
    expect(s.currentStepOrder).toBe(0)
  })
})

describe('initialCardState', () => {
  it('initializes lapse-clustering fields', () => {
    const s = initialCardState('user-1', 'card-1', 'pipeline-1')
    expect(s.lapseClusterCount).toBe(0)
    expect(s.lastLapseAt).toBeNull()
  })
})
