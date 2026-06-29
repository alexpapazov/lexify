/**
 * engine/pipeline.ts
 * The pipeline state machine — core innovation of the app.
 * Pure function: no database calls, no side effects.
 */

import type { CardState, Pipeline, ReviewInput, Rating, SchedulerParams } from '@/domain'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import { scheduleNext } from './scheduler'
import {
  TYPED_ACCURACY_WINDOW_SIZE,
  FORCED_TYPED_ON_TYPO_ERROR,
  FORCED_TYPED_ON_LAPSE,
} from './productionMode'

/** How many `scheduledIntervalDays` snapshots to keep in `intervalHistory`. */
const INTERVAL_HISTORY_SIZE = 50

/**
 * A wrong typed answer with a severity at or below this threshold is a
 * "close" mistake (accent, spelling, article, gender) rather than a total
 * miss — these are the cases that force the next few reviews back to typed
 * production.
 */
const CLOSE_TYPO_SEVERITY_THRESHOLD = 0.3

function appendHistory(history: number[], value: number): number[] {
  return [...history, value].slice(-INTERVAL_HISTORY_SIZE)
}

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
    scheduledIntervalDays: 0,
    ease:             2.5,
    reps:             0,
    lapses:           0,
    lastRating:       null,
    lastReviewedAt:   null,
    introducedDate:   new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    lapseClusterCount: 0,
    lastLapseAt:       null,
    graduatedAt:       null,
    relearningStep:    0,
    pendingIntervalDays: null,
    typedAccuracyWindow: [],
    typedReviewCount:    0,
    lastTypedReviewAt:   null,
    forcedTypedRemaining: 0,
    intervalHistory:   [],
    typingMistakeStreak: 0,
    typingFailCycles:    0,
    stage3EnteredDate: null,
    iDontKnowCount:    0,
    accentMistakeCount:   0,
    articleMistakeCount:  0,
    genderMistakeCount:   0,
    typoMistakeCount:     0,
    semanticMistakeCount: 0,
    wrongSynonymCount:    0,
    acceleratedMode:        'none',
    acceleratedLocked:      false,
    acceleratedWrongStreak: 0,
    acceleratedPenalty:     0,
    typedIntervalDays:   null,
    typedDueAt:          null,
    recallIntervalDays:  null,
    recallDueAt:         null,
    reviewDirection:     'forward',
  }
}

/**
 * Creates a CardState for an import-known fast-tracked card.
 * The card is already graduated; its first review lands at `dueAt` (spread
 * across the fast-track window by the caller). `intervalDays` is 14 — the
 * intended baseline so that an on-time first review produces ~14 days × accel
 * multiplier as the next interval, regardless of which spread day the card
 * lands on. `scheduledIntervalDays` is derived from the actual gap between
 * now and `dueAt` so the scheduler's timing classification is accurate per
 * card. Setting `lastReviewedAt` to now ensures the scheduler treats this as
 * a normal graduated review (not a first-ever graduation) at review time.
 */
export function fastTrackCardState(
  userId:     string,
  cardId:     string,
  pipelineId: string,
  dueAt:      string,
  now:        Date = new Date(),
): CardState {
  const nowIso     = now.toISOString()
  const spreadDays = Math.max(1, Math.round((new Date(dueAt).getTime() - now.getTime()) / 86_400_000))
  return {
    ...initialCardState(userId, cardId, pipelineId),
    graduated:             true,
    intervalDays:          14,
    scheduledIntervalDays: spreadDays,
    dueAt,
    lastReviewedAt:        nowIso,
    graduatedAt:           nowIso,
    introducedDate:        nowIso.slice(0, 10),
    acceleratedMode:       'import_known',
    acceleratedLocked:     false,
    acceleratedWrongStreak: 0,
    acceleratedPenalty:    0,
    forcedTypedRemaining:  3,   // start with typed production
  }
}

export function progressAfterReview(
  state:    CardState,
  pipeline: Pipeline,
  input:    ReviewInput,
  nowDate:  Date = new Date(),
): CardState {
  const now = nowDate.toISOString()
  const { wasCorrect, rating, wrongSeverity } = input

  // ── Post-graduation ──────────────────────────────────────────────────────
  if (state.graduated) {
    // Typed-production bookkeeping — applies to every post-graduation
    // review, regardless of how it affects scheduling.
    let typedAccuracyWindow  = state.typedAccuracyWindow
    let typedReviewCount     = state.typedReviewCount
    let lastTypedReviewAt    = state.lastTypedReviewAt
    let forcedTypedRemaining = state.forcedTypedRemaining

    if (input.wasTyped) {
      typedAccuracyWindow = [...state.typedAccuracyWindow, wasCorrect ? 1 : 0].slice(-TYPED_ACCURACY_WINDOW_SIZE)
      typedReviewCount    = state.typedReviewCount + 1
      lastTypedReviewAt   = now
      if (forcedTypedRemaining > 0) forcedTypedRemaining -= 1
      if (!wasCorrect && (wrongSeverity ?? 0) <= CLOSE_TYPO_SEVERITY_THRESHOLD) {
        // Spelling / accent / gender / article slip — force typed for the next few reviews.
        forcedTypedRemaining = Math.max(forcedTypedRemaining, FORCED_TYPED_ON_TYPO_ERROR)
      }
    } else if (rating === 'again') {
      // Self-graded "Again" — force the next review back to typed.
      forcedTypedRemaining = Math.max(forcedTypedRemaining, FORCED_TYPED_ON_LAPSE)
    }

    const typedFields = { typedAccuracyWindow, typedReviewCount, lastTypedReviewAt, forcedTypedRemaining }

    // ── Accelerated fast-track bookkeeping ───────────────────────────────────
    let acceleratedMode        = state.acceleratedMode
    let acceleratedLocked      = state.acceleratedLocked
    let acceleratedWrongStreak = state.acceleratedWrongStreak
    let acceleratedPenalty     = state.acceleratedPenalty

    if (state.acceleratedMode === 'import_known' || state.acceleratedLocked) {
      acceleratedLocked = true   // lock after first actual review
    }
    if (state.acceleratedMode === 'import_known') {
      if (rating === 'again') {
        acceleratedWrongStreak++
        acceleratedPenalty++
        if (acceleratedWrongStreak >= 2) acceleratedMode = 'none'
      } else {
        acceleratedWrongStreak = 0   // reset on correct; penalty is permanent
      }
    }
    const accelFields = { acceleratedMode, acceleratedLocked, acceleratedWrongStreak, acceleratedPenalty }

    if (rating === 'again') {
      const scheduled = scheduleNext(state, 'again', { now: nowDate, wrongSeverity })

      if (scheduled.relearn) {
        // 3+ "again"s within a lapse cluster — send the card back into the
        // learning pipeline instead of just shrinking its interval.
        return {
          ...state,
          ...typedFields,
          ...accelFields,
          graduated:         false,
          currentStepOrder:  0,
          correctInStep:     0,
          dueAt:             null,
          intervalDays:      0,
          scheduledIntervalDays: 0,
          ease:              scheduled.ease,
          lapses:            state.lapses + 1,
          lapseClusterCount: scheduled.lapseClusterCount,
          lastLapseAt:       scheduled.lastLapseAt,
          lastRating:        rating,
          lastReviewedAt:    now,
          relearningStep:    0,
          pendingIntervalDays: null,
          graduatedAt:       null,
          forcedTypedRemaining: Math.max(forcedTypedRemaining, FORCED_TYPED_ON_LAPSE),
        }
      }

      // Either entering the 10-minute relearn loop for the first time, or
      // failing another retry within it (relearningStep keeps incrementing).
      return {
        ...state,
        ...typedFields,
        ...accelFields,
        lapses:            state.lapses + 1,
        lastRating:        rating,
        lastReviewedAt:    now,
        dueAt:             scheduled.dueAt,
        intervalDays:      scheduled.intervalDays,
        scheduledIntervalDays: scheduled.scheduledIntervalDays,
        ease:              scheduled.ease,
        lapseClusterCount: scheduled.lapseClusterCount,
        lastLapseAt:       scheduled.lastLapseAt,
        relearningStep:    scheduled.relearningStep,
        pendingIntervalDays: scheduled.pendingIntervalDays,
      }
    }

    // hard / good / easy
    const scheduled = scheduleNext(state, rating, { now: nowDate, wrongSeverity })

    if (scheduled.noChange) {
      // Very-early correct review — counts as practice, but the schedule
      // (dueAt / intervalDays / scheduledIntervalDays / lastReviewedAt) is
      // left untouched.
      return {
        ...state,
        ...typedFields,
        ...accelFields,
        lastRating: rating,
      }
    }

    return {
      ...state,
      ...typedFields,
      ...accelFields,
      reps:              rating !== 'hard' ? state.reps + 1 : state.reps,
      lastRating:        rating,
      lastReviewedAt:    now,
      dueAt:             scheduled.dueAt,
      intervalDays:      scheduled.intervalDays,
      scheduledIntervalDays: scheduled.scheduledIntervalDays,
      ease:              scheduled.ease,
      lapseClusterCount: scheduled.lapseClusterCount,
      lastLapseAt:       scheduled.lastLapseAt,
      relearningStep:    scheduled.relearningStep,
      pendingIntervalDays: scheduled.pendingIntervalDays,
      intervalHistory:   appendHistory(state.intervalHistory, scheduled.scheduledIntervalDays),
    }
  }

  // ── Pre-graduation ───────────────────────────────────────────────────────
  const sortedSteps  = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const currentStep  = sortedSteps.find(s => s.stepOrder === state.currentStepOrder)

  if (!currentStep) return { ...state, lastRating: rating, lastReviewedAt: now }

  // hard / again = does not advance
  const countAsCorrect = wasCorrect && rating !== 'again' && rating !== 'hard'

  // Track consecutive wrong *typing*-step answers. Every 3rd time this streak
  // hits 3, the card is sent back to redo both multiple-choice recognition
  // steps before resuming typing (see below).
  let typingMistakeStreak = state.typingMistakeStreak
  let typingFailCycles    = state.typingFailCycles
  let triggerMcRedo       = false

  if (currentStep.stepType === 'typing') {
    if (countAsCorrect) {
      typingMistakeStreak = 0
    } else {
      typingMistakeStreak += 1
      if (typingMistakeStreak >= 3) {
        typingMistakeStreak = 0
        typingFailCycles += 1
        if (typingFailCycles >= 3) {
          typingFailCycles = 0
          triggerMcRedo = true
        }
      }
    }
  }

  if (!countAsCorrect) {
    if (triggerMcRedo) {
      // Send the learner back to redo both recognition (multiple-choice)
      // steps — i.e. back to the first pipeline step — before resuming
      // typing.
      return {
        ...state,
        currentStepOrder:   sortedSteps[0]!.stepOrder,
        correctInStep:      0,
        typingMistakeStreak,
        typingFailCycles,
        lastRating:         rating,
        lastReviewedAt:     now,
      }
    }
    return { ...state, correctInStep: 0, typingMistakeStreak, typingFailCycles, lastRating: rating, lastReviewedAt: now }
  }

  const newCorrectInStep = state.correctInStep + 1

  if (newCorrectInStep >= currentStep.requiredCorrect) {
    const nextStep = sortedSteps.find(s => s.stepOrder > state.currentStepOrder)
    const today    = now.slice(0, 10)

    // "Same-day window": the final 3 pipeline steps (stages 3-5 in the
    // default 5-step pipeline — typing x2, typing x2, final recognition)
    // must all be completed on the same calendar day. If a step AFTER the
    // window's first step is completed on a different day than the window
    // was entered, the card is sent back to the window's first step and the
    // window restarts today. This is independent of (and composes with) the
    // typingMistakeStreak/typingFailCycles → redo-to-stage-1 logic above.
    const windowStartStep = sortedSteps[Math.max(0, sortedSteps.length - 3)]!
    const inWindow        = currentStep.stepOrder >= windowStartStep.stepOrder

    if (
      inWindow &&
      currentStep.stepOrder > windowStartStep.stepOrder &&
      state.stage3EnteredDate != null &&
      state.stage3EnteredDate !== today
    ) {
      return {
        ...state,
        currentStepOrder:  windowStartStep.stepOrder,
        correctInStep:     0,
        stage3EnteredDate: today,
        typingMistakeStreak,
        typingFailCycles,
        lastRating:        rating,
        lastReviewedAt:    now,
      }
    }

    const stage3EnteredDate = currentStep.stepOrder === windowStartStep.stepOrder
      ? today
      : state.stage3EnteredDate

    if (!nextStep) {
      // Graduate
      const scheduled = scheduleNext(state, rating, { now: nowDate })
      return {
        ...state,
        correctInStep:    0,
        graduated:        true,
        currentStepOrder: currentStep.stepOrder,
        reps:             1,
        typingMistakeStreak,
        typingFailCycles,
        stage3EnteredDate,
        lastRating:       rating,
        lastReviewedAt:   now,
        dueAt:                 scheduled.dueAt,
        intervalDays:          scheduled.intervalDays,
        scheduledIntervalDays: scheduled.scheduledIntervalDays,
        ease:                  scheduled.ease,
        lapseClusterCount:     scheduled.lapseClusterCount,
        lastLapseAt:           scheduled.lastLapseAt,
        relearningStep:        scheduled.relearningStep,
        pendingIntervalDays:   scheduled.pendingIntervalDays,
        graduatedAt:           now,
        intervalHistory:       appendHistory(state.intervalHistory, scheduled.scheduledIntervalDays),
      }
    }

    return { ...state, currentStepOrder: nextStep.stepOrder, correctInStep: 0, typingMistakeStreak, typingFailCycles, stage3EnteredDate, lastRating: rating, lastReviewedAt: now }
  }

  return { ...state, correctInStep: newCorrectInStep, typingMistakeStreak, typingFailCycles, lastRating: rating, lastReviewedAt: now }
}

export function ratingToWasCorrect(rating: Rating): boolean {
  return rating === 'good' || rating === 'easy'
}
