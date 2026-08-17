/**
 * lib/practiceRender.ts — turning a generated exercise into something renderable.
 *
 * Pure string work, kept out of the component so it can be tested: splitting a sentence around the
 * cloze blank, and splitting text into word/punctuation runs so every word can be a clickable span.
 */

/** One run of sentence text. `isWord` runs are tappable; the rest is punctuation and spacing. */
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
