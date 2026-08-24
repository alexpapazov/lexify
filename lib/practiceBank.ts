/**
 * lib/practiceBank.ts — assembling a practice session. Fresh sentences EVERY time.
 *
 * ── There is deliberately NO sentence cache here ──────────────────────────────
 * This file used to run a reuse bank (`practice_sentences`, migration 113): every generated
 * sentence was filed and replayed in later sessions. The user removed it on purpose, twice over:
 *
 *  1. The bank was MODE-BLIND. It stored full-target-language sentences from normal sessions and
 *     native-cloze sessions reused them verbatim — a "one Greek word only" session served an
 *     all-Greek sentence from an earlier session's cache.
 *  2. Even mode-filtered, replaying the same sentence for the same word defeats the exercise:
 *     the learner starts recognising the SENTENCE, not recalling the word.
 *
 * So every session generates anew. The `practice_sentences` table still exists (data is harmless)
 * but nothing reads or writes it; drop it whenever convenient. Do not reintroduce caching here
 * without the user asking for it.
 *
 * The progressive shape stays: the learner waits for the FIRST sentence only, the rest stream in
 * behind the player.
 */

import { plannedTotal, planGenerationBatches, type SentencePlan } from '@/engine/practiceBank'
import type { PracticeTarget } from '@/engine/practice'
import { generatePracticeExercises, type PreparedExercise } from '@/lib/practiceGenerate'
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
  /** Sentences the plan asked for that never materialised. */
  missingCount: number
}

/** How a progressive session reports back while its later batches are still in flight. */
export interface ProgressCallbacks {
  /**
   * Fires ONCE, with the first playable exercise(s) — the learner starts here; everything else
   * streams in behind them.
   */
  onReady:  (first: PreparedExercise[]) => void
  /** Fires per background batch as it lands, already prepared for the player. */
  onAppend: (more: PreparedExercise[]) => void
}

/**
 * Builds a session progressively: the learner waits only for the FIRST playable sentence.
 *
 * A STARTER batch of exactly one sentence for the first word is generated alone, so the wait is one
 * single-sentence API call rather than the full plan. The remaining work is re-planned with that
 * word's quota reduced by one and streamed in via `onAppend`.
 *
 * The returned promise resolves when everything has settled, with the final accounting. It rejects
 * only when NOTHING could be prepared — once `onReady` has fired, later failures degrade to a
 * shorter session (reported via `missingCount`), never a dead one.
 */
export async function preparePracticeSessionProgressive(
  opts: PrepareOptions,
  cb: ProgressCallbacks,
): Promise<PreparedSession> {
  const { targets, sourceLanguage, targetLanguage, plan } = opts
  const wanted = plannedTotal(plan, targets.length)
  if (targets.length === 0 || wanted <= 0) {
    cb.onReady([])
    return { exercises: [], missingCount: 0 }
  }
  const mode = opts.mode ?? 'target'

  // One group covering the whole plan; the starter is carved off it below.
  const groups: Array<{ targets: PracticeTarget[]; count: number }> =
    [{ targets, count: wanted }]

  let ready = false
  const settle = (first: PreparedExercise[]) => { ready = true; cb.onReady(first) }

  // Carve one single-sentence starter off the first group so the learner's wait is ONE sentence,
  // not the plan. The group keeps the remainder.
  let starter: { targets: PracticeTarget[] } | null = null
  {
    const g = groups[0]!
    const starterTarget = g.targets[0]!
    starter = { targets: [starterTarget] }
    if (g.count <= 1) groups.shift()
    else if (plan.mode === 'perWord') {
      // Per-word groups must stay per-word exact: the starter word moves to its own reduced group.
      const per = g.count / g.targets.length
      g.targets = g.targets.filter(t => t !== starterTarget)
      g.count = per * g.targets.length
      if (per > 1) groups.push({ targets: [starterTarget], count: per - 1 })
      if (g.targets.length === 0) groups.shift()
    } else {
      g.count -= 1
    }
  }

  let produced = 0
  const errors: unknown[] = []

  try {
    const run = await generatePracticeExercises({
      targets: starter.targets, sourceLanguage, targetLanguage, count: 1, mode,
    })
    produced += run.exercises.length
    settle(run.exercises)
  } catch (err) {
    errors.push(err)
    // The starter died; the remaining groups are now the only chance to open the session, so the
    // first of them to land must fire onReady instead of onAppend.
  }

  // ── Everything else streams in behind the player ───────────────────────────
  await mapLimit(groups, 2, async (g) => {
    try {
      const run = await generatePracticeExercises({
        targets: g.targets, sourceLanguage, targetLanguage, count: g.count, mode,
      })
      if (run.exercises.length === 0) return
      produced += run.exercises.length
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
