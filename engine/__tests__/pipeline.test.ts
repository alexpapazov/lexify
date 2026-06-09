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
    const next = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    expect(next.reps).toBeGreaterThan(s.reps)
  })
})
