/**
 * engine/pipeline.ts
 * The pipeline state machine — core innovation of the app.
 * Pure function: no database calls, no side effects.
 */

import type { CardState, Pipeline, ReviewInput, Rating } from '@/domain'
import { scheduleNext } from './scheduler'

export function initialCardState(
  userId:     string,
  cardId:     string,
  pipelineId: string,
): CardState {
  return {
    userId,
    cardId,
    pipelineId,
    currentStepOrder: 0,
    correctInStep:    0,
    graduated:        false,
    dueAt:            null,
    intervalDays:     0,
    ease:             2.5,
    reps:             0,
    lapses:           0,
    lastRating:       null,
    lastReviewedAt:   null,
    introducedDate:   new Date().toISOString().slice(0, 10), // YYYY-MM-DD
  }
}

export function progressAfterReview(
  state:    CardState,
  pipeline: Pipeline,
  input:    ReviewInput,
): CardState {
  const now = new Date().toISOString()
  const { wasCorrect, rating } = input

  // ── Post-graduation ──────────────────────────────────────────────────────
  if (state.graduated) {
    if (rating === 'again') {
      const scheduled = scheduleNext(state, 'again')
      return { ...state, lapses: state.lapses + 1, lastRating: rating, lastReviewedAt: now, ...scheduled }
    }
    const scheduled = scheduleNext(
      { ...state, reps: state.reps + (rating !== 'hard' ? 1 : 0) },
      rating,
    )
    return {
      ...state,
      reps:           rating !== 'hard' ? state.reps + 1 : state.reps,
      lastRating:     rating,
      lastReviewedAt: now,
      ...scheduled,
    }
  }

  // ── Pre-graduation ───────────────────────────────────────────────────────
  const sortedSteps  = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const currentStep  = sortedSteps.find(s => s.stepOrder === state.currentStepOrder)

  if (!currentStep) return { ...state, lastRating: rating, lastReviewedAt: now }

  // hard / again = does not advance
  const countAsCorrect = wasCorrect && rating !== 'again' && rating !== 'hard'

  if (!countAsCorrect) {
    return { ...state, correctInStep: 0, lastRating: rating, lastReviewedAt: now }
  }

  const newCorrectInStep = state.correctInStep + 1

  if (newCorrectInStep >= currentStep.requiredCorrect) {
    const nextStep = sortedSteps.find(s => s.stepOrder > state.currentStepOrder)

    if (!nextStep) {
      // Graduate
      const scheduled = scheduleNext(state, rating)
      return {
        ...state,
        correctInStep:    0,
        graduated:        true,
        currentStepOrder: currentStep.stepOrder,
        reps:             1,
        lastRating:       rating,
        lastReviewedAt:   now,
        ...scheduled,
      }
    }

    return { ...state, currentStepOrder: nextStep.stepOrder, correctInStep: 0, lastRating: rating, lastReviewedAt: now }
  }

  return { ...state, correctInStep: newCorrectInStep, lastRating: rating, lastReviewedAt: now }
}

export function ratingToWasCorrect(rating: Rating): boolean {
  return rating === 'good' || rating === 'easy'
}
