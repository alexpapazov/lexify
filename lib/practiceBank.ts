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

/** How a progressive session reports back while its later batches are still in flight. */
export interface ProgressCallbacks {
  /**
   * Fires ONCE, with the first playable exercises — bank hits when there are any (instant),
   * otherwise the first generated sentence. The learner starts here; everything else streams in
   * behind them.
   */
  onReady:  (first: PreparedExercise[]) => void
  /** Fires per background batch as it lands, already prepared for the player. */
  onAppend: (more: PreparedExercise[]) => void
}

/**
 * Builds a session progressively: bank first, then generation for whatever's still missing — but
 * the learner waits only for the FIRST playable sentence, never the whole run.
 *
 * The wait profile is deliberate:
 *  - Any bank hit → `onReady` fires immediately, all generation happens behind the player.
 *  - Empty bank → a STARTER batch of exactly one sentence for the first word is generated alone,
 *    so the wait is one single-sentence API call rather than the full plan. The remaining work is
 *    re-planned with that word's quota reduced by one and streamed in via `onAppend`.
 *
 * The returned promise resolves when everything has settled, with the final accounting. It rejects
 * only when NOTHING could be prepared — once `onReady` has fired, later failures degrade to a
 * shorter session (reported via `missingCount`), never a dead one.
 *
 * In per-word mode the shortfall is per WORD, so generation is asked only for the words that came
 * up short — a word whose bank already covers its quota costs nothing.
 */
export async function preparePracticeSessionProgressive(
  opts: PrepareOptions,
  cb: ProgressCallbacks,
): Promise<PreparedSession> {
  const { userId, targets, sourceLanguage, targetLanguage, plan } = opts
  const wanted = plannedTotal(plan, targets.length)
  if (targets.length === 0 || wanted <= 0) {
    cb.onReady([])
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
  void repo.markUsed(reuse.map(r => r.id)).catch(() => {})

  // ── The generation work-list ───────────────────────────────────────────────
  // Per-word: groups keyed by how many sentences each word still needs, so one call serves several
  // words wanting the same amount. Total: one pool over all targets.
  const groups: Array<{ targets: PracticeTarget[]; count: number }> = []
  if (plan.mode === 'perWord') {
    const byShortfall = new Map<number, PracticeTarget[]>()
    for (const t of targets) {
      const missing = shortfallByLemma.get(t.lemma.trim().toLowerCase()) ?? 0
      if (missing <= 0) continue
      const group = byShortfall.get(missing) ?? []
      group.push(t)
      byShortfall.set(missing, group)
    }
    for (const [missing, group] of byShortfall) groups.push({ targets: group, count: missing * group.length })
  } else {
    const missing = Math.max(0, wanted - fromBank.length)
    if (missing > 0) groups.push({ targets, count: missing })
  }

  let ready = false
  const settle = (first: PreparedExercise[]) => { ready = true; cb.onReady(first) }

  // With no bank hits, carve one single-sentence starter off the first group so the learner's wait
  // is ONE sentence, not the plan. The group keeps the remainder.
  let starter: { targets: PracticeTarget[] } | null = null
  if (fromBank.length === 0 && groups.length > 0) {
    const g = groups[0]!
    const starterTarget = g.targets[0]!
    starter = { targets: [starterTarget] }
    if (g.count <= 1) groups.shift()
    else {
      // Per-word groups must stay per-word exact: the starter word moves to its own reduced group.
      if (plan.mode === 'perWord') {
        const per = g.count / g.targets.length
        g.targets = g.targets.filter(t => t !== starterTarget)
        g.count = per * g.targets.length
        if (per > 1) groups.push({ targets: [starterTarget], count: per - 1 })
        if (g.targets.length === 0) groups.shift()
      } else {
        g.count -= 1
      }
    }
  }

  const persist = (made: PreparedExercise[]) => {
    void (async () => {
      try {
        const fileable = made
          .filter(g => g.exercise.targetLemma)
          .map(g => ({ targetLemma: g.exercise.targetLemma, exercise: g.exercise }))
        await repo.saveMany(userId, sourceLanguage, targetLanguage, fileable)
      } catch { /* cache write only */ }
    })()
  }

  let produced = fromBank.length
  const errors: unknown[] = []

  if (fromBank.length > 0) settle(fromBank)

  if (starter) {
    try {
      const run = await generatePracticeExercises({
        targets: starter.targets, sourceLanguage, targetLanguage, count: 1, mode,
      })
      produced += run.exercises.length
      persist(run.exercises)
      settle(run.exercises)
    } catch (err) {
      errors.push(err)
      // The starter died; the remaining groups are now the only chance to open the session, so the
      // first of them to land must fire onReady instead of onAppend.
    }
  }

  // ── Everything else streams in behind the player ───────────────────────────
  await mapLimit(groups, 2, async (g) => {
    try {
      const run = await generatePracticeExercises({
        targets: g.targets, sourceLanguage, targetLanguage, count: g.count, mode,
      })
      if (run.exercises.length === 0) return
      produced += run.exercises.length
      persist(run.exercises)
      if (ready) cb.onAppend(run.exercises)
      else settle(run.exercises)
    } catch (err) {
      errors.push(err)
    }
  })

  if (!ready) {
    // Nothing at all became playable. Surface the first real failure rather than an empty session.
    if (errors.length > 0) throw errors[0]
    settle([])
  }
  return {
    exercises: [],        // streamed via callbacks; kept for the wrapper below
    fromBank: fromBank.length,
    missingCount: Math.max(0, wanted - produced),
  }
}

/**
 * The all-at-once wrapper: collects the progressive stream and returns everything together. Kept
 * because tests and any non-streaming caller want a single array, and so the progressive core has
 * exactly one implementation.
 */
export async function preparePracticeSession(opts: PrepareOptions): Promise<PreparedSession> {
  const collected: PreparedExercise[] = []
  const session = await preparePracticeSessionProgressive(opts, {
    onReady:  (first) => collected.push(...first),
    onAppend: (more)  => collected.push(...more),
  })
  return { ...session, exercises: collected }
}

/** Re-exported so the page can size its controls against the same cap the planner uses. */
export { GENERATE_CAP, planGenerationBatches }
export type { SentencePlan }
