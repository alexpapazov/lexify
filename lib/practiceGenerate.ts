/**
 * lib/practiceGenerate.ts — one pass: ask the generator for natural sentences, parse, done.
 *
 * This used to be a generate → score → repair → verify loop that steered sentences toward the
 * learner's known words. That machinery is gone: it tripled the latency (three model round-trips
 * per batch) and the vocabulary constraint made sentences stilted. Sentences are natural and
 * unconstrained now — the library annotates them in the player (click a word → your card) instead
 * of censoring them at generation time.
 */

import { apiUrl } from '@/lib/apiBase'
import { mapLimit } from '@/lib/mapLimit'
import { planGenerationBatches } from '@/engine/practiceBank'
import type { PracticeTarget } from '@/engine/practice'
import { GENERATE_CAP } from '@/app/api/practice/generate/route'
import type { PracticeExercise, ClozeMode } from '@/lib/practiceSchema'

/** Generation calls in flight when one request needs several batches. */
const GENERATE_CONCURRENCY = 3

/** A generated exercise, ready to play. */
export interface PreparedExercise {
  exercise: PracticeExercise
  /** The drilled card, when the target lemma resolves to one — the attempt log links through this. */
  targetCardId: string | null
  /**
   * Native meaning of the word that belongs in the blank — shown INSIDE the blank, so the exercise
   * is "produce this meaning, correctly inflected" rather than "guess which word is missing".
   * Prefers the generator's in-context gloss for the exact surface form; falls back to the card's
   * own gloss, which is the wording the learner already studies.
   */
  targetGloss: string
}

export interface PracticeRun {
  exercises: PreparedExercise[]
  /** How many exercises the model failed to produce (asked minus returned). */
  missingCount: number
}

export interface GenerateOptions {
  targets:        PracticeTarget[]
  sourceLanguage: string
  targetLanguage: string
  count:          number
  /** Native-language sentence with only the blank in the target language. */
  mode?: ClozeMode
}

/** Attaches the blank's prompt gloss to each parsed exercise. */
export function prepareExercise(exercise: PracticeExercise, targets: PracticeTarget[]): PreparedExercise {
  const answerToken = exercise.tokens.find(t => t.text === exercise.answer)
  const targetCard  = targets.find(t => t.lemma.trim().toLowerCase() === exercise.targetLemma)
  return {
    exercise,
    targetCardId: targetCard?.cardId ?? null,
    targetGloss: (answerToken?.gloss || targetCard?.back || '').trim(),
  }
}

/**
 * Generates a batch of cloze exercises. The route takes a bounded number of sentences per call, so
 * a big ask becomes several concurrent calls; a failed batch costs its own sentences, not the
 * session.
 */
export async function generatePracticeExercises(opts: GenerateOptions): Promise<PracticeRun> {
  const { targets, count } = opts
  if (targets.length === 0 || count <= 0) return { exercises: [], missingCount: 0 }

  const batches = planGenerationBatches(targets, { mode: 'total', count }, GENERATE_CAP)
  const errors: unknown[] = []
  const runs = await mapLimit(batches, GENERATE_CONCURRENCY, async batch => {
    try {
      const res = await fetch(apiUrl('/api/practice/generate'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          targets: batch.targets.map(t => ({ front: t.front, back: t.back, lemma: t.lemma, pos: t.pos })),
          sourceLanguage: opts.sourceLanguage,
          targetLanguage: opts.targetLanguage,
          count: batch.count,
          mode: opts.mode ?? 'target',
        }),
      })
      const data = await res.json()
      if (!data?.ok || !Array.isArray(data.exercises)) throw new Error(data?.reason ?? 'generate-failed')
      return (data.exercises as PracticeExercise[]).map(e => prepareExercise(e, batch.targets))
    } catch (err) {
      errors.push(err)      // captured here because mapLimit only reports a failure as `null`
      return null
    }
  })

  const exercises = runs.filter((r): r is PreparedExercise[] => r !== null).flat()
  // One bad batch among several just costs its own sentences. But if nothing came back at all, the
  // caller needs the reason ("no-api-key") rather than a silent empty session.
  if (exercises.length === 0 && errors.length > 0) throw errors[0]
  return { exercises, missingCount: Math.max(0, count - exercises.length) }
}
