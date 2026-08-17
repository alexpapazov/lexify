/**
 * lib/practiceBank.ts — assembling a practice session from the bank first, the API second.
 *
 * Generation is the only expensive part of practice, and the same words get drilled repeatedly, so
 * every generated sentence is filed in `practice_sentences` (migration 113) and reused later. A
 * second session over the same deck is usually free.
 *
 * The bank hands sentences back AS STORED — no re-scoring. Sentences are natural and unconstrained
 * now, so there is no vocabulary verdict for a cached one to fail; the only judgment left is "is it
 * for a word this session asked for", which `pickBankExercises` handles.
 *
 * Writes are best-effort. Failing to file a new sentence, or to bump a use count, costs cache
 * quality on a later session; it must never take down the session in hand.
 */

import {
  pickBankExercises, plannedTotal, planGenerationBatches,
  type SentencePlan,
} from '@/engine/practiceBank'
import type { PracticeTarget } from '@/engine/practice'
import { generatePracticeExercises, prepareExercise, type PreparedExercise } from '@/lib/practiceGenerate'
import { SupabasePracticeSentenceRepository, type StoredSentence } from '@/lib/data/practiceSentences'
import { GENERATE_CAP } from '@/app/api/practice/generate/route'
import { mapLimit } from '@/lib/mapLimit'
import type { ClozeMode } from '@/lib/practiceSchema'

export interface PrepareOptions {
  userId:         string
  targets:        PracticeTarget[]
  sourceLanguage: string
  targetLanguage: string
  plan:           SentencePlan
  /** Native-language sentence with only the blank in the target language. */
  mode?: ClozeMode
}

export interface PreparedSession {
  exercises: PreparedExercise[]
  /** How many came from the bank rather than the API — surfaced so "free" sessions are visible. */
  fromBank:  number
  /** Sentences the plan asked for that never materialised. */
  missingCount: number
}

/**
 * Builds a session: bank first, then generation for whatever's still missing.
 *
 * In per-word mode the shortfall is per WORD, so generation is asked only for the words that came
 * up short — a word whose bank already covers its quota costs nothing.
 */
export async function preparePracticeSession(opts: PrepareOptions): Promise<PreparedSession> {
  const { userId, targets, sourceLanguage, targetLanguage, plan } = opts
  const wanted = plannedTotal(plan, targets.length)
  if (targets.length === 0 || wanted <= 0) {
    return { exercises: [], fromBank: 0, missingCount: 0 }
  }
  const mode = opts.mode ?? 'target'

  const repo = new SupabasePracticeSentenceRepository()
  let stored: StoredSentence[] = []
  try {
    stored = await repo.listForLemmas(userId, sourceLanguage, targetLanguage,
      targets.map(t => t.lemma))
  } catch {
    stored = []          // a bank read failure just means everything is generated fresh
  }

  const { reuse, shortfallByLemma } = pickBankExercises(
    stored.map(s => ({ id: s.id, targetLemma: s.targetLemma, useCount: s.useCount })),
    targets, plan,
  )
  const reusedById = new Map(stored.map(s => [s.id, s]))
  const fromBank = reuse
    .map(r => reusedById.get(r.id))
    .filter((s): s is StoredSentence => s != null)
    .map(s => prepareExercise(s.exercise, targets))

  // ── What still needs generating ────────────────────────────────────────────
  const generated: PreparedExercise[] = []
  if (plan.mode === 'perWord') {
    // Group the short words by how many each still needs, so one call can serve several words that
    // want the same amount.
    const byShortfall = new Map<number, PracticeTarget[]>()
    for (const t of targets) {
      const missing = shortfallByLemma.get(t.lemma.trim().toLowerCase()) ?? 0
      if (missing <= 0) continue
      const group = byShortfall.get(missing) ?? []
      group.push(t)
      byShortfall.set(missing, group)
    }
    const runs = await mapLimit([...byShortfall.entries()], 2, ([missing, group]) =>
      generatePracticeExercises({
        targets: group, sourceLanguage, targetLanguage,
        count: missing * group.length, mode,
      }))
    for (const run of runs) if (run) generated.push(...run.exercises)
  } else {
    const missing = Math.max(0, wanted - fromBank.length)
    if (missing > 0) {
      const run = await generatePracticeExercises({
        targets, sourceLanguage, targetLanguage, count: missing, mode,
      })
      generated.push(...run.exercises)
    }
  }

  // ── Persist and account, neither of which may break the session ────────────
  void (async () => {
    try {
      const fileable = generated
        .filter(g => g.exercise.targetLemma)
        .map(g => ({ targetLemma: g.exercise.targetLemma, exercise: g.exercise }))
      await repo.saveMany(userId, sourceLanguage, targetLanguage, fileable)
    } catch { /* cache write only */ }
  })()
  void repo.markUsed(fromBank.map((_, i) => reuse[i]!.id)).catch(() => {})

  const exercises = [...fromBank, ...generated]
  return {
    exercises,
    fromBank: fromBank.length,
    missingCount: Math.max(0, wanted - exercises.length),
  }
}

/** Re-exported so the page can size its controls against the same cap the planner uses. */
export { GENERATE_CAP, planGenerationBatches }
export type { SentencePlan }
