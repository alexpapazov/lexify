/**
 * lib/reviewCloze.ts — cloze prompts for Due Now FORWARD reviews (`?cloze=1`, chosen from the
 * dashboard due picker's Cloze / Normal buttons).
 *
 * In cloze mode a forward review (native gloss → produce the target word) shows a generated
 * target-language sentence with the word blanked out — the gloss sits inside the blank, the
 * sentence's translation underneath — instead of the bare gloss. Typed reviews type into the same
 * input as always; self-graded reviews reveal and rate as always.
 *
 * Grading: the expected answer stays the card's stored front with all its machinery (strictness,
 * overrides, synonyms, confusion detection), plus the sentence's own form is accepted
 * (`viaClozeForm` in TypingMode).
 *
 * Validation is deliberately BARE BONES (user decision 2026-09-07, after two rounds of content
 * guards — lemma equality, stem-family checks — each rejected legitimate sentences and read as
 * "cloze never generates"): the blank anchors on the card's article-stripped word when the
 * sentence carries it, else on the model's reported answer, and the ONLY rejection is failing to
 * locate either in the sentence. Known accepted risk: a model synonym swap now renders (and its form is accepted by
 * grading) instead of being filtered. Do not re-add content guards without the user asking.
 *
 * One sentence per card per session (the session page caches results), fetched a few cards ahead
 * so the sentence is usually ready by the time the card surfaces. Online only; unlabeled cards
 * (no pos/lemma) can't generate and fall back to the plain prompt.
 */

import type { Card, CardChoices, StoredClozeSentence, TypedStrictness } from '@/domain'
import type { PracticeTarget } from '@/engine/practice'
import { generatePracticeExercises, type PreparedExercise } from '@/lib/practiceGenerate'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { stripGrammaticalTags, stripLeadingArticle } from '@/engine/grading'
import { displayText } from '@/lib/cardText'

/** How many generated sentences a card keeps (`choices.clozeSentences`, newest first). Sessions
 *  generate fresh sentences until this many exist, then rotate among them — variety builds over a
 *  card's first cloze reviews, after which its cloze prompt is instant and free. */
export const MAX_STORED_CLOZES = 3

export interface ReviewCloze {
  /** Sentence text before / after the blank. */
  before: string
  after: string
  /** The blanked span exactly as the sentence carries it — the bare word, sentence casing. */
  answer: string
  /** Native translation of the whole sentence. */
  translation: string
  /** Native meaning of the blanked word — shown inside the blank, it IS the prompt. */
  gloss: string
  /** Per-word glosses — every sentence word is tappable for its meaning, like the practice player. */
  tokens: { text: string; gloss: string }[]
}

/**
 * Strictness for a typed CLOZE review: articles are auto-accepted (user decision 2026-09-07).
 * The sentence's own article sits VISIBLY before the blank ("El ___ de solicitud…"), so the
 * learner types just the word — and typing it WITH the article must cost nothing either.
 * Spelling and accent strictness keep the pair's own settings.
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
 * Turns one generated exercise into a review cloze. The blank covers ONLY the word itself — the
 * sentence's own definite article stays VISIBLE outside the blank ("El ___ de solicitud…"), and
 * the learner types just the word (user decision 2026-09-07, replacing the earlier
 * article-in-the-blank design; typed grading accepts the answer with or without the article
 * either way, via `clozeStrictness`). Anchor preference: the card's article-stripped front, else
 * the model's reported answer (inflections and all). Null ONLY when neither can be located in the
 * sentence: without a span there is nothing to blank. Pure — separated from the fetch for tests.
 */
export function buildReviewCloze(prepared: PreparedExercise, card: Card): ReviewCloze | null {
  const ex = prepared.exercise

  const span = (at: number, len: number): ReviewCloze => ({
    before: ex.sentence.slice(0, at),
    after: ex.sentence.slice(at + len),
    answer: ex.sentence.slice(at, at + len),
    translation: ex.translation,
    gloss: (prepared.targetGloss || card.back).trim(),
    tokens: ex.tokens.map(t => ({ text: t.text, gloss: t.gloss })),
  })
  const find = (needle: string): number => {
    const hay = searchable(ex.sentence)
    const key = searchable(needle)
    return hay && key ? hay.indexOf(key) : ex.sentence.indexOf(needle)
  }

  // 1. The card's word WITHOUT its leading article — the sentence's article stays visible.
  const front = stripGrammaticalTags(displayText(card.front)).trim()
  if (!front) return null
  const bare = stripLeadingArticle(front, card.sourceLanguage).trim() || front
  const bareAt = find(bare)
  if (bareAt >= 0) return span(bareAt, bare.length)

  // 2. The model's reported answer — the word as the sentence actually uses it.
  const surface = ex.answer.trim()
  if (!surface) return null
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
      targetLemma: card.lemma ?? '', translation: stored.translation,
      tokens: (stored.tokens ?? []).map(t => ({ text: t.text, lemma: '', pos: 'other', isFunctionWord: false, gloss: t.gloss })),
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
        tokens: cloze.tokens,
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
