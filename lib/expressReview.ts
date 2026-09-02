/**
 * lib/expressReview.ts — express matching over due reverse-recognition cards.
 *
 * Express review turns the matching game into a REAL review for the cheapest kind of due card:
 * the reverse row (see the target word → recall the native meaning). A clean first-try match is a
 * Good on that row's schedule — full FSRS credit, exactly what a self-graded Good in a session
 * earns, because pairing the word with its meaning IS the recognition being tested. A mismatch
 * schedules NOTHING: no lapse, no relearn loop, no event — the card simply stays due, and the
 * normal session makes the real judgement. A game must never be able to un-graduate a card.
 *
 * Only the reverse track works this way. Production reviews (type the word / recall the target)
 * test retrieval that matching cannot see, so they are deliberately out of scope here.
 */

import type { Card, CardState, Rating } from '@/domain'
import type { CardStateRepository, ReviewEventRepository } from '@/lib/data/interfaces'
import type { EnabledTracks } from '@/lib/sessionLimits'
import { calibrationFor, retentionFor } from '@/lib/sessionLimits'
import { isCardStateDueNow } from '@/lib/dueStatus'
import { scheduleGraduatedFsrs } from '@/engine/dueNow'
import { DEFAULT_FSRS_CONFIG, fsrsFuzzRange } from '@/engine/fsrs'
import { smoothDueDate } from '@/engine/density'
import { snapDueAtToStartOfDay } from '@/lib/dates'
import { displayText } from '@/lib/cardText'

export interface ExpressCandidate {
  card:  Card
  /** The card's REVERSE `card_states` row (the schedule a clean match credits). */
  state: CardState
}

export interface ExpressPool {
  pool: ExpressCandidate[]
  /** Due cards excluded because another pool card shows identical tile text (see below). */
  skippedAmbiguous: number
}

const norm = (s: string) => displayText(s).trim().toLowerCase()

/**
 * The cards an express matching session may serve: every due reverse row in scope, minus
 *
 *  - rows in the relearn loop — they owe the loop two Goods, which a tile tap can't stand in for;
 *  - cards whose front OR back reads identically to another pool card's — two tiles with the same
 *    text are a coin flip, and a coin flip must not earn scheduling credit. Skipped cards just
 *    stay due for the normal session (they're counted so the UI can say so).
 *
 * Everything else ("due" itself — graduation, the forward-row gate, per-direction dormancy, track
 * enablement, turnover-aware dates) is `isCardStateDueNow`, the one definition of due.
 */
export function buildExpressPool(
  cards: Card[],
  states: CardState[],
  opts: {
    source?: string | null
    target?: string | null
    tracksByPair: Map<string, EnabledTracks>
    tz: string
    today: string
  },
): ExpressPool {
  const cardById = new Map(cards.map(c => [c.id, c]))
  const forwardByCard = new Map(states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]))

  const due: ExpressCandidate[] = []
  for (const s of states) {
    if (s.reviewDirection !== 'reverse') continue
    if (s.relearning || s.relearningStep > 0) continue
    const card = cardById.get(s.cardId)
    if (!card || card.deletedAt) continue
    if (opts.source && card.sourceLanguage !== opts.source) continue
    if (opts.target && card.targetLanguage !== opts.target) continue
    const tracks = opts.tracksByPair.get(`${card.sourceLanguage}|${card.targetLanguage}`)
    if (!isCardStateDueNow(s, { tracks, tz: opts.tz, today: opts.today, forwardState: forwardByCard.get(s.cardId) })) continue
    due.push({ card, state: s })
  }

  const frontCounts = new Map<string, number>()
  const backCounts  = new Map<string, number>()
  for (const { card } of due) {
    frontCounts.set(norm(card.front), (frontCounts.get(norm(card.front)) ?? 0) + 1)
    backCounts.set(norm(card.back), (backCounts.get(norm(card.back)) ?? 0) + 1)
  }
  const pool = due.filter(({ card }) =>
    frontCounts.get(norm(card.front)) === 1 && backCounts.get(norm(card.back)) === 1)
  return { pool, skippedAmbiguous: due.length - pool.length }
}

/**
 * Applies a clean first-try match as a Good review on the card's reverse row — the same
 * scheduling a self-graded Good earns in a session (FSRS with the pair's reverse-recall retention
 * + calibration, fuzz window, density smoothing, day-start snap), and the same review event, so
 * analytics and retention calibration see it like any other recognition review.
 *
 * The pool excludes relearning rows, so a Good here always lands in the schedule branch.
 */
export async function creditExpressMatch(opts: {
  userId:       string
  card:         Card
  state:        CardState
  now:          Date
  tz:           string
  turnoverHour: number
  retMap:       Map<string, number>
  calMap:       Map<string, number>
  stateRepo:    CardStateRepository
  eventRepo:    ReviewEventRepository
}): Promise<CardState> {
  const { card, state, now } = opts
  const rating: Rating = 'good'
  const elapsedDays = state.lastReviewedAt
    ? Math.max(0, (now.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
    : (state.recallIntervalDays ?? state.intervalDays ?? 1)

  const fsrs = scheduleGraduatedFsrs({
    difficulty:   state.difficulty,
    stability:    state.stability,
    intervalDays: state.recallIntervalDays ?? state.intervalDays,
    lapses:       state.lapses,
    relearning:   state.relearning,
    goodStreak:   state.goodStreak,
    againStreak:  state.againStreak,
    elapsedDays,
  }, rating, {
    ...DEFAULT_FSRS_CONFIG,
    requestRetention:     retentionFor(opts.retMap, card.sourceLanguage, card.targetLanguage, 'reverse_recall'),
    retentionCalibration: calibrationFor(opts.calMap, card.sourceLanguage, card.targetLanguage, 'reverse_recall'),
  }, {})

  const days = fsrs.intervalDays ?? state.recallIntervalDays ?? 1
  const [minDays, maxDays] = fsrsFuzzRange(days)
  const idealDueAt = new Date(now.getTime() + days * 86_400_000).toISOString()
  const smoothed = (maxDays - minDays >= 1)
    ? await smoothDueDate(opts.userId, idealDueAt, minDays, maxDays, days, opts.stateRepo)
    : idealDueAt
  const newDueAt = snapDueAtToStartOfDay(smoothed, opts.tz, opts.turnoverHour)

  const newState: CardState = {
    ...state,
    difficulty:         fsrs.difficulty,
    stability:          fsrs.stability,
    relearning:         fsrs.relearning,
    goodStreak:         fsrs.goodStreak,
    againStreak:        fsrs.againStreak,
    lastRating:         rating,
    lastReviewedAt:     now.toISOString(),
    reps:               state.reps + 1,
    relearningStep:     0,
    recallIntervalDays: fsrs.intervalDays ?? state.recallIntervalDays,
    recallDueAt:        newDueAt,
    dueAt:              newDueAt,   // reverse rows mirror their schedule onto dueAt
  }
  await opts.stateRepo.upsert(newState)

  // Same shape a session's reverse self-graded review logs, so measured retention counts it.
  // Fire-and-forget: a lost event costs one analytics row, never the schedule write above.
  void opts.eventRepo.create({
    userId: opts.userId, cardId: card.id, mode: 'recognition',
    promptSide: 'front', answerSide: 'back',
    promptShown: card.front, expected: card.back,
    userAnswer: card.back, wasCorrect: true, rating,
    responseMs: null,
    reviewMode: 'due', wasTyped: false,
    reviewDirection: 'reverse', reps: state.reps,
    sourceLanguage: card.sourceLanguage, targetLanguage: card.targetLanguage,
  }).catch(() => {})

  return newState
}
