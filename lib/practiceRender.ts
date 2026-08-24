/**
 * lib/practiceRender.ts — turning a generated exercise into something renderable.
 *
 * Pure string work, kept out of the component so it can be tested: splitting a sentence around the
 * cloze blank, and splitting text into word/punctuation runs so every word can be a clickable span.
 */

/** One run of sentence text. `isWord` runs are tappable; the rest is punctuation and spacing. */
import { gradeTyping } from '@/engine/grading'
import type { GradingSettings } from '@/domain'

export interface RenderRun {
  text:   string
  isWord: boolean
}

/**
 * Splits a sentence around the first occurrence of `answer`, for rendering the blank.
 * Returns null when the answer isn't present — the parser rejects those, so this is belt and braces.
 */
export function splitForBlank(sentence: string, answer: string): { before: string; after: string } | null {
  const at = sentence.indexOf(answer)
  if (at < 0) return null
  return { before: sentence.slice(0, at), after: sentence.slice(at + answer.length) }
}

/**
 * Splits `text` into word and non-word runs, preserving every character.
 *
 * The word pattern matches letter runs including combining marks, apostrophes and hyphens, so
 * French elisions ("l'école") and hyphenated words come out as single tappable words while
 * punctuation and spacing pass through untouched.
 */
export function segmentWords(text: string): RenderRun[] {
  if (!text) return []
  // Capturing split: odd indices are word runs, even indices the punctuation/space between them.
  return text
    .split(/(\p{L}[\p{L}\p{M}'’-]*)/u)
    .filter(p => p !== '')
    .map(part => ({ text: part, isWord: /^\p{L}/u.test(part) }))
}

/**
 * Grades a cloze answer in two tiers.
 *
 *   'correct' — the sentence's inflected form (what the blank actually needs).
 *   'form'    — the target WORD, but as its citation form rather than this sentence's inflection.
 *               Practice drills vocabulary; a learner who produces the lemma knows the word, and
 *               failing them for the conjugation teaches them nothing the reveal can't. Counted as
 *               correct, with the inflected form shown as a note.
 *   'wrong'   — neither.
 *
 * Both tiers grade through `gradeTyping` with the caller's (flexible) settings, so the same typo
 * and accent tolerance applies to the lemma as to the answer — typing "σημβαίνω" for the lemma
 * "συμβαίνω" is a slip, not a different word.
 */
export function gradeClozeInput(
  input: string,
  answer: string,
  targetLemma: string,
  settings: GradingSettings,
): 'correct' | 'form' | 'wrong' {
  // 'almost' (typo / accent / article slips) counts as a match in BOTH tiers. Practice grading is
  // deliberately forgiving — the player's own header says failing someone on a slip in a generated
  // sentence is noise — and gradeTyping only sets `correct` for a byte-exact-after-normalizing hit.
  const matches = (expected: string) => {
    const r = gradeTyping(input, expected, settings)
    return r.correct || r.status === 'almost'
  }
  if (matches(answer)) return 'correct'
  const lemma = targetLemma.trim()
  if (lemma && matches(lemma)) return 'form'
  return 'wrong'
}
