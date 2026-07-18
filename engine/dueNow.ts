/**
 * engine/dueNow.ts — the Due Now decision logic (FSRS Stage 2, core).
 * Pure, framework-free. Ties the FSRS memory model (engine/fsrs.ts) to Lexify's
 * relearn gate and mess-up grading. The session pages call this; no persistence here.
 *
 * See `features/FSRS Scheduler (proposal).md`.
 */

import type { Rating, TypedStrictness, TypedErrorCategory } from '@/domain'
import {
  type FsrsState, type FsrsConfig, DEFAULT_FSRS_CONFIG,
  nextDifficulty, stabilityAfterSuccess, stabilityAfterLapse, intervalForRetention,
} from './fsrs'

/** Relearn-loop wait times (Due Now): Again 5 min, Hard 10 min, first Good 20 min. */
export const RELEARN_MINUTES = { again: 5, hard: 10, good: 20 } as const

/** A card's Due Now scheduling state. */
export interface DueNowState extends FsrsState {
  /** In the post-lapse relearn loop (must reach 2 Goods in a row, or Easy, to leave). */
  relearning: boolean
  /** Consecutive Goods while relearning (2 → exit). */
  goodStreak: number
  /** Consecutive Agains while relearning (3 → back to the learning ladder). */
  againStreak: number
}

export type DueNowAction =
  | { kind: 'schedule'; intervalDays: number }  // committed to long-term review
  | { kind: 'relearn'; minutes: number }        // stay in the short loop, re-show soon
  | { kind: 'sendToLadder' }                     // 3 Agains in a row → un-graduate

export interface DueNowResult { state: DueNowState; action: DueNowAction }

function scheduled(difficulty: number, stability: number, cfg: FsrsConfig): DueNowResult {
  return {
    state: { difficulty, stability, relearning: false, goodStreak: 0, againStreak: 0 },
    // Floor at 1 day: a *scheduled* (non-relearn) review must never be sub-day, or snapping the due
    // date to the start of the day lands it back on today → the card is perpetually "due now".
    action: { kind: 'schedule', intervalDays: Math.max(1, intervalForRetention(stability, cfg.requestRetention)) },
  }
}

/** Extra context for a review. `hintGrowthFactor` (0–1) dampens the stability gain on a hinted
 *  correct answer — a hint means the recall wasn't cold, so the interval should grow less.
 *  `softLapse` marks an Again that came from a typed *near-miss*
 *  ("almost") rather than a full wrong answer — it still relearns, but must not count toward the
 *  3-in-a-row → back-to-ladder un-graduation (only full wrong answers should). */
export interface ReviewOpts { softLapse?: boolean; hintGrowthFactor?: number }

/**
 * Processes one Due Now review. `elapsedDays` = days since the card was last seen.
 * A clean Hard advances normally (slower growth); only a lapse triggers the gate.
 */
export function reviewDueNow(state: DueNowState, grade: Rating, elapsedDays: number, cfg: FsrsConfig = DEFAULT_FSRS_CONFIG, opts: ReviewOpts = {}): DueNowResult {
  const difficulty = nextDifficulty(state.difficulty, grade)

  // ── Not in the relearn loop ──
  if (!state.relearning) {
    if (grade === 'again') {
      const stability = stabilityAfterLapse(state, elapsedDays, cfg)
      // A near-miss lapse relearns but starts the un-graduate countdown at 0 (doesn't count).
      return { state: { difficulty, stability, relearning: true, goodStreak: 0, againStreak: opts.softLapse ? 0 : 1 }, action: { kind: 'relearn', minutes: RELEARN_MINUTES.again } }
    }
    // Hard / Good / Easy on a clean card → advance (Hard just grows slower).
    const stability = stabilityAfterSuccess({ difficulty, stability: state.stability }, grade, elapsedDays, cfg)
    return scheduled(difficulty, stability, cfg)
  }

  // ── In the relearn loop ──
  if (grade === 'again') {
    // Near-miss ("almost") lapses relearn but never advance the un-graduate counter — only full
    // wrong answers do. A soft lapse leaves againStreak untouched (neither counts nor resets it).
    const againStreak = opts.softLapse ? state.againStreak : state.againStreak + 1
    if (againStreak >= 3) return { state: { difficulty, stability: state.stability, relearning: false, goodStreak: 0, againStreak: 0 }, action: { kind: 'sendToLadder' } }
    return { state: { difficulty, stability: state.stability, relearning: true, goodStreak: 0, againStreak }, action: { kind: 'relearn', minutes: RELEARN_MINUTES.again } }
  }
  if (grade === 'hard') {
    return { state: { difficulty, stability: state.stability, relearning: true, goodStreak: 0, againStreak: 0 }, action: { kind: 'relearn', minutes: RELEARN_MINUTES.hard } }
  }
  if (grade === 'good') {
    const goodStreak = state.goodStreak + 1
    if (goodStreak >= 2) {
      const stability = stabilityAfterSuccess({ difficulty, stability: state.stability }, 'good', elapsedDays, cfg)
      return scheduled(difficulty, stability, cfg)
    }
    return { state: { difficulty, stability: state.stability, relearning: true, goodStreak, againStreak: 0 }, action: { kind: 'relearn', minutes: RELEARN_MINUTES.good } }
  }
  // Easy → leave immediately, with the easy bonus (beats two Goods).
  const stability = stabilityAfterSuccess({ difficulty, stability: state.stability }, 'easy', elapsedDays, cfg)
  return scheduled(difficulty, stability, cfg)
}

// ─── Applying an FSRS review to a card's per-track schedule ─────────────────────

const clampD = (d: number) => Math.min(10, Math.max(1, d))

/** Seed difficulty for an existing (pre-FSRS) graduated card from its lapse count. */
export function seedDifficulty(lapses: number): number { return clampD(5 + 0.7 * lapses) }
/** Seed stability for an existing graduated card from its current interval. */
export function seedStability(currentIntervalDays: number): number { return Math.max(0.5, currentIntervalDays || 1) }

export interface GraduatedFsrsInput {
  difficulty: number | null
  stability: number | null
  /** Current interval (days) for the track being reviewed — used to seed stability if null. */
  intervalDays: number
  lapses: number
  relearning: boolean
  goodStreak: number
  againStreak: number
  /** Days since this track was last reviewed. */
  elapsedDays: number
}

export interface GraduatedFsrsOutput {
  difficulty: number
  stability: number
  relearning: boolean
  goodStreak: number
  againStreak: number
  /** Set when the card is scheduled to long-term review (days). Null in the relearn loop. */
  intervalDays: number | null
  /** Set while relearning (re-show in this many minutes). Null when scheduled. */
  dueInMinutes: number | null
  /** True when three Agains in a row send the card back to the ladder (un-graduate). */
  sendToLadder: boolean
}

/** Applies one graduated review under FSRS, seeding D/S lazily for pre-FSRS cards.
 *  `opts.softLapse` = the Again came from a typed near-miss ("almost"), so it won't count toward
 *  the 3-in-a-row → back-to-ladder un-graduation. */
export function scheduleGraduatedFsrs(cur: GraduatedFsrsInput, grade: Rating, cfg: FsrsConfig = DEFAULT_FSRS_CONFIG, opts: ReviewOpts = {}): GraduatedFsrsOutput {
  const state: DueNowState = {
    difficulty:  cur.difficulty ?? seedDifficulty(cur.lapses),
    stability:   cur.stability ?? seedStability(cur.intervalDays),
    relearning:  cur.relearning,
    goodStreak:  cur.goodStreak,
    againStreak: cur.againStreak,
  }
  const { state: next, action } = reviewDueNow(state, grade, cur.elapsedDays, cfg, opts)
  const base = { difficulty: next.difficulty, stability: next.stability, relearning: next.relearning, goodStreak: next.goodStreak, againStreak: next.againStreak }
  if (action.kind === 'schedule') {
    // Hint dampening: interpolate the *gained* stability back toward the pre-review value, so a
    // hinted correct answer grows the interval less. gf=1 (or unset) → no change; gf<1 → less growth.
    const gf = opts.hintGrowthFactor
    const grew = next.stability > state.stability
    const stability = (gf != null && gf < 1 && grew)
      ? state.stability + Math.max(0, gf) * (next.stability - state.stability)
      : next.stability
    const intervalDays = Math.max(1, intervalForRetention(stability, cfg.requestRetention))
    return { ...base, stability, intervalDays, dueInMinutes: null, sendToLadder: false }
  }
  if (action.kind === 'relearn')  return { ...base, intervalDays: null, dueInMinutes: action.minutes, sendToLadder: false }
  return { ...base, intervalDays: null, dueInMinutes: null, sendToLadder: true }
}

// ─── Mess-up type → grade (varied penalties via the strictness slider) ──────────

const SLIP_KEY: Record<TypedErrorCategory, keyof TypedStrictness> = { accent: 'accents', article: 'articles', spelling: 'spelling' }

/**
 * Maps a typed answer to a grade. A wrong word is always Again. A slip
 * (accent/article/spelling) is graded by the per-category strictness:
 * strict → Again, middle → Hard, lenient → ignored (use the learner's rating).
 * A clean answer uses the learner's chosen rating.
 */
export function gradeFromTyped(opts: {
  status:     'correct' | 'almost' | 'wrong'
  slip:       TypedErrorCategory | null
  strictness: TypedStrictness
  chosen:     Rating
}): Rating {
  if (opts.status === 'wrong') return 'again'
  if (opts.status === 'almost' && opts.slip) {
    const level = opts.strictness[SLIP_KEY[opts.slip]]
    if (level === 'penalize') return 'again'
    if (level === 'retype')   return 'hard'
    return opts.chosen // 'accept' → ignore the slip, grade by the button
  }
  return opts.chosen
}
