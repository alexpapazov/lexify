/**
 * engine/practiceBank.ts — planning how many sentences a practice session asks for, and in what
 * batches. (The "bank" in the name is historical: the sentence-reuse cache that lived alongside
 * this was removed at the user's request — every session generates fresh sentences. See the note
 * in lib/practiceBank.ts.)
 *
 * The learner asks for either a total or a number per word, and the generation route takes a
 * bounded batch — so the request has to be planned into batches rather than sent as one number.
 */

import type { PracticeTarget } from './practice'

// ─── How many sentences, and how they're spread ───────────────────────────────

export type SentencePlan =
  /** `count` sentences in total, spread across whatever words were chosen. */
  | { mode: 'total';   count: number }
  /** `perWord` sentences for EACH chosen word — the total scales with the selection. */
  | { mode: 'perWord'; perWord: number }

/** How many sentences a plan actually asks for, given the chosen words. */
export function plannedTotal(plan: SentencePlan, targetCount: number): number {
  return plan.mode === 'total'
    ? Math.max(0, plan.count)
    : Math.max(0, plan.perWord) * targetCount
}

export interface GenerationBatch {
  targets: PracticeTarget[]
  count:   number
}

/**
 * Splits a request into batches the generation route will accept (`cap` sentences each).
 *
 * The two modes want different shapes:
 *
 *   - **total** — every batch sees ALL the words and the model spreads its sentences over them, so
 *     a 3-sentence request over 20 words picks 3 of the 20 rather than drilling the first 3.
 *   - **perWord** — words are grouped so that `group.length × perWord` fits in a batch, because
 *     each word needs a guaranteed number of sentences and a shared batch can't promise that.
 */
export function planGenerationBatches(
  targets: PracticeTarget[], plan: SentencePlan, cap: number,
): GenerationBatch[] {
  if (targets.length === 0 || cap <= 0) return []

  if (plan.mode === 'perWord') {
    const perWord = Math.max(0, Math.floor(plan.perWord))
    if (perWord === 0) return []
    // At least one word per batch even when perWord alone exceeds the cap — that word then gets a
    // batch asking for more than `cap`… which the route would reject, so clamp the ask instead.
    const perBatch = Math.max(1, Math.floor(cap / perWord))
    const batches: GenerationBatch[] = []
    for (let i = 0; i < targets.length; i += perBatch) {
      const group = targets.slice(i, i + perBatch)
      batches.push({ targets: group, count: Math.min(cap, group.length * perWord) })
    }
    return batches
  }

  const total = Math.max(0, Math.floor(plan.count))
  const batches: GenerationBatch[] = []
  for (let remaining = total; remaining > 0; remaining -= cap) {
    batches.push({ targets, count: Math.min(cap, remaining) })
  }
  return batches
}
