/**
 * engine/program.ts — the PROGRAM BUILDER's scheduling math (Due Now Redesign Part 2, design
 * concluded 2026-11-20). Pure; lib/program.ts applies it to card_states rows.
 *
 * A day's review of a batch is a PROGRAM: an ordered chain of exercise stages. Clearing a
 * stage earns a progressively larger interval push; only clearing the FINAL stage is a real
 * FSRS review. The user's credit model:
 *
 *  - Stage clears accumulate during the (turnover-aware) day. At day turnover, each word is
 *    finalized with the boost of its highest cleared stage — a GROW-ONLY interval push, no
 *    rating, no reps, memory state untouched (same spirit as implicit reading credit).
 *  - Clearing the final stage credits IMMEDIATELY: one real FSRS review (rating from that
 *    stage), with the interval growth capped by the final stage's strength.
 *  - A "lock in this interval now" action cashes the current boost out early.
 *
 * Strength says how far toward the full FSRS growth a stage can carry the interval:
 * newInterval = oldInterval + strength × (fullFsrsInterval − oldInterval), grow-only.
 * Matching is recognition evidence (0.4); cloze is production in context (0.75); real recall
 * is the full review (1.0). User-confirmed numbers, tunable here in one place.
 */

import type { Rating } from '@/domain'

export type StageKind = 'matching' | 'cloze' | 'recall' | 'typed'

export const STAGE_STRENGTH: Record<StageKind, number> = {
  matching: 0.4,
  cloze:    0.9,   // typed production in context — barely dampened (user tune 2026-11-20)
  recall:   1,
  typed:    1,
}

export const STAGE_LABEL: Record<StageKind, string> = {
  matching: 'Matching',
  cloze:    'Cloze',
  recall:   'Active recall',
  typed:    'Typed recall',
}

/** Which stages a batch's direction can run: cloze and typing produce the target word, so
 *  they exist only for the production direction; recognition warms up with matching and
 *  finishes with self-graded recall. */
export function stagesForDirection(direction: 'production' | 'recognition'): StageKind[] {
  return direction === 'production' ? ['matching', 'cloze', 'recall', 'typed'] : ['matching', 'recall']
}

/** The strength a word has EARNED after clearing `cleared` stages of `stages` — the max over
 *  the cleared prefix (presets are monotone, but a custom chain must never lose strength by
 *  adding a weaker warm-up later). 0 when nothing cleared. */
export function earnedStrength(stages: StageKind[], cleared: number): number {
  let s = 0
  for (const st of stages.slice(0, Math.max(0, cleared))) s = Math.max(s, STAGE_STRENGTH[st])
  return s
}

/** Grow-only capped interval: old + strength × (full − old), floored at 1 day, never shrinks. */
export function cappedInterval(oldIntervalDays: number, fullIntervalDays: number, strength: number): number {
  const old = Math.max(1, oldIntervalDays)
  const grown = old + Math.max(0, strength) * (fullIntervalDays - old)
  return Math.max(old, Math.max(1, Math.round(grown)))
}

/** The one real review's rating from the final stage's outcome: matching has no buttons (a
 *  clean finish is Good); graded stages pass their rating through. 'again' never reaches here
 *  — misses replay in-stage (user rule 2026-11-15). */
export function finalStageRating(stage: StageKind, rated: Rating | null): Rating {
  if (stage === 'matching') return 'good'
  return rated && rated !== 'again' ? rated : 'good'
}

/** One word's progress inside a day's program — serializable into the day-state row. */
export interface WordProgress {
  /** Stages cleared so far (0..stages.length). */
  cleared: number
  /** 'credited' = cleared the final stage (real review written, done for the day);
   *  'locked' = the learner cashed out the current boost early (also done for the day). */
  done?: 'credited' | 'locked'
}

/** Words that still owe a turnover boost: progressed, not credited, not locked. */
export function pendingBoosts(progress: Record<string, WordProgress>): { cardId: string; cleared: number }[] {
  return Object.entries(progress)
    .filter(([, p]) => p.cleared > 0 && !p.done)
    .map(([cardId, p]) => ({ cardId, cleared: p.cleared }))
}
