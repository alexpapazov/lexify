/**
 * lib/program.ts — applying the program builder's credits to card_states rows (Part 2 of the
 * Due Now Redesign; the pure math lives in engine/program.ts).
 *
 * Three writes exist, all scoped to ONE direction's row (directions diverge independently):
 *
 *  - `boostRow` — the intermediate push: interval/due move toward the full FSRS Good interval
 *    by the earned strength, GROW-ONLY, memory state (D/S), reps, lastReviewedAt untouched.
 *    Applied at day turnover (lazy finalization) or by the "lock in now" action.
 *  - `creditRow` — the real review for a word that cleared the FINAL stage: full FSRS
 *    bookkeeping (D/S, reps, lastRating), with the interval growth capped by the final
 *    stage's strength.
 *  - `finalizeStalePrograms` — runs on app open: any un-finalized program row from a previous
 *    (turnover-aware) day pays out its pending boosts and closes. No server cron exists; a
 *    stale row simply settles the next time the app looks at Due Now.
 *
 * No review_events for boosts; credits write the normal review path's state only (the program
 * row is the audit trail — same philosophy as media and external sessions).
 */

import type { CardState, Rating, UserId } from '@/domain'
import { appendHistory } from '@/engine/pipeline'
import { scheduleGraduatedFsrs } from '@/engine/dueNow'
import { DEFAULT_FSRS_CONFIG } from '@/engine/fsrs'
import { cappedInterval, earnedStrength, pendingBoosts, type StageKind } from '@/engine/program'
import { forwardStateMap } from '@/lib/cardStateMap'
import { getToday } from '@/lib/dates'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseReviewProgramRepository, type ReviewProgram } from '@/lib/data/reviewPrograms'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildCalibrationMap, buildEnabledTracksMap, buildRetentionMap, calibrationFor, retentionFor, type EnabledTracks } from '@/lib/sessionLimits'

export type ProgramDirection = 'production' | 'recognition'

export interface ProgramDeps {
  userId: UserId
  src:    string
  tgt:    string
  now:    Date
  tracks: EnabledTracks | undefined
  retMap: Map<string, number>
  calMap: Map<string, number>
}

function fieldFor(direction: ProgramDirection, tracks: EnabledTracks | undefined): string {
  if (direction === 'recognition') return 'reverse_recall'
  if (tracks?.smart) return 'forward_smart'
  if (tracks?.typed !== false) return 'forward_typed'
  return 'forward_recall'
}

export function rowInterval(state: CardState, direction: ProgramDirection): number {
  return Math.max(1, direction === 'production'
    ? state.smartIntervalDays ?? state.typedIntervalDays ?? state.intervalDays
    : state.recallIntervalDays ?? state.intervalDays)
}

function fsrsFor(state: CardState, direction: ProgramDirection, grade: Rating, deps: ProgramDeps, opts: { hintGrowthFactor?: number } = {}) {
  const field = fieldFor(direction, deps.tracks)
  const intervalDays = rowInterval(state, direction)
  return scheduleGraduatedFsrs({
    difficulty: state.difficulty, stability: state.stability,
    intervalDays, lapses: state.lapses,
    relearning: false, goodStreak: 0, againStreak: 0,
    elapsedDays: state.lastReviewedAt
      ? Math.max(0, (deps.now.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
      : intervalDays,
  }, grade, {
    ...DEFAULT_FSRS_CONFIG,
    requestRetention:     retentionFor(deps.retMap, deps.src, deps.tgt, field),
    retentionCalibration: calibrationFor(deps.calMap, deps.src, deps.tgt, field),
  }, opts)
}

function withLanes(state: CardState, direction: ProgramDirection, days: number, dueAt: string): Partial<CardState> {
  return {
    intervalDays: days, scheduledIntervalDays: days, dueAt,
    ...(direction === 'production'
      ? {
          ...(state.smartDueAt  != null ? { smartIntervalDays: days, smartDueAt: dueAt } : {}),
          ...(state.typedDueAt  != null ? { typedIntervalDays: days, typedDueAt: dueAt } : {}),
          ...(state.recallDueAt != null ? { recallIntervalDays: days, recallDueAt: dueAt } : {}),
        }
      : { recallIntervalDays: days, recallDueAt: dueAt }),
  }
}

/** The grow-only interval push for a partially completed program: toward the full Good
 *  interval, by `strength`. No rating, no reps, memory state untouched.
 *
 *  `base` is the word's PRE-PROGRAM interval (WordProgress.base). The push always computes
 *  from it, never from the row's current interval — so applying the boost twice (second lock
 *  press, resumed run, finalize after a lock) is a no-op, not a compounding 40% step
 *  (2026-11-20 double-boost bug). Legacy progress without a base falls back to the current
 *  interval, which can still only grow. */
export function boostRow(state: CardState, direction: ProgramDirection, strength: number, deps: ProgramDeps, base?: number): CardState {
  const cur = rowInterval(state, direction)
  const old = base ?? cur
  const full = fsrsFor(state, direction, 'good', deps).intervalDays ?? old
  const days = Math.max(cur, cappedInterval(old, full, strength))
  if (days === cur) return state
  const dueAt = new Date(deps.now.getTime() + days * 86_400_000).toISOString()
  return {
    ...state,
    intervalHistory: appendHistory(state.intervalHistory, days),
    ...withLanes(state, direction, days, dueAt),
  }
}

/** The one real FSRS review for a word that cleared the final stage — growth capped by that
 *  stage's strength, memory bookkeeping in full. `rating` is never 'again' (misses replay).
 *  A hint used on the clearing answer dampens the growth (`hintGrowthFactor`, same as
 *  sessions). */
export function creditRow(state: CardState, direction: ProgramDirection, rating: Rating, strength: number, deps: ProgramDeps, opts: { hintGrowthFactor?: number } = {}): CardState {
  const old = rowInterval(state, direction)
  const fsrs = fsrsFor(state, direction, rating, deps, opts)
  const days = cappedInterval(old, fsrs.intervalDays ?? old, strength)
  const dueAt = new Date(deps.now.getTime() + days * 86_400_000).toISOString()
  return {
    ...state,
    difficulty: fsrs.difficulty, stability: fsrs.stability,
    relearning: false, relearningStep: 0, goodStreak: fsrs.goodStreak, againStreak: 0,
    reps: state.reps + 1,
    lastRating: rating, lastReviewedAt: deps.now.toISOString(),
    intervalHistory: appendHistory(state.intervalHistory, days),
    ...withLanes(state, direction, days, dueAt),
  }
}

/** What one real relearn-loop rating did to the row. */
export type RelearnOutcome =
  | { kind: 'scheduled'; state: CardState }   // escaped the loop — scheduled forward, done today
  | { kind: 'looping';   state: CardState }   // still in the loop — re-shows later this session
  | { kind: 'ladder' }                        // three Agains — back to the learning pipeline

/**
 * A REAL review on a relearn-loop row, inside the program session (user decision 2026-11-20:
 * relearning never leaves the session — the cards weave in as written/recall exercises).
 * Runs the genuine relearn gate via the row's live relearning/streak state: Good×2 or Easy
 * escapes and schedules; Again×3 un-graduates. Lapses are NOT incremented here — the lapse
 * was counted when the row entered the loop.
 */
export function relearnReview(state: CardState, direction: ProgramDirection, rating: Rating, deps: ProgramDeps): RelearnOutcome {
  const field = fieldFor(direction, deps.tracks)
  const intervalDays = rowInterval(state, direction)
  const fsrs = scheduleGraduatedFsrs({
    difficulty: state.difficulty, stability: state.stability,
    intervalDays, lapses: state.lapses,
    relearning: state.relearning, goodStreak: state.goodStreak, againStreak: state.againStreak,
    elapsedDays: state.lastReviewedAt
      ? Math.max(0, (deps.now.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
      : 0,
  }, rating, {
    ...DEFAULT_FSRS_CONFIG,
    requestRetention:     retentionFor(deps.retMap, deps.src, deps.tgt, field),
    retentionCalibration: calibrationFor(deps.calMap, deps.src, deps.tgt, field),
  }, {})
  if (fsrs.sendToLadder) return { kind: 'ladder' }
  const base: CardState = {
    ...state,
    difficulty: fsrs.difficulty, stability: fsrs.stability,
    relearning: fsrs.relearning, goodStreak: fsrs.goodStreak, againStreak: fsrs.againStreak,
    reps: state.reps + 1,
    lastRating: rating, lastReviewedAt: deps.now.toISOString(),
  }
  if (fsrs.intervalDays != null) {
    const days = Math.max(1, fsrs.intervalDays)
    const dueAt = new Date(deps.now.getTime() + days * 86_400_000).toISOString()
    return {
      kind: 'scheduled',
      state: {
        ...base, relearningStep: 0,
        intervalHistory: appendHistory(state.intervalHistory, days),
        ...withLanes(state, direction, days, dueAt),
      },
    }
  }
  const dueAt = new Date(deps.now.getTime() + (fsrs.dueInMinutes ?? 10) * 60_000).toISOString()
  return {
    kind: 'looping',
    state: {
      ...base, relearningStep: 1, dueAt,
      ...(direction === 'recognition'
        ? { recallDueAt: dueAt }
        : {
            ...(state.smartDueAt != null ? { smartDueAt: dueAt } : {}),
            ...(state.typedDueAt != null ? { typedDueAt: dueAt } : {}),
          }),
    },
  }
}

/** The direction's row for a card, from the whole-user state list. */
export function rowForDirection(
  states: { forward: Map<string, CardState>; reverse: Map<string, CardState> },
  cardId: string,
  direction: ProgramDirection,
): CardState | undefined {
  return direction === 'production' ? states.forward.get(cardId) : states.reverse.get(cardId)
}

export function splitStates(all: CardState[]): { forward: Map<string, CardState>; reverse: Map<string, CardState> } {
  return {
    forward: forwardStateMap(all.filter(s => s.reviewDirection !== 'reverse')),
    reverse: new Map(all.filter(s => s.reviewDirection === 'reverse').map(s => [s.cardId, s])),
  }
}

/**
 * Pays out every stale program's pending boosts (highest cleared stage, grow-only) and closes
 * the rows. Runs lazily on app open — cheap no-op when nothing is stale. Returns the number
 * of words boosted. Never throws into callers' load paths.
 */
export async function finalizeStalePrograms(userId: UserId, tz: string, turnoverHour: number, now = new Date()): Promise<number> {
  try {
    const programRepo = new SupabaseReviewProgramRepository()
    const open = await programRepo.listOpen(userId)
    const today = getToday(tz, turnoverHour)
    const stale = open.filter(p => p.day < today)
    if (stale.length === 0) return 0

    const stateRepo = new SupabaseCardStateRepository()
    const [allStates, paramRows] = await Promise.all([
      stateRepo.listAllForUser(userId),
      new SupabaseUserSchedulerParamsRepository().listForUser(userId).catch(() => []),
    ])
    const states = splitStates(allStates)
    const tracksByPair = buildEnabledTracksMap(paramRows)
    const retMap = buildRetentionMap(paramRows)
    const calMap = buildCalibrationMap(paramRows)

    let boosted = 0
    for (const program of stale) {
      const deps: ProgramDeps = {
        userId, src: program.sourceLanguage, tgt: program.targetLanguage, now,
        tracks: tracksByPair.get(`${program.sourceLanguage}|${program.targetLanguage}`),
        retMap, calMap,
      }
      const rows: CardState[] = []
      for (const { cardId, cleared, base } of pendingBoosts(program.progress)) {
        const state = rowForDirection(states, cardId, program.direction)
        if (!state?.graduated || state.dormant) continue
        const strength = earnedStrength(program.stages as StageKind[], cleared)
        if (strength <= 0) continue
        const boosted = boostRow(state, program.direction, strength, deps, base)
        if (boosted !== state) rows.push(boosted)
      }
      if (rows.length > 0) await stateRepo.upsertBatch(rows)
      await programRepo.markFinalized(program.id)
      boosted += rows.length
    }
    return boosted
  } catch (err) {
    console.error('[program] finalize failed (will retry next open):', err)
    return 0
  }
}

/** Today's open program rows, keyed `${src}|${tgt}|${direction}` — the Due page's resume map. */
export async function openProgramsForToday(userId: UserId, today: string): Promise<Map<string, ReviewProgram>> {
  const open = await new SupabaseReviewProgramRepository().listOpen(userId)
  return new Map(open.filter(p => p.day === today).map(p => [`${p.sourceLanguage}|${p.targetLanguage}|${p.direction}`, p]))
}
