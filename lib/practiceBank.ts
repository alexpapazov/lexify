/**
 * lib/practiceBank.ts — assembling a practice session from the bank first, the API second.
 *
 * Generation is the only expensive part of practice, and the same words get drilled repeatedly, so
 * every generated sentence is filed in `practice_sentences` (migration 113) and reused later. A
 * second session over the same deck is usually free.
 *
 * The ordering matters: **read the bank, re-score what's in it, then generate only the shortfall.**
 * Re-scoring rather than trusting a stored verdict is what makes the cache safe — see
 * `engine/practiceBank.ts` for why.
 *
 * Writes are best-effort. Failing to file a new sentence, or to bump a use count, costs cache
 * quality on a later session; it must never take down the session in hand.
 */

import {
  pickBankExercises, plannedTotal, planGenerationBatches,
  type SentencePlan,
} from '@/engine/practiceBank'
import { scoreSentence, vocabularyCoverage, type LibraryIndex, type PracticeTarget } from '@/engine/practice'
import { generatePracticeExercises, type PreparedExercise } from '@/lib/practiceGenerate'
import { SupabasePracticeSentenceRepository, type StoredSentence } from '@/lib/data/practiceSentences'
import { GENERATE_CAP } from '@/app/api/practice/generate/route'
import { mapLimit } from '@/lib/mapLimit'
import type { ClozeMode } from '@/lib/practiceSchema'
import { verifySentences } from '@/lib/practiceVerify'

export interface PrepareOptions {
  userId:          string
  targets:         PracticeTarget[]
  index:           LibraryIndex
  sourceLanguage:  string
  targetLanguage:  string
  plan:            SentencePlan
  minGraduatedPct: number
  helperSeed?:     number
  /** Constrain sentences to known words. Off by default — the constraint is what hurts naturalness. */
  restrictVocabulary?: boolean
  /** Native-language sentence with only the blank in the target language. */
  mode?: ClozeMode
}

export interface PreparedSession {
  exercises: PreparedExercise[]
  /** How many came from the bank rather than the API — surfaced so "free" sessions are visible. */
  fromBank:  number
  /** Sentences the plan asked for that never materialised. */
  missingCount: number
  /** Generated sentences the quality gate threw out — they were never shown or banked. */
  rejectedCount: number
}

/** Rebuilds the display fields the player needs for a sentence that came from the bank. */
function prepareStored(
  stored:      StoredSentence,
  index:       LibraryIndex,
  targets:     PracticeTarget[],
  effectivePct: number,
): PreparedExercise {
  const exercise = stored.exercise
  const lemma    = stored.targetLemma.trim().toLowerCase()
  const score    = scoreSentence(exercise.tokens, index, [lemma], effectivePct)
  const answerToken = exercise.tokens.find(t => t.text === exercise.answer)
  const targetCard  = targets.find(t => t.lemma.trim().toLowerCase() === lemma)
  return {
    exercise,
    score,
    // The bank only hands back sentences that re-scored clean, so there is nothing left flagged.
    flagged: [],
    repaired: false,
    targetGloss: (answerToken?.gloss || targetCard?.back || '').trim(),
  }
}

/**
 * Builds a session: bank first, then generation for whatever's still missing.
 *
 * In per-word mode the shortfall is per WORD, so generation is asked only for the words that came
 * up short — a word whose bank already covers its quota costs nothing.
 */
export async function preparePracticeSession(opts: PrepareOptions): Promise<PreparedSession> {
  const { userId, targets, index, sourceLanguage, targetLanguage, plan, minGraduatedPct } = opts
  const wanted = plannedTotal(plan, targets.length)
  if (targets.length === 0 || wanted <= 0) {
    return { exercises: [], fromBank: 0, missingCount: 0, rejectedCount: 0 }
  }

  // Scoring uses the same relaxation the generator does, so a narrow library doesn't reject its own
  // cached sentences for a percentage it can never reach.
  const restrict = opts.restrictVocabulary === true
  const mode     = opts.mode ?? 'target'
  const narrow   = vocabularyCoverage(index).verdict === 'narrow'
  // No constraint (or a native-language sentence, whose other words aren't target-language at all)
  // means there is no bar for a sentence to clear.
  const effectivePct = restrict && mode === 'target' && !narrow ? minGraduatedPct : 0

  const repo = new SupabasePracticeSentenceRepository()
  let stored: StoredSentence[] = []
  try {
    stored = await repo.listForLemmas(userId, sourceLanguage, targetLanguage,
      targets.map(t => t.lemma))
  } catch {
    stored = []          // a bank read failure just means everything is generated fresh
  }

  const { reuse, shortfallByLemma } = pickBankExercises(
    stored.map(s => ({ id: s.id, targetLemma: s.targetLemma, tokens: s.exercise.tokens, useCount: s.useCount })),
    index, targets, effectivePct, plan, restrict && mode === 'target',
  )
  const reusedById = new Map(stored.map(s => [s.id, s]))
  const fromBank = reuse
    .map(r => reusedById.get(r.id))
    .filter((s): s is StoredSentence => s != null)
    .map(s => prepareStored(s, index, targets, effectivePct))

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
        targets: group, index, sourceLanguage, targetLanguage,
        count: missing * group.length, minGraduatedPct, helperSeed: opts.helperSeed,
        restrictVocabulary: restrict, mode,
      }))
    for (const run of runs) if (run) generated.push(...run.exercises)
  } else {
    const missing = Math.max(0, wanted - fromBank.length)
    if (missing > 0) {
      const run = await generatePracticeExercises({
        targets, index, sourceLanguage, targetLanguage,
        count: missing, minGraduatedPct, helperSeed: opts.helperSeed,
        restrictVocabulary: restrict, mode,
      })
      generated.push(...run.exercises)
    }
  }

  // ── Quality gate ──────────────────────────────────────────────────────────
  // Only freshly generated sentences are judged. Anything from the bank already passed when it was
  // written, so re-judging it would pay for the same verdict every session.
  let verifiedGenerated = generated
  let rejectedCount = 0
  if (generated.length > 0) {
    const outcome = await verifySentences(generated, g => g.exercise, sourceLanguage, targetLanguage)
    verifiedGenerated = outcome.kept
    rejectedCount = outcome.rejected.length
    if (outcome.rejected.length > 0) {
      // Not surfaced to the learner — they asked for sentences, not a QA report. Logged so a
      // language with a bad rejection rate is diagnosable.
      console.info('[practice] rejected %d generated sentence(s):',
        outcome.rejected.length, outcome.rejected.map(r => r.issue))
    }
  }

  // ── Persist and account, neither of which may break the session ────────────
  void (async () => {
    try {
      // Only file sentences with nothing flagged: a cached sentence carrying an unknown word would
      // be re-scored as unusable on every future read, so it would just be dead weight.
      const fileable = verifiedGenerated
        .filter(g => g.flagged.length === 0 && g.exercise.targetLemma)
        .map(g => ({ targetLemma: g.exercise.targetLemma, exercise: g.exercise }))
      await repo.saveMany(userId, sourceLanguage, targetLanguage, fileable)
    } catch { /* cache write only */ }
  })()
  void repo.markUsed(fromBank.map((_, i) => reuse[i]!.id)).catch(() => {})

  const exercises = [...fromBank, ...verifiedGenerated]
  return {
    exercises,
    fromBank: fromBank.length,
    rejectedCount,
    missingCount: Math.max(0, wanted - exercises.length),
  }
}

/** Re-exported so the page can size its controls against the same cap the planner uses. */
export { GENERATE_CAP, planGenerationBatches }
export type { SentencePlan }
