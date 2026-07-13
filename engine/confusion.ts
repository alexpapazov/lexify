/**
 * engine/confusion.ts — pure detection + penalty for PRODUCTION CONFUSIONS: on a typed production
 * review you type word B when the card wanted A. That's a discrimination failure (you can't tell the
 * two target words apart), best fixed by recognition work — so we link the pair, penalize the
 * RECOGNITION track of both, and (session layer) queue an A-vs-B drill. Framework-free.
 */

import type { GradingSettings } from '@/domain'
import { isDifferentWordMistake } from './grading'
import { intervalForRetention, DEFAULT_FSRS_CONFIG } from './fsrs'

/** Normalize a word for cross-card matching: NFC, drop (f)/[note] annotations, collapse space, lowercase. */
export function normalizeForMatch(s: string): string {
  return s.normalize('NFC').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

export interface SiblingCard { cardId: string; front: string }

/**
 * Detects a confusion: the learner typed a GENUINE different word (not a typo — per
 * `isDifferentWordMistake`) that exactly matches another card's target word (`front`). Returns that
 * card's id (B), or null. Matches across the whole library (`siblings`); the current card is excluded.
 */
export function findConfusedSibling(
  typed: string, expectedFront: string, currentCardId: string,
  siblings: SiblingCard[], settings: GradingSettings,
): string | null {
  if (!isDifferentWordMistake(typed, expectedFront, settings)) return null
  const key = normalizeForMatch(typed)
  if (!key) return null
  for (const s of siblings) {
    if (s.cardId === currentCardId) continue
    if (normalizeForMatch(s.front) === key) return s.cardId
  }
  return null
}

// Recognition-track FSRS penalty for a confusion — cut stability (comes back sooner), bump difficulty
// (grows slower). Persistent, unlike a raw interval cut which the next review would recompute away.
export const CONFUSION_STABILITY_FACTOR = 0.5
export const CONFUSION_DIFFICULTY_DELTA = 1.0

/**
 * Penalized difficulty/stability + the resulting recognition interval (days) for a confused card's
 * recognition track. Returns null when the card has no FSRS state yet (nothing to penalize).
 */
export function confusionPenalty(
  state: { difficulty: number | null; stability: number | null },
  retention: number = DEFAULT_FSRS_CONFIG.requestRetention,
): { difficulty: number; stability: number; intervalDays: number } | null {
  if (state.difficulty == null || state.stability == null) return null
  const difficulty = Math.min(10, state.difficulty + CONFUSION_DIFFICULTY_DELTA)
  const stability  = Math.max(0.5, state.stability * CONFUSION_STABILITY_FACTOR)
  return { difficulty, stability, intervalDays: Math.max(1, Math.round(intervalForRetention(stability, retention))) }
}
