/**
 * lib/cardSearch.ts — the one card-search predicate, used by every "Search cards…" box and card
 * picker (library root/pair views, folder page, CardEditModal's pickers).
 *
 * Matching is by WORD PREFIX, not substring: every whitespace-separated token of the query must
 * start some word of the card's front or back. Searching "se" finds "se précipiter" and "sentir"
 * but no longer "louse", "écraser" or "severe" — mid-word hits made short queries useless, which
 * is what prompted this helper. Matching is case- and accent-insensitive ("ecraser" finds
 * "écraser"), and words are split on any non-letter/digit, so "extase" finds "l'extase (f)".
 */

/** Lowercase + diacritics stripped (NFD, then the combining-mark block) — the same text form for
 *  both query and card sides. */
function normalizeForSearch(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** The searchable words of a text: split on anything that isn't a letter or digit
 *  (apostrophes, parentheses, slashes, hyphens all delimit). */
function searchWords(text: string): string[] {
  return normalizeForSearch(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/**
 * True when every token of `query` prefixes some word of `front` or `back`.
 * An empty/whitespace query matches nothing — callers gate the empty state themselves.
 */
export function cardMatchesSearch(query: string, front: string, back: string): boolean {
  const tokens = searchWords(query)
  if (tokens.length === 0) return false
  const words = [...searchWords(front), ...searchWords(back)]
  return tokens.every(t => words.some(w => w.startsWith(t)))
}
