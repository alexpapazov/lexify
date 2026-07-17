/**
 * engine/pipeline.ts
 * The pipeline state machine — core innovation of the app.
 * Pure function: no database calls, no side effects.
 */

import type { CardState, Pipeline, ReviewInput, Rating } from '@/domain'
import {
  TYPED_ACCURACY_WINDOW_SIZE,
  FORCED_TYPED_ON_TYPO_ERROR,
  FORCED_TYPED_ON_LAPSE,
} from './productionMode'

/** First interval (days) a card is seeded with the moment it graduates, keyed by the graduating
 *  rating. Matches the old scheduler's INITIAL_INTERVAL. The session overrides this on the main
 *  path (graduationIntervalRange); it only survives for co-advanced synonym members. */
const GRADUATION_SEED_INTERVAL: Record<Rating, number> = { again: 1, hard: 1, good: 3, easy: 7 }

/** How many interval snapshots to keep in `intervalHistory`. */
const INTERVAL_HISTORY_SIZE = 50

/**
 * A wrong typed answer with a severity at or below this threshold is a
 * "close" mistake (accent, spelling, article, gender) rather than a total
 * miss — these are the cases that force the next few reviews back to typed
 * production.
 */
const CLOSE_TYPO_SEVERITY_THRESHOLD = 0.3

/**
 * Append a real (FSRS or graduation) interval-days value to a card's
 * `intervalHistory`, capping the log at the most recent `INTERVAL_HISTORY_SIZE`
 * entries. Owned by the session layer — `progressAfterReview` no longer appends,
 * since the true interval is only known after FSRS scheduling runs.
 */
export function appendHistory(history: number[], value: number): number[] {
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
    difficulty:       null,
    stability:        null,
    relearning:       false,
    goodStreak:       0,
    againStreak:      0,
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
    pipelineErrorCount:   0,
    graduationErrorCount: 0,
    accentMistakeCount:   0,
    articleMistakeCount:  0,
    genderMistakeCount:   0,
    typoMistakeCount:     0,
    semanticMistakeCount: 0,
    wrongSynonymCount:    0,
    dormant:              false,
    dormancyThreshold:    null,
    acceleratedMode:        'none',
    acceleratedLocked:      false,
    acceleratedWrongStreak: 0,
    acceleratedPenalty:     0,
    postAccelRestartWindow: 0,
    postAccelWrongCount:    0,
    typedIntervalDays:   null,
    typedDueAt:          null,
    recallIntervalDays:  null,
    recallDueAt:         null,
    smartIntervalDays:   null,
    smartDueAt:          null,
    acceleratedTypedConfirmed: false,
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

/** Below this fraction of the scheduled interval, a correct graduated review is "very early":
 *  the session still advances the FSRS memory model, but reps/lastReviewedAt are left untouched
 *  (pure practice). Preserves the old scheduler's very-early no-op for these bookkeeping counters. */
const VERY_EARLY_THRESHOLD = 0.30

/**
 * Post-graduation bookkeeping for one review: the typed-accuracy window, forced-typing counter,
 * accelerated fast-track counters, reps, and lapses — everything about a graduated review that
 * ISN'T scheduling. Scheduling (dueAt / difficulty / stability) and un-graduation are owned by the
 * session's FSRS layer (engine/dueNow); this function never touches them. Extracted from
 * progressAfterReview so the legacy multiplier scheduler could be removed.
 */
export function applyProductionBookkeeping(
  state:   CardState,
  input:   ReviewInput,
  nowDate: Date = new Date(),
): CardState {
  const now = nowDate.toISOString()
  const { wasCorrect, rating, wrongSeverity } = input

  // Typed-production bookkeeping — applies to every post-graduation review.
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
  let postAccelRestartWindow = state.postAccelRestartWindow
  let postAccelWrongCount    = state.postAccelWrongCount

  if (state.acceleratedMode === 'import_known' || state.acceleratedLocked) {
    acceleratedLocked = true   // lock after first actual review
  }
  if (state.acceleratedMode === 'import_known') {
    if (rating === 'again') {
      acceleratedWrongStreak++
      acceleratedPenalty++
      if (acceleratedWrongStreak >= 2) {
        acceleratedMode = 'none'
        postAccelRestartWindow = 3
        postAccelWrongCount    = 0
      }
    } else {
      acceleratedWrongStreak = 0   // reset on correct; penalty is permanent
    }
  }
  const accelFields = { acceleratedMode, acceleratedLocked, acceleratedWrongStreak, acceleratedPenalty, postAccelRestartWindow, postAccelWrongCount }

  // A wrong ("again") answer is a lapse; the FSRS relearn gate decides relearn-vs-un-graduate.
  if (rating === 'again') {
    return { ...state, ...typedFields, ...accelFields, lapses: state.lapses + 1, lastRating: rating, lastReviewedAt: now }
  }

  // hard / good / easy — a very-early correct review records practice but does not bump
  // reps / lastReviewedAt (the session still advances FSRS memory state).
  const scheduledInterval = state.scheduledIntervalDays > 0 ? state.scheduledIntervalDays : state.intervalDays
  const elapsed  = state.lastReviewedAt
    ? Math.max(0, (nowDate.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
    : Infinity
  const progress  = scheduledInterval > 0 ? elapsed / scheduledInterval : 1
  const cardIsDue = state.dueAt ? new Date(state.dueAt) <= nowDate : false
  if (progress < VERY_EARLY_THRESHOLD && !cardIsDue) {
    return { ...state, ...typedFields, ...accelFields, lastRating: rating }
  }

  return {
    ...state,
    ...typedFields,
    ...accelFields,
    reps:           rating !== 'hard' ? state.reps + 1 : state.reps,
    lastRating:     rating,
    lastReviewedAt: now,
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

  // ── Post-graduation: bookkeeping only ────────────────────────────────────
  // The session's FSRS layer (engine/dueNow) owns all graduated scheduling AND
  // un-graduation — its relearn gate (3 Agains → back to the ladder) replaces the
  // old lapse-cluster → back-to-pipeline path. So here we only update the counters
  // FSRS doesn't touch (typed window, forced-typing, accel, reps, lapses).
  if (state.graduated) {
    return applyProductionBookkeeping(state, input, nowDate)
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
      // Graduate. The session's graduation block overrides dueAt/intervalDays with the calibrated
      // graduationIntervalRange; this flat seed (matching the old scheduler's INITIAL_INTERVAL) is
      // what co-advanced synonym members — which don't run the session's FSRS/graduation blocks —
      // graduate with. Graduation only fires on a correct good/easy answer, so it's never a lapse.
      const seedInterval = GRADUATION_SEED_INTERVAL[rating]
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
        dueAt:                 new Date(nowDate.getTime() + seedInterval * 86_400_000).toISOString(),
        intervalDays:          seedInterval,
        scheduledIntervalDays: seedInterval,
        ease:                  state.ease,
        lapseClusterCount:     0,
        lastLapseAt:           state.lastLapseAt,
        relearningStep:        0,
        pendingIntervalDays:   null,
        graduatedAt:           now,
        // intervalHistory is appended by the session layer with the real
        // graduation interval (graduationIntervalRange) — see appendHistory.
      }
    }

    return { ...state, currentStepOrder: nextStep.stepOrder, correctInStep: 0, typingMistakeStreak, typingFailCycles, stage3EnteredDate, lastRating: rating, lastReviewedAt: now }
  }

  return { ...state, correctInStep: newCorrectInStep, typingMistakeStreak, typingFailCycles, lastRating: rating, lastReviewedAt: now }
}

export function ratingToWasCorrect(rating: Rating): boolean {
  return rating === 'good' || rating === 'easy'
}
