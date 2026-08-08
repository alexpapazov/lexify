/**
 * engine/practiceBank.ts — deciding what a practice session asks for, and what it can reuse.
 *
 * Two pure problems, both of which the orchestration layer would otherwise do by feel:
 *
 *   1. **How many sentences, spread how?** The learner asks for either a total or a number per
 *      word, and the generation route takes a bounded batch — so the request has to be planned
 *      into batches rather than sent as one number.
 *
 *   2. **What can come from the bank?** Stored sentences carry their per-word annotations, so
 *      whether one is still usable can be recomputed rather than remembered. That matters because
 *      usability is not a property of the sentence: it depends on the learner's library (which
 *      grows) and on the "% graduated" slider (which they can change). Storing a pass/fail verdict
 *      would go stale in both directions — hence re-scoring here, every read.
 *
 * Pure: no React, no Supabase, no clock, no randomness.
 */

import { scoreSentence, type LibraryIndex, type PracticeTarget } from './practice'
import type { AnnotatedToken } from './practice'

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

// ─── Reusing stored sentences ─────────────────────────────────────────────────

/** The minimum a stored sentence must carry for the bank to judge it. */
export interface BankCandidate {
  id:          string
  targetLemma: string
  tokens:      AnnotatedToken[]
  useCount:    number
}

export interface BankSelection<T extends BankCandidate> {
  /** Sentences to reuse, in session order. */
  reuse: T[]
  /** How many more each lemma still needs (only lemmas with a shortfall). */
  shortfallByLemma: Map<string, number>
}

/**
 * Picks what the session can serve from the bank, and reports what's still missing.
 *
 * A stored sentence is only reused if it **re-scores clean right now** — clears the slider and has
 * no unknown words. A sentence that no longer passes isn't repaired (that would spend an API call
 * to rescue a cached item when generating fresh costs the same); it's simply skipped, and may
 * become usable again later as the library grows.
 *
 * Selection is round-robin across the requested lemmas, least-used first within each, so a session
 * spreads over the chosen words instead of exhausting the first one's bank.
 */
export function pickBankExercises<T extends BankCandidate>(
  stored:          T[],
  index:           LibraryIndex,
  targets:         PracticeTarget[],
  minGraduatedPct: number,
  plan:            SentencePlan,
): BankSelection<T> {
  const wantPerLemma = plan.mode === 'perWord' ? Math.max(0, Math.floor(plan.perWord)) : Infinity
  const wantTotal    = plannedTotal(plan, targets.length)

  // Group the usable candidates by lemma, least-used first.
  const byLemma = new Map<string, T[]>()
  for (const lemma of targets.map(t => t.lemma.trim().toLowerCase())) byLemma.set(lemma, [])
  for (const candidate of stored) {
    const lemma = candidate.targetLemma.trim().toLowerCase()
    const bucket = byLemma.get(lemma)
    if (!bucket) continue                       // not a word this session asked for
    // The whole point: judged against the CURRENT library and slider, never a stored verdict.
    const score = scoreSentence(candidate.tokens, index, [lemma], minGraduatedPct)
    if (!score.passes) continue
    bucket.push(candidate)
  }
  for (const bucket of byLemma.values()) bucket.sort((a, b) => a.useCount - b.useCount)

  const lemmas = [...byLemma.keys()]
  const takenPerLemma = new Map<string, number>(lemmas.map(l => [l, 0]))
  const reuse: T[] = []

  // Round-robin: one sentence per lemma per pass, so every chosen word gets a turn before any word
  // gets a second sentence.
  for (let pass = 0; reuse.length < wantTotal && pass < 1000; pass++) {
    let addedThisPass = false
    for (const lemma of lemmas) {
      if (reuse.length >= wantTotal) break
      const taken = takenPerLemma.get(lemma)!
      if (taken >= wantPerLemma) continue
      const bucket = byLemma.get(lemma)!
      if (pass >= bucket.length) continue
      reuse.push(bucket[pass]!)
      takenPerLemma.set(lemma, taken + 1)
      addedThisPass = true
    }
    if (!addedThisPass) break                   // every bank bucket exhausted
  }

  const shortfallByLemma = new Map<string, number>()
  if (plan.mode === 'perWord') {
    for (const lemma of lemmas) {
      const missing = wantPerLemma - (takenPerLemma.get(lemma) ?? 0)
      if (missing > 0) shortfallByLemma.set(lemma, missing)
    }
  }

  return { reuse, shortfallByLemma }
}
