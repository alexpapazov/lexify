/**
 * lib/reviewCloze.ts — cloze prompts for Due Now FORWARD reviews (migration 124 setting).
 *
 * With `profiles.forward_cloze` on, a forward review (native gloss → produce the target word)
 * shows a generated target-language sentence with the word blanked out — the gloss sits inside
 * the blank, the sentence's translation underneath — instead of the bare gloss. Typed reviews
 * type into the same input as always; self-graded reviews reveal and rate as always.
 *
 * The load-bearing rule: **grading is completely untouched.** The expected answer stays the
 * card's stored front, with all its machinery (strictness, overrides, synonyms, confusion
 * detection). That only stays honest if the sentence uses the word EXACTLY as stored — so
 * generation is asked for the dictionary form (`exactForm`), and `buildReviewCloze` REJECTS any
 * sentence whose surface form differs from the card's front/lemma (the model inflected anyway).
 * A rejected or failed sentence just means the plain prompt — never a mis-graded review.
 *
 * One sentence per card per session (the session page caches results), fetched a few cards ahead
 * so the sentence is usually ready by the time the card surfaces. Online only; unlabeled cards
 * (no pos/lemma) can't generate and fall back to the plain prompt.
 */

import type { Card } from '@/domain'
import type { PracticeTarget } from '@/engine/practice'
import { generatePracticeExercises, type PreparedExercise } from '@/lib/practiceGenerate'
import { splitForBlank } from '@/lib/practiceRender'
import { normalizeFrontKey } from '@/lib/duplicates'

export interface ReviewCloze {
  /** Sentence text before / after the blank. */
  before: string
  after: string
  /** The surface form the sentence uses (verified equal to the card's word). */
  answer: string
  /** Native translation of the whole sentence. */
  translation: string
  /** Native meaning of the blanked word — shown inside the blank, it IS the prompt. */
  gloss: string
}

/** Whether a card can have a cloze prompt at all: it needs labels to generate from. */
export function clozeEligible(card: Card): boolean {
  return !!card.pos && !!card.lemma && card.pos !== 'phrase'
}

/**
 * Turns one generated exercise into a review cloze, or null when it can't be trusted:
 * the surface form must match the card's stored front (or its lemma) after front-key
 * normalization (case, articles, grammatical tags), and the answer must be locatable in the
 * sentence. Pure — separated from the fetch for tests.
 */
export function buildReviewCloze(prepared: PreparedExercise, card: Card): ReviewCloze | null {
  const ex = prepared.exercise
  const surface = normalizeFrontKey(ex.answer, card.sourceLanguage)
  const front   = normalizeFrontKey(card.front, card.sourceLanguage)
  const lemma   = card.lemma ? normalizeFrontKey(card.lemma, card.sourceLanguage) : null
  if (surface !== front && surface !== lemma) return null
  const split = splitForBlank(ex.sentence, ex.answer)
  if (!split) return null
  if (!ex.translation.trim()) return null
  return {
    before: split.before, after: split.after, answer: ex.answer,
    translation: ex.translation,
    gloss: (prepared.targetGloss || card.back).trim(),
  }
}

/** Generates one sentence for the card and validates it. Null on any failure — caller falls back. */
export async function fetchReviewCloze(card: Card): Promise<ReviewCloze | null> {
  if (!clozeEligible(card)) return null
  const target: PracticeTarget = {
    cardId: card.id, front: card.front, back: card.back,
    lemma: card.lemma!, pos: card.pos!,
  }
  try {
    const run = await generatePracticeExercises({
      targets: [target],
      sourceLanguage: card.sourceLanguage,
      targetLanguage: card.targetLanguage,
      count: 1,
      mode: 'target',
      exactForm: true,
    })
    const prepared = run.exercises[0]
    return prepared ? buildReviewCloze(prepared, card) : null
  } catch {
    return null
  }
}
