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
 * detection) — plus one addition: the sentence's own inflected form is also accepted
 * (`viaClozeForm` in TypingMode), since sentences inflect words naturally and producing the
 * sentence's form is production too. `buildReviewCloze` anchors the blank on the full stored
 * front when the sentence carries it, else on the lemma-verified surface form, and REJECTS
 * anything else. A rejected or failed sentence just means the plain prompt — never a mis-graded
 * review.
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
 * The blank prefers the card's FULL stored front — leading article included ("el proceso"), so the
 * sentence never shows a stray article outside the blank ("El el proceso" was the original bug).
 * When the sentence inflected the word instead ("chapotean" for "chapotear", a plural noun, a
 * feminine adjective — natural sentences do this, and they should), the blank falls back to the
 * model's reported SURFACE form, guarded by the lemma: `targetLemma` must be the card's own word,
 * or a sentence about a different word entirely would slip through. Typed grading then accepts the
 * stored front AND the sentence's form (TypingMode's `viaClozeForm`), with the "Card says" note
 * showing the stored form when the inflection was typed. A sentence passing neither anchor is
 * rejected — the review falls back to the plain prompt. Pure — separated from the fetch for tests.
 */
export function buildReviewCloze(prepared: PreparedExercise, card: Card): ReviewCloze | null {
  const ex = prepared.exercise
  if (!ex.translation.trim()) return null

  const span = (at: number, len: number): ReviewCloze => ({
    before: ex.sentence.slice(0, at),
    after: ex.sentence.slice(at + len),
    answer: ex.sentence.slice(at, at + len),
    translation: ex.translation,
    gloss: (prepared.targetGloss || card.back).trim(),
  })
  const find = (needle: string): number => {
    const hay = searchable(ex.sentence)
    const key = searchable(needle)
    return hay && key ? hay.indexOf(key) : ex.sentence.indexOf(needle)
  }

  // 1. The full stored front, article and all.
  const front = stripGrammaticalTags(displayText(card.front)).trim()
  if (!front) return null
  const frontAt = find(front)
  if (frontAt >= 0) return span(frontAt, front.length)

  // 2. The sentence's inflected surface form — only when it is a form of THIS word.
  const lemmaKey = searchable((card.lemma ?? '').trim()) ?? ''
  const reportedLemma = searchable(ex.targetLemma.trim()) ?? ''
  if (!lemmaKey || reportedLemma !== lemmaKey) return null
  const surface = ex.answer.trim()
  if (!surface) return null
  const surfaceAt = find(surface)
  if (surfaceAt < 0) return null
  return span(surfaceAt, surface.length)
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
      quality: 'best',   // one sentence gates a real review — Sonnet, not the bulk Haiku tier
    })
    const prepared = run.exercises[0]
    return prepared ? buildReviewCloze(prepared, card) : null
  } catch {
    return null
  }
}
