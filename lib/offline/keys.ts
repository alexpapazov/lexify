/**
 * lib/offline/keys.ts — pure primary-key derivation for the offline store. Kept separate (no Dexie)
 * so the key logic is unit-testable and reusable by the sync engine.
 */

/** card_states: one row per (card, direction). */
export function cardStateKey(cardId: string, reviewDirection: string): string {
  return `${cardId}:${reviewDirection}`
}

/** learning_ladders: one effective ladder per pair (or the user default). */
export function ladderKey(source: string | null, target: string | null): string {
  return source && target ? `${source}|${target}` : 'default'
}

/** user_scheduler_params: one row per (pair, answer_field). */
export function paramKey(source: string, target: string, answerField: string): string {
  return `${source}|${target}:${answerField}`
}

/** typed_answer_overrides: one row per (card, side, normalized answer text). */
export function overrideKey(cardId: string, answerSide: string, answerText: string): string {
  return `${cardId}:${answerSide}:${answerText}`
}
