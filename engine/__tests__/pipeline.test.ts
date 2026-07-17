import { progressAfterReview, initialCardState } from '../pipeline'
import { FORCED_TYPED_ON_TYPO_ERROR, FORCED_TYPED_ON_LAPSE } from '../productionMode'
import type { CardState, Pipeline } from '@/domain'

const PIPELINE: Pipeline = {
  id: 'pipeline-1', ownerId: null, name: 'Default', isDefault: true,
  steps: [
    { pipelineId: 'pipeline-1', stepOrder: 0, stepType: 'recognition', promptSide: 'front', answerSide: 'back',  requiredCorrect: 1 },
    { pipelineId: 'pipeline-1', stepOrder: 1, stepType: 'recognition', promptSide: 'back',  answerSide: 'front', requiredCorrect: 1 },
    { pipelineId: 'pipeline-1', stepOrder: 2, stepType: 'typing',      promptSide: 'back',  answerSide: 'front', requiredCorrect: 2 },
  ],
}

/** The real default pipeline (migration 023): 5 steps, stages 1-5. */
const PIPELINE5: Pipeline = {
  id: 'pipeline-5', ownerId: null, name: 'Default-5', isDefault: true,
  steps: [
    { pipelineId: 'pipeline-5', stepOrder: 0, stepType: 'recognition', promptSide: 'front', answerSide: 'back',  requiredCorrect: 1 }, // stage 1
    { pipelineId: 'pipeline-5', stepOrder: 1, stepType: 'recognition', promptSide: 'back',  answerSide: 'front', requiredCorrect: 1 }, // stage 2
    { pipelineId: 'pipeline-5', stepOrder: 2, stepType: 'typing',      promptSide: 'back',  answerSide: 'front', requiredCorrect: 2 }, // stage 3
    { pipelineId: 'pipeline-5', stepOrder: 3, stepType: 'typing',      promptSide: 'front', answerSide: 'back',  requiredCorrect: 2 }, // stage 4
    { pipelineId: 'pipeline-5', stepOrder: 4, stepType: 'recognition', promptSide: 'front', answerSide: 'back',  requiredCorrect: 1 }, // stage 5
  ],
}

function fresh(): CardState { return initialCardState('user-1', 'card-1', 'pipeline-1') }
function fresh5(): CardState { return initialCardState('user-1', 'card-1', 'pipeline-5') }

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

describe('same-day window (stages 3-5)', () => {
  /** Drive a fresh 5-step card to stage 3 (step 2) via two correct recognition answers. */
  function atStage3(now?: Date): CardState {
    let s = fresh5()
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, now) // stage1 -> stage2
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, now) // stage2 -> stage3
    expect(s.currentStepOrder).toBe(2)
    return s
  }

  it('graduates normally when stages 3-5 are all completed the same day', () => {
    const day = new Date('2026-06-10T12:00:00Z')
    let s = atStage3(day)

    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day) // stage3 1/2
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day) // stage3 -> stage4
    expect(s.currentStepOrder).toBe(3)
    expect(s.stage3EnteredDate).toBe('2026-06-10')

    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day) // stage4 1/2
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day) // stage4 -> stage5
    expect(s.currentStepOrder).toBe(4)

    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day) // stage5 -> graduate
    expect(s.graduated).toBe(true)
    expect(s.stage3EnteredDate).toBe('2026-06-10')
  })

  it('sends the card back to stage 3 if a later step is completed on a different day', () => {
    const day1 = new Date('2026-06-10T12:00:00Z')
    const day2 = new Date('2026-06-11T12:00:00Z')

    let s = atStage3(day1)
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day1) // stage3 1/2
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day1) // stage3 -> stage4
    expect(s.currentStepOrder).toBe(3)
    expect(s.stage3EnteredDate).toBe('2026-06-10')

    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day1) // stage4 1/2 (still day1)

    // Second stage-4 correct happens the next day — violates the window.
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day2)
    expect(s.currentStepOrder).toBe(2) // sent back to stage 3
    expect(s.correctInStep).toBe(0)
    expect(s.graduated).toBe(false)
    expect(s.stage3EnteredDate).toBe('2026-06-11') // window restarted today
  })

  it('graduates after redoing stages 3-5 within the restarted window', () => {
    const day1 = new Date('2026-06-10T12:00:00Z')
    const day2 = new Date('2026-06-11T12:00:00Z')

    let s = atStage3(day1)
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day1) // stage3 1/2
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day1) // stage3 -> stage4
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day1) // stage4 1/2 (day1)
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day2) // violation -> back to stage3
    expect(s.currentStepOrder).toBe(2)

    // Redo stages 3-5 entirely on day2.
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day2) // stage3 1/2
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day2) // stage3 -> stage4
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day2) // stage4 1/2
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day2) // stage4 -> stage5
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day2) // stage5 -> graduate
    expect(s.graduated).toBe(true)
    expect(s.stage3EnteredDate).toBe('2026-06-11')
  })

  it('does not apply the same-day check to in-flight cards with stage3EnteredDate = null (backward compat)', () => {
    // Simulate a card that was already at stage 4 (step 3) before this
    // feature shipped — stage3EnteredDate is null.
    let s: CardState = { ...fresh5(), currentStepOrder: 3, correctInStep: 1, stage3EnteredDate: null }

    const day1 = new Date('2026-06-10T12:00:00Z')
    const day2 = new Date('2026-06-11T12:00:00Z')

    // Second stage-4 correct on a different day — no violation since
    // stage3EnteredDate is null.
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day1)
    expect(s.currentStepOrder).toBe(4) // advanced to stage5, not reset
    expect(s.stage3EnteredDate).toBeNull()

    // Stage5 on yet another day — still no violation (null skips the check).
    s = progressAfterReview(s, PIPELINE5, { wasCorrect: true, rating: 'good' }, day2)
    expect(s.graduated).toBe(true)
  })

  it('typing-mistake-streak redo to stage 1 leaves stage3EnteredDate untouched', () => {
    let s = atStage3() // stage3EnteredDate still null — never successfully passed stage3
    expect(s.stage3EnteredDate).toBeNull()

    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < 3; i++) {
        s = progressAfterReview(s, PIPELINE5, { wasCorrect: false, rating: 'again' })
      }
    }
    expect(s.currentStepOrder).toBe(0) // redo recognition steps
    expect(s.stage3EnteredDate).toBeNull()
  })
})

describe('initialCardState', () => {
  it('initializes lapse-clustering fields', () => {
    const s = initialCardState('user-1', 'card-1', 'pipeline-1')
    expect(s.lapseClusterCount).toBe(0)
    expect(s.lastLapseAt).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stage 0 characterization: pins the production BOOKKEEPING that progressAfterReview
// uniquely provides and that the session pages keep (typed-accuracy window, forced-typing,
// reps-on-hard, accelerated transitions). These are NOT the multiplier SCHEDULING (which FSRS
// overrides). When Stage 3 extracts this into applyProductionBookkeeping(), these must still pass.
// ─────────────────────────────────────────────────────────────────────────────
describe('post-graduation bookkeeping — Stage 0 characterization (must survive multiplier removal)', () => {
  const later = new Date(Date.now() + 5 * 86_400_000)   // past the very-early no-op window
  function graduated(): CardState {
    let s = fresh()
    for (let i = 0; i < 4; i++) s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    return s
  }

  it('a typed review appends to the accuracy window (1=correct, 0=wrong) and bumps the typed count', () => {
    const g = graduated()
    const ok = progressAfterReview(g, PIPELINE, { wasCorrect: true, rating: 'good', wasTyped: true }, later)
    expect(ok.typedAccuracyWindow).toEqual([...g.typedAccuracyWindow, 1])
    expect(ok.typedReviewCount).toBe(g.typedReviewCount + 1)
    const bad = progressAfterReview(g, PIPELINE, { wasCorrect: false, rating: 'again', wasTyped: true, wrongSeverity: 1 })
    expect(bad.typedAccuracyWindow).toEqual([...g.typedAccuracyWindow, 0])
  })

  it('a self-graded review does NOT touch the typed accuracy window/count', () => {
    const g = graduated()
    const sg = progressAfterReview(g, PIPELINE, { wasCorrect: true, rating: 'good', wasTyped: false }, later)
    expect(sg.typedAccuracyWindow).toEqual(g.typedAccuracyWindow)
    expect(sg.typedReviewCount).toBe(g.typedReviewCount)
  })

  it('a close typo miss forces typed for the next few reviews; a self-graded Again forces one; a full miss forces none', () => {
    const g = graduated()
    expect(progressAfterReview(g, PIPELINE, { wasCorrect: false, rating: 'again', wasTyped: true,  wrongSeverity: 0.2 }).forcedTypedRemaining).toBe(FORCED_TYPED_ON_TYPO_ERROR)
    expect(progressAfterReview(g, PIPELINE, { wasCorrect: false, rating: 'again', wasTyped: false                     }).forcedTypedRemaining).toBe(FORCED_TYPED_ON_LAPSE)
    expect(progressAfterReview(g, PIPELINE, { wasCorrect: false, rating: 'again', wasTyped: true,  wrongSeverity: 1   }).forcedTypedRemaining).toBe(0)
  })

  it('a typed review decrements forcedTypedRemaining', () => {
    const g = { ...graduated(), forcedTypedRemaining: 3 }
    expect(progressAfterReview(g, PIPELINE, { wasCorrect: true, rating: 'good', wasTyped: true }, later).forcedTypedRemaining).toBe(2)
  })

  it('reps increment on good but NOT on hard', () => {
    const g = graduated()
    expect(progressAfterReview(g, PIPELINE, { wasCorrect: true, rating: 'good', wasTyped: false }, later).reps).toBe(g.reps + 1)
    expect(progressAfterReview(g, PIPELINE, { wasCorrect: true, rating: 'hard', wasTyped: false }, later).reps).toBe(g.reps)
  })

  it('accelerated import-known: two Agains drop it; a correct resets the streak but keeps the penalty', () => {
    const accel = { ...graduated(), acceleratedMode: 'import_known' as const }
    const a1 = progressAfterReview(accel, PIPELINE, { wasCorrect: false, rating: 'again', wasTyped: false })
    expect(a1.acceleratedWrongStreak).toBe(1)
    expect(a1.acceleratedPenalty).toBe(1)
    expect(a1.acceleratedMode).toBe('import_known')

    const a2 = progressAfterReview(a1, PIPELINE, { wasCorrect: false, rating: 'again', wasTyped: false })
    expect(a2.acceleratedMode).toBe('none')
    expect(a2.postAccelRestartWindow).toBe(3)

    const back = progressAfterReview(a1, PIPELINE, { wasCorrect: true, rating: 'good', wasTyped: false }, later)
    expect(back.acceleratedWrongStreak).toBe(0)
    expect(back.acceleratedPenalty).toBe(1)   // penalty is permanent
    expect(back.acceleratedMode).toBe('import_known')
  })

  it('Stage 1: progressAfterReview no longer appends to intervalHistory (the session layer logs the real FSRS interval)', () => {
    // Graduation must not append here — the session graduation block appends the
    // real graduationIntervalRange value.
    let s = fresh()
    for (let i = 0; i < 3; i++) s = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    const atGraduation = progressAfterReview(s, PIPELINE, { wasCorrect: true, rating: 'good' })
    expect(atGraduation.graduated).toBe(true)
    expect(atGraduation.intervalHistory).toEqual([])

    // A post-graduation review must not append either — the session FSRS block does.
    const seeded = { ...graduated(), intervalHistory: [3, 8] }
    const post = progressAfterReview(seeded, PIPELINE, { wasCorrect: true, rating: 'good', wasTyped: false }, later)
    expect(post.intervalHistory).toEqual([3, 8])
  })
})
