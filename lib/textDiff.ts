/**
 * lib/textDiff.ts — word-level diff between two versions of a journal entry, for the revision
 * history view. Pure, framework-free.
 *
 * Classic LCS over word tokens: whatever isn't part of the longest common subsequence is an
 * addition (only in the new text) or a removal (only in the old). Adjacent same-type words merge
 * into one segment, so the renderer paints runs, not letters. Whitespace is normalized to single
 * spaces in the OUTPUT — the history view shows what changed, the entry itself keeps its real
 * formatting. Returns null when the texts are too large for the O(n·m) table; callers fall back
 * to showing the versions side by side.
 */

export interface DiffSegment {
  type: 'same' | 'added' | 'removed'
  text: string
}

/** n·m cap for the LCS table — far above any real journal entry (≈2000×2000 words). */
const MAX_CELLS = 4_000_000

const tokenize = (s: string): string[] => (s.trim() ? s.trim().split(/\s+/) : [])

export function diffWords(oldText: string, newText: string): DiffSegment[] | null {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  if (a.length * b.length > MAX_CELLS) return null
  if (a.length === 0 && b.length === 0) return []

  // LCS lengths table (a.length+1 × b.length+1).
  const n = a.length, m = b.length
  const table: Uint32Array = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => table[i * (m + 1) + j]!
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = a[i] === b[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }

  // Walk the table, emitting words; removals before additions at each divergence (reads better).
  const raw: DiffSegment[] = []
  let i = 0, j = 0
  const push = (type: DiffSegment['type'], text: string) => {
    const last = raw[raw.length - 1]
    if (last && last.type === type) last.text += ` ${text}`
    else raw.push({ type, text })
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]!); i++; j++ }
    else if (at(i + 1, j) >= at(i, j + 1)) { push('removed', a[i]!); i++ }
    else { push('added', b[j]!); j++ }
  }
  while (i < n) { push('removed', a[i]!); i++ }
  while (j < m) { push('added', b[j]!); j++ }
  return raw
}

/** Word counts of a diff: how many words an edit added and removed (a changed word counts as both). */
export function diffStats(segments: DiffSegment[]): { added: number; removed: number } {
  let added = 0, removed = 0
  for (const s of segments) {
    const words = s.text.split(/\s+/).length
    if (s.type === 'added') added += words
    if (s.type === 'removed') removed += words
  }
  return { added, removed }
}
