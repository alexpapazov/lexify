/**
 * lib/practiceSchema.ts — the wire shape of a generated practice exercise, plus the defensive
 * parser both practice routes and the client use.
 *
 * Two things travel together and are deliberately NOT the same thing:
 *
 *   `sentence` is the display truth — a natural sentence string, punctuation and all. Everything
 *   the learner reads is rendered from it.
 *
 *   `tokens` is the ANALYSIS — one entry per vocabulary word (no punctuation), each carrying the
 *   lemma the scorer needs. Keeping these separate avoids the join-the-tokens-back-together problem
 *   entirely: no guessing where spaces go around commas or French elisions.
 *
 * Parsing drops malformed entries rather than throwing. A batch where the model fumbled one
 * sentence should still yield the other nine.
 */

import type { PartOfSpeech } from '@/domain'
import type { AnnotatedToken } from '@/engine/practice'

/** An annotated word, plus a native gloss so a word that survives repair can be shown translated. */
export interface PracticeToken extends AnnotatedToken {
  gloss: string
}

export interface PracticeExercise {
  /** Lemma of the target word this exercise drills (matches one of the requested targets). */
  targetLemma: string
  /** The full sentence, as displayed. */
  sentence:    string
  /** Exact surface form of the target word inside `sentence` — what gets blanked, and the answer. */
  answer:      string
  /** Native-language translation of the whole sentence. */
  translation: string
  /** One entry per vocabulary word of the sentence. */
  tokens:      PracticeToken[]
}

const POS_VALUES: PartOfSpeech[] = [
  'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition',
  'conjunction', 'determiner', 'interjection', 'numeral', 'phrase', 'other',
]

function str(val: unknown): string {
  return typeof val === 'string' ? val.trim() : ''
}

function parseToken(raw: unknown): PracticeToken | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const text = str(r.text)
  if (!text) return null
  // An unlabeled or bogus POS becomes 'other' rather than dropping the token — the scorer treats it
  // as a content word, which is the conservative reading (it can be flagged, never silently free).
  const pos = POS_VALUES.includes(r.pos as PartOfSpeech) ? (r.pos as PartOfSpeech) : 'other'
  return {
    text,
    // Missing lemma falls back to the surface form: better an exact-match miss than a crash.
    lemma: str(r.lemma) || text,
    pos,
    isFunctionWord: r.isFunctionWord === true,
    gloss: str(r.gloss),
  }
}

/**
 * Parses one exercise from model output. Returns null when the entry can't be trusted:
 * no sentence, no tokens, or — the important one — an `answer` that doesn't actually occur in the
 * sentence, which would make the cloze blank unrenderable.
 */
export function parseExercise(raw: unknown): PracticeExercise | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const sentence = str(r.sentence)
  const answer   = str(r.answer)
  if (!sentence || !answer) return null
  if (!sentence.includes(answer)) return null

  const tokens = Array.isArray(r.tokens)
    ? r.tokens.map(parseToken).filter((t): t is PracticeToken => t !== null)
    : []
  if (tokens.length === 0) return null

  return {
    targetLemma: str(r.targetLemma).toLowerCase(),
    sentence,
    answer,
    translation: str(r.translation),
    tokens,
  }
}

/** Parses a `{ exercises: [...] }` payload, keeping only the well-formed entries. */
export function parseExercises(raw: unknown): PracticeExercise[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as { exercises?: unknown }).exercises
  if (!Array.isArray(list)) return []
  return list.map(parseExercise).filter((e): e is PracticeExercise => e !== null)
}
