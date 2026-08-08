/**
 * lib/practiceGenerate.ts — the generate → validate → repair → flag loop.
 *
 * This is where the two halves of Practice Mode meet: the AI routes propose sentences, and
 * `engine/practice.ts` (pure, tested) decides whether each one is acceptable against the learner's
 * actual library. Nothing here trusts the model's own claim about which words it used.
 *
 * Per exercise:
 *   1. score it — graduated share, plus any word the learner has never met;
 *   2. for each unknown word, ONE repair attempt with same-class known words to choose from;
 *   3. re-score the rewrite, and keep it only if it's actually an improvement;
 *   4. whatever is still unknown stays in the sentence, flagged with its translation.
 *
 * Step 4 is deliberate: a sentence with one red word plus its gloss is more useful than no sentence
 * at all, and it keeps a narrow library from producing an empty session.
 */

import { apiUrl } from '@/lib/apiBase'
import { mapLimit } from '@/lib/mapLimit'
import {
  scoreSentence, sampleHelperWords, repairCandidates, vocabularyCoverage,
  type LibraryIndex, type SentenceScore, type ScoredToken, type PracticeTarget,
} from '@/engine/practice'
import { planGenerationBatches } from '@/engine/practiceBank'
import { GENERATE_CAP } from '@/app/api/practice/generate/route'
import type { PracticeExercise, ClozeMode } from '@/lib/practiceSchema'

/** Known words shown to the generator. A sample: long lists cost tokens and worsen compliance. */
const HELPER_SAMPLE = 40

/** Same-class known words offered to the repair pass for one offending word. */
const REPAIR_CANDIDATES = 12

/** Repair calls in flight. Matches the other AI fan-outs in the app. */
const REPAIR_CONCURRENCY = 4

/** Generation calls in flight when one request needs several batches. */
const GENERATE_CONCURRENCY = 3

/** A generated exercise once it has been judged (and possibly repaired). */
export interface PreparedExercise {
  exercise: PracticeExercise
  score:    SentenceScore
  /** Words still unknown after repair — the UI shows these in red with their gloss. */
  flagged:  { text: string; gloss: string }[]
  /** True when a repair call actually improved this sentence. */
  repaired: boolean
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

/** Unknown words of a scored sentence, paired with the gloss the generator supplied. */
function flaggedWords(exercise: PracticeExercise, offenders: ScoredToken[]): { text: string; gloss: string }[] {
  return offenders.map(o => ({
    text:  o.text,
    gloss: exercise.tokens.find(t => t.text === o.text)?.gloss ?? '',
  }))
}

export interface GenerateOptions {
  targets:         PracticeTarget[]
  index:           LibraryIndex
  sourceLanguage:  string
  targetLanguage:  string
  count:           number
  minGraduatedPct: number
  /** Rotates which known words the generator is shown, so repeat runs vary. */
  helperSeed?:     number
  /**
   * Constrain sentences to the learner's known words. Off by default: the constraint is what makes
   * generated sentences unnatural, so it's opt-in and naturalness is the norm.
   */
  restrictVocabulary?: boolean
  /** Native-language sentence with only the blank in the target language. */
  mode?: ClozeMode
}

/**
 * Generates and validates a batch of cloze exercises.
 *
 * When the library is too narrow to build from (`vocabularyCoverage`), the generator is told it may
 * reach outside the library for simple common words, and the percentage bar is dropped for scoring —
 * unknown words are still flagged, but a sentence isn't rejected for a score it could never reach.
 */
export async function generatePracticeExercises(opts: GenerateOptions): Promise<PracticeRun> {
  const { targets, count } = opts
  if (targets.length === 0 || count <= 0) return { exercises: [], missingCount: 0 }

  // The route takes a bounded number of sentences per call, so a big ask (a per-word plan over many
  // words) becomes several calls. Batches run concurrently; a failed batch costs its own sentences,
  // not the session.
  const batches = planGenerationBatches(targets, { mode: 'total', count }, GENERATE_CAP)
  const errors: unknown[] = []
  const runs = await mapLimit(batches, GENERATE_CONCURRENCY, async batch => {
    try {
      return await generateOneBatch({ ...opts, targets: batch.targets, count: batch.count })
    } catch (err) {
      errors.push(err)      // captured here because mapLimit only reports a failure as `null`
      return null
    }
  })

  const exercises = runs.filter((r): r is PracticeRun => r !== null).flatMap(r => r.exercises)
  // One bad batch among several just costs its own sentences. But if nothing came back at all, the
  // caller needs the reason ("no-api-key") rather than a silent empty session.
  if (exercises.length === 0 && errors.length > 0) throw errors[0]
  return { exercises, missingCount: Math.max(0, count - exercises.length) }
}

/** One generation call plus its validation/repair pass. */
async function generateOneBatch(opts: GenerateOptions): Promise<PracticeRun> {
  const { targets, index, sourceLanguage, targetLanguage, count, minGraduatedPct } = opts
  if (targets.length === 0 || count <= 0) return { exercises: [], missingCount: 0 }

  const narrow = vocabularyCoverage(index).verdict === 'narrow'
  const helperWords = sampleHelperWords(index, HELPER_SAMPLE, opts.helperSeed ?? 0)
  // A library that can't supply the words has no percentage to meet; only unknown words matter.
  const effectivePct = narrow ? 0 : minGraduatedPct

  const res = await fetch(apiUrl('/api/practice/generate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      targets: targets.map(t => ({ front: t.front, back: t.back, lemma: t.lemma, pos: t.pos })),
      helperWords,
      sourceLanguage,
      targetLanguage,
      count,
      narrowVocabulary: narrow,
      restrictVocabulary: opts.restrictVocabulary === true,
      mode: opts.mode ?? 'target',
    }),
  })
  const data = await res.json()
  if (!data?.ok || !Array.isArray(data.exercises)) {
    throw new Error(data?.reason ?? 'generate-failed')
  }
  const generated = data.exercises as PracticeExercise[]

  const targetLemmas = targets.map(t => t.lemma.trim().toLowerCase())
  const restrict = opts.restrictVocabulary === true

  const prepared = await mapLimit(generated, REPAIR_CONCURRENCY, async exercise => {
    // Only the sentence's OWN target is exempt from scoring. Exempting every word the learner
    // picked for the session would wrongly excuse the other targets when they appear as ordinary
    // vocabulary in someone else's sentence.
    const own = targetLemmas.includes(exercise.targetLemma) ? [exercise.targetLemma] : targetLemmas

    let current  = exercise
    // With no vocabulary constraint there is nothing to judge: an unknown word is simply a word,
    // and flagging or repairing it would be enforcing a rule the learner switched off. Scored at 0
    // so the shape stays the same, and the repair loop below is skipped entirely.
    let score    = scoreSentence(current.tokens, index, own, restrict ? effectivePct : 0)
    let repaired = false

    // One repair attempt per offending word, always working from the CURRENT sentence — a
    // successful rewrite changes the offender list, so re-reading it each pass avoids chasing a
    // word that's already gone. `attempts` bounds the loop even if repairs keep failing.
    const attemptBudget = restrict ? score.offenders.length : 0
    for (let attempt = 0; attempt < attemptBudget && score.offenders.length > 0; attempt++) {
      const offender  = score.offenders[0]!
      const rewritten = await repairOnce({
        exercise: current,
        offender,
        candidates: repairCandidates(index, offender.pos, REPAIR_CANDIDATES),
        sourceLanguage,
        targetLanguage,
      })
      if (!rewritten) break        // repair unavailable — stop paying for calls that aren't landing
      const nextScore = scoreSentence(rewritten.tokens, index, own, effectivePct)
      // Guard against a "repair" that just trades one unknown word for another.
      if (nextScore.offenders.length >= score.offenders.length) break
      current  = rewritten
      score    = nextScore
      repaired = true
    }

    // The blank's prompt: what the learner is being asked to produce.
    const answerToken = current.tokens.find(t => t.text === current.answer)
    const targetCard  = targets.find(t => t.lemma.trim().toLowerCase() === current.targetLemma)
    const result: PreparedExercise = {
      exercise: current,
      score,
      flagged: restrict ? flaggedWords(current, score.offenders) : [],
      repaired,
      targetGloss: (answerToken?.gloss || targetCard?.back || '').trim(),
    }
    return result
  })

  const exercises = prepared.filter((p): p is PreparedExercise => p !== null)
  return { exercises, missingCount: Math.max(0, count - exercises.length) }
}

/** One repair call. Returns null on any failure — the caller keeps the original sentence. */
async function repairOnce(args: {
  exercise:       PracticeExercise
  offender:       ScoredToken
  candidates:     string[]
  sourceLanguage: string
  targetLanguage: string
}): Promise<PracticeExercise | null> {
  const { exercise, offender, candidates, sourceLanguage, targetLanguage } = args
  try {
    const res = await fetch(apiUrl('/api/practice/repair'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sentence:      exercise.sentence,
        offendingWord: offender.text,
        offendingPos:  offender.pos,
        candidates,
        targetLemma:   exercise.targetLemma,
        targetSurface: exercise.answer,
        sourceLanguage,
        targetLanguage,
      }),
    })
    const data = await res.json()
    if (!data?.ok || !data.exercise) return null
    return data.exercise as PracticeExercise
  } catch {
    return null
  }
}
