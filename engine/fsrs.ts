/**
 * engine/fsrs.ts — the FSRS-style memory model for Due Now scheduling (Stage 1).
 * Pure, framework-free math. See `features/FSRS Scheduler (proposal).md`.
 *
 * Each graduated card carries Difficulty (1–10) and Stability (days). Retrievability
 * (chance of recall right now) is derived from stability + elapsed time. The next
 * interval is the stability scaled to the desired retention.
 *
 * Difficulty is Lexify's own (cumulative deltas, persistent). Stability growth/decay
 * uses the FSRS formula shape with published default weights (we don't train the
 * 19-weight optimizer — calibration nudges a couple of knobs instead).
 */

import type { Rating } from '@/domain'

export interface FsrsState { difficulty: number; stability: number }

/** FSRS-5 published default weights (open-spaced-repetition). Indices used below. */
export const DEFAULT_FSRS_WEIGHTS = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
] as const

export interface FsrsConfig {
  weights: readonly number[]
  /** Desired retention (0.80–0.95). Higher = shorter intervals. */
  requestRetention: number
  /** Calibration knob (default 1): scales how much stability grows on a success. */
  growth: number
}

export const DEFAULT_FSRS_CONFIG: FsrsConfig = {
  weights: DEFAULT_FSRS_WEIGHTS,
  requestRetention: 0.9,
  growth: 1,
}

/** Lexify's custom, cumulative difficulty deltas. */
export const DIFFICULTY_DELTA: Record<Rating, number> = { again: 2.0, hard: 0.6, good: 0, easy: -2.0 }
export const BASE_DIFFICULTY = 5
/**
 * Mean-reversion pull toward BASE_DIFFICULTY applied on every review (FSRS-5 style).
 * Without it, Good's 0 delta means a card that ratchets up to difficulty 10 is frozen
 * there (only Easy lowers it) — and at difficulty 10 the stability-growth factor
 * `(11 − D)` bottoms out, so the card is pinned at ~1-day intervals no matter how many
 * times you rate it Good ("difficulty hell"). The gentle pull lets a run of Goods walk a
 * maxed-out card back down, while Again still climbs and Easy still drops fast.
 */
export const DIFFICULTY_REVERSION = 0.1

/**
 * Anki-style interval fuzz: given a scheduled interval (days), returns the
 * `[minDays, maxDays]` window (absolute interval days from the last review) that
 * the due date may land anywhere within, so a batch reviewed the same day doesn't
 * pile up on the exact same future day forever. Density smoothing then picks the
 * least-crowded day in this window. Very short intervals aren't fuzzed.
 *
 * The same window is used both when scheduling a review and by the "redistribute"
 * tools, so redistribution only ever moves a card within its own fuzz window.
 */
export function fsrsFuzzRange(intervalDays: number): [number, number] {
  const i = intervalDays
  if (i < 2.5) return [i, i]                       // too short to fuzz
  const fuzz = Math.max(1, Math.round(i * 0.05))   // ±5%, at least a day
  return [Math.max(1, i - fuzz), i + fuzz]
}

const LN_09 = Math.log(0.9)
const clampD = (d: number) => Math.min(10, Math.max(1, d))
const clampRetention = (r: number) => Math.min(0.97, Math.max(0.70, r))

// ─── Retrievability & interval ───────────────────────────────────────────────

/** Chance of recall now: R = 0.9 ^ (elapsedDays / stability). R(S) = 0.9. */
export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0
  return Math.pow(0.9, elapsedDays / stability)
}

/** Days until recall falls to `requestRetention`: t = S · ln(r)/ln(0.9). */
export function intervalForRetention(stability: number, requestRetention: number): number {
  return stability * (Math.log(clampRetention(requestRetention)) / LN_09)
}

// ─── Difficulty ──────────────────────────────────────────────────────────────

export function nextDifficulty(difficulty: number, grade: Rating): number {
  const afterDelta = difficulty + DIFFICULTY_DELTA[grade]
  // Pull toward the baseline so difficulty can't get permanently stuck at the ceiling.
  const reverted = afterDelta + DIFFICULTY_REVERSION * (BASE_DIFFICULTY - afterDelta)
  return clampD(reverted)
}

/** Difficulty a card graduates with: base + the cumulative deltas of its learning history. */
export function initialDifficulty(learningGrades: Rating[]): number {
  return clampD(BASE_DIFFICULTY + learningGrades.reduce((sum, g) => sum + DIFFICULTY_DELTA[g], 0))
}

// ─── Stability ───────────────────────────────────────────────────────────────

const GRADE_INDEX: Record<Rating, number> = { again: 0, hard: 1, good: 2, easy: 3 }

/** Stability a card graduates with, from its graduating grade. */
export function initialStability(grade: Rating, cfg: FsrsConfig = DEFAULT_FSRS_CONFIG): number {
  return Math.max(0.1, cfg.weights[GRADE_INDEX[grade]]!)
}

/** New stability after a SUCCESS (Hard/Good/Easy). Bigger when D is low and when reviewed late. */
export function stabilityAfterSuccess(state: FsrsState, grade: Rating, elapsedDays: number, cfg: FsrsConfig = DEFAULT_FSRS_CONFIG): number {
  const w = cfg.weights
  const R = retrievability(elapsedDays, state.stability)
  const hardPenalty = grade === 'hard' ? w[15]! : 1
  const easyBonus   = grade === 'easy' ? w[16]! : 1
  const inc = Math.exp(w[8]!) * (11 - state.difficulty) * Math.pow(state.stability, -w[9]!)
    * (Math.exp(w[10]! * (1 - R)) - 1) * hardPenalty * easyBonus
  return state.stability * (1 + cfg.growth * inc)
}

/** New stability after a LAPSE (Again). Reduced by difficulty & prior stability; never grows. */
export function stabilityAfterLapse(state: FsrsState, elapsedDays: number, cfg: FsrsConfig = DEFAULT_FSRS_CONFIG): number {
  const w = cfg.weights
  const R = retrievability(elapsedDays, state.stability)
  const post = w[11]! * Math.pow(state.difficulty, -w[12]!) * (Math.pow(state.stability + 1, w[13]!) - 1) * Math.exp(w[14]! * (1 - R))
  return Math.min(post, state.stability)
}

// ─── One review (convenience) ────────────────────────────────────────────────

export interface FsrsReview { difficulty: number; stability: number; intervalDays: number }

/** Applies one review: updates difficulty, then stability, then the next interval. */
export function reviewCard(state: FsrsState, grade: Rating, elapsedDays: number, cfg: FsrsConfig = DEFAULT_FSRS_CONFIG): FsrsReview {
  const difficulty = nextDifficulty(state.difficulty, grade)
  const stability = grade === 'again'
    ? stabilityAfterLapse(state, elapsedDays, cfg)
    : stabilityAfterSuccess({ difficulty, stability: state.stability }, grade, elapsedDays, cfg)
  return { difficulty, stability, intervalDays: intervalForRetention(stability, cfg.requestRetention) }
}
