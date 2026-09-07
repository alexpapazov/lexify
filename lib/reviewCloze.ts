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

import type { Card, CardChoices, StoredClozeSentence, TypedStrictness } from '@/domain'
import type { PracticeTarget } from '@/engine/practice'
import { generatePracticeExercises, type PreparedExercise } from '@/lib/practiceGenerate'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { stripGrammaticalTags } from '@/engine/grading'
import { displayText } from '@/lib/cardText'

/** How many generated sentences a card keeps (`choices.clozeSentences`, newest first). Sessions
 *  generate fresh sentences until this many exist, then rotate among them — variety builds over a
 *  card's first cloze reviews, after which its cloze prompt is instant and free. */
export const MAX_STORED_CLOZES = 3

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
 * Deterministic "is this a form of THAT word" check: inflection changes endings, so a real form
 * shares a long prefix with its lemma ("chapotean"/"chapotear", "perros"/"perro", "corrió"/
 * "correr"), while a synonym shares almost none ("създавам"/"сътворявам": 2 of 8). The ratio is
 * measured against the SHORTER string so agglutinative endings (먹어요/먹다) don't dilute it.
 * Suppletive forms (fue/ser) fail and fall back to the plain prompt — a false rejection is safe,
 * a false acceptance is the "completely different word in the blank" bug this guards against.
 */
export function sameWordFamily(surface: string, lemma: string): boolean {
  const a = searchable(surface) ?? surface.toLowerCase()
  const b = searchable(lemma) ?? lemma.toLowerCase()
  if (!a || !b) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i / Math.min(a.length, b.length) >= 0.5
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
  // The reported lemma is checked by FAMILY, not equality: for a reflexive or multiword lemma
  // ("посвещавам се", "se précipiter") the model reports the bare verb, and strict equality
  // rejected every sentence for such cards. Family still rejects an honest different-word report.
  const lemmaKey = (card.lemma ?? '').trim()
  if (!lemmaKey || !sameWordFamily(ex.targetLemma.trim(), lemmaKey)) return null
  const surface = ex.answer.trim()
  if (!surface) return null
  // The reported lemma is COPIED from the request, so it can't prove anything on its own — the
  // model once wrote the synonym "създавам" while dutifully labeling it "сътворявам". The surface
  // form itself must look like an inflection of the card's word.
  if (!sameWordFamily(surface, card.lemma!)) return null
  const surfaceAt = find(surface)
  if (surfaceAt < 0) return null
  return span(surfaceAt, surface.length)
}

/**
 * Re-validates a STORED sentence against the card as it is NOW — the card's front or lemma may
 * have been edited since the sentence was saved, and a stale sentence must fall away rather than
 * mis-anchor. Runs the exact `buildReviewCloze` gauntlet by reconstructing its input.
 */
export function storedToReviewCloze(stored: StoredClozeSentence, card: Card): ReviewCloze | null {
  const prepared = {
    exercise: {
      sentence: stored.sentence, answer: stored.answer,
      targetLemma: card.lemma ?? '', translation: stored.translation, tokens: [],
    },
    targetCardId: card.id,
    targetGloss: stored.gloss,
  } as PreparedExercise
  return buildReviewCloze(prepared, card)
}

/** Adds one sentence to a card's stored set: newest first, de-duplicated, capped. */
export function appendStoredCloze(choices: CardChoices | null, stored: StoredClozeSentence): CardChoices {
  const base: CardChoices = choices ?? { front: [], back: [] }
  const rest = (base.clozeSentences ?? []).filter(s => s.sentence !== stored.sentence)
  return { ...base, clozeSentences: [stored, ...rest].slice(0, MAX_STORED_CLOZES) }
}

/**
 * Generates one sentence, validates it, and PERSISTS it into the card's stored set (best-effort).
 * Returns the cloze plus the updated choices so callers can sync their local copy of the card.
 * Null on any failure — callers fall back to the plain prompt / an error note.
 */
export async function generateReviewCloze(card: Card): Promise<{ cloze: ReviewCloze; choices: CardChoices } | null> {
  if (!clozeEligible(card)) return null
  const target: PracticeTarget = {
    cardId: card.id, front: card.front, back: card.back,
    lemma: card.lemma!, pos: card.pos!,
  }
  // Two attempts: a rejected sentence (synonym swap, missing word) gets ONE regeneration before
  // the review falls back to the plain prompt. Rejections log to the console on purpose — "why is
  // this card not cloze" must be answerable from the browser, not by reading this file.
  for (let attempt = 0; attempt < 2; attempt++) {
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
      if (!prepared) {
        console.info(`[cloze] ${card.front}: generation returned nothing (attempt ${attempt + 1})`)
        continue
      }
      const cloze = buildReviewCloze(prepared, card)
      if (!cloze) {
        console.info(`[cloze] ${card.front}: sentence rejected (attempt ${attempt + 1}): "${prepared.exercise.sentence}" (answer "${prepared.exercise.answer}", lemma "${prepared.exercise.targetLemma}")`)
        continue
      }
      const choices = appendStoredCloze(card.choices, {
        sentence: prepared.exercise.sentence, answer: cloze.answer,
        translation: cloze.translation, gloss: cloze.gloss,
      })
      try { await new SupabaseCardRepository().update(card.id, { choices }) } catch { /* best-effort */ }
      return { cloze, choices }
    } catch (err) {
      console.info(`[cloze] ${card.front}: generation failed (attempt ${attempt + 1})`, err)
    }
  }
  return null
}

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!

/**
 * The session entry point: a stored sentence when the card's set is full (or generation isn't
 * allowed — offline), else a freshly generated one (persisted into the set), else whatever stored
 * remains valid, else null → the plain prompt.
 */
export async function resolveReviewCloze(card: Card, opts: { allowGenerate: boolean }): Promise<ReviewCloze | null> {
  if (!clozeEligible(card)) return null
  const valid = (card.choices?.clozeSentences ?? [])
    .map(s => storedToReviewCloze(s, card))
    .filter((c): c is ReviewCloze => c !== null)
  if (valid.length >= MAX_STORED_CLOZES || (!opts.allowGenerate && valid.length > 0)) return pick(valid)
  if (!opts.allowGenerate) return null
  const gen = await generateReviewCloze(card)
  if (gen) return gen.cloze
  return valid.length > 0 ? pick(valid) : null
}
