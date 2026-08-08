/**
 * lib/practiceRender.ts — turning a scored exercise into something renderable.
 *
 * Pure string work, kept out of the component so it can be tested: splitting a sentence around the
 * cloze blank, and marking the words that survived repair unknown so the UI can show them in red
 * with their translation.
 */

/** One run of sentence text; `flagged` runs are words the learner doesn't know. */
export interface RenderSegment {
  text:    string
  flagged: boolean
  /** Native gloss, present only on flagged runs. */
  gloss?:  string
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
 * Splits `text` into runs, marking the ones that are flagged words.
 *
 * Matching is per WORD (the split captures word runs, so punctuation and spacing survive untouched)
 * and case-insensitive, so a sentence-initial flagged word still matches its lowercase annotation.
 * A word that isn't flagged comes back as an ordinary run — adjacent runs are not merged, which
 * costs nothing since React renders a list of spans either way.
 */
export function segmentFlagged(text: string, flagged: { text: string; gloss: string }[]): RenderSegment[] {
  if (flagged.length === 0) return text ? [{ text, flagged: false }] : []

  const glossByWord = new Map(flagged.map(f => [f.text.toLowerCase(), f.gloss]))
  // Capturing split: odd indices are word runs, even indices the punctuation/space between them.
  const parts = text.split(/(\p{L}[\p{L}\p{M}'’-]*)/u).filter(p => p !== '')

  return parts.map(part => {
    const gloss = glossByWord.get(part.toLowerCase())
    return gloss === undefined
      ? { text: part, flagged: false }
      : { text: part, flagged: true, gloss }
  })
}
