/**
 * lib/reviewCloze.ts — cloze prompts for Due Now FORWARD reviews (`?cloze=1`, chosen from the
 * dashboard due picker's Cloze / Normal buttons).
 *
 * In cloze mode a forward review (native gloss → produce the target word) shows a generated
 * target-language sentence with the word blanked out — the gloss sits inside the blank, the
 * sentence's translation underneath — instead of the bare gloss. Typed reviews type into the same
 * input as always; self-graded reviews reveal and rate as always.
 *
 * The load-bearing rule: **grading is completely untouched.** The expected answer stays the
 * card's stored front, with all its machinery (strictness, overrides, synonyms, confusion
 * detection). That only stays honest if the sentence carries the front EXACTLY as stored —
 * leading article included ("el proceso", not a bare "proceso" behind the sentence's own "El") —
 * so generation is asked for that exact form (`exactForm` lists the front verbatim), and
 * `buildReviewCloze` blanks the full-front span or REJECTS the sentence. A rejected or failed
 * sentence just means the plain prompt — never a mis-graded review.
 *
 * One sentence per card per session (the session page caches results), fetched a few cards ahead
 * so the sentence is usually ready by the time the card surfaces. Online only; unlabeled cards
 * (no pos/lemma) can't generate and fall back to the plain prompt.
 */

import type { Card, TypedStrictness } from '@/domain'
import type { PracticeTarget } from '@/engine/practice'
import { generatePracticeExercises, type PreparedExercise } from '@/lib/practiceGenerate'
import { stripGrammaticalTags } from '@/engine/grading'
import { displayText } from '@/lib/cardText'

export interface ReviewCloze {
  /** Sentence text before / after the blank. */
  before: string
  after: string
  /** The blanked span exactly as the sentence carries it — the full stored front, sentence casing. */
  answer: string
  /** Native translation of the whole sentence. */
  translation: string
  /** Native meaning of the blanked word — shown inside the blank, it IS the prompt. */
  gloss: string
}

/**
 * Strictness for a typed CLOZE review: articles are auto-accepted (user decision 2026-09-07).
 * The blank spans the full stored front ("el proceso"), so the article is already on screen as
 * part of the sentence's shape — demanding it typed again is redundant, and dropping it must not
 * cost a penalty or a retype. Spelling and accent strictness keep the pair's own settings.
 */
export function clozeStrictness(s: TypedStrictness): TypedStrictness {
  return { ...s, articles: 'accept' }
}

/** Whether a card can have a cloze prompt at all: it needs labels to generate from. */
export function clozeEligible(card: Card): boolean {
  return !!card.pos && !!card.lemma && card.pos !== 'phrase'
}

/** Lowercased, apostrophe-unified copy for searching — same length as the input, or null when a
 *  locale-specific case mapping changes the length (indices couldn't be trusted then). */
function searchable(s: string): string | null {
  const lowered = s.replace(/[’ʼ]/g, "'").toLowerCase()
  return lowered.length === s.length ? lowered : null
}

/**
 * Turns one generated exercise into a review cloze, or null when it can't be trusted.
 *
 * The blank must cover the card's FULL stored front — leading article included — because that is
 * exactly what typed grading expects the learner to produce. Anchoring on the model's reported
 * surface form was the bug this replaced: for "el proceso" the model reports "proceso", the blank
 * left the sentence's own "El" visible (so typing the article was double, and omitting it was an
 * article error), and the filled reveal read "El el proceso". So: find the full front in the
 * sentence (case- and apostrophe-insensitive) and blank that span; a sentence that doesn't carry
 * the front verbatim — inflected, article dropped, wrong word — is rejected and the review falls
 * back to the plain prompt. Pure — separated from the fetch for tests.
 */
export function buildReviewCloze(prepared: PreparedExercise, card: Card): ReviewCloze | null {
  const ex = prepared.exercise
  if (!ex.translation.trim()) return null
  const needle = stripGrammaticalTags(displayText(card.front)).trim()
  if (!needle) return null
  const hay = searchable(ex.sentence)
  const key = searchable(needle)
  const at = hay && key ? hay.indexOf(key) : ex.sentence.indexOf(needle)
  if (at < 0) return null
  const answer = ex.sentence.slice(at, at + needle.length)
  return {
    before: ex.sentence.slice(0, at),
    after: ex.sentence.slice(at + needle.length),
    answer,
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
