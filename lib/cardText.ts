/**
 * Utilities for the quoted-back convention.
 *
 * A card back (or front) wrapped in straight double quotes — e.g. "the better" —
 * is treated as a single literal phrase: comma/slash splitting is suppressed in
 * grading, synonym detection, and gloss-word splitting for multiple choice.
 *
 * The quotes are preserved in the DB and shown in the edit view so the user
 * can see and modify them. They are stripped everywhere the text is displayed
 * to the learner (session cards, deck list, etc.).
 */

export function isQuoted(s: string): boolean {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"')
}

/** Strip surrounding quotes for display; no-op if not quoted. */
export function displayText(s: string): string {
  return isQuoted(s) ? s.slice(1, -1) : s
}
