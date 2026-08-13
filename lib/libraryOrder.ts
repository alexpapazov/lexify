/**
 * lib/libraryOrder.ts — folders and decks as ONE ordered list.
 *
 * The library views used to render "all folders, then all decks", which made "put this deck above
 * that folder" impossible — the drop either did nothing or (worse) fell into the folder. Rows are
 * now interleaved by `position` across both types, and a reorder writes a shared 0..n index back to
 * both tables. The two position sequences don't need to stay dense per type — each table only needs
 * its own relative order preserved, and a shared index does that while also fixing the interleave.
 *
 * Tie-break on equal positions is FOLDER FIRST: a library whose two sequences still overlap (never
 * cross-reordered) keeps looking exactly like the old folders-then-decks rendering.
 */

import type { Deck, Folder } from '@/domain'

export type LibraryRow =
  | { kind: 'folder'; id: string; position: number; folder: Folder }
  | { kind: 'deck';   id: string; position: number; deck: Deck }

export function interleaveLibrary(folders: Folder[], decks: Deck[]): LibraryRow[] {
  const rows: LibraryRow[] = [
    ...folders.map(f => ({ kind: 'folder' as const, id: f.id, position: f.position ?? 0, folder: f })),
    ...decks.map(d => ({ kind: 'deck' as const, id: d.id, position: d.position ?? 0, deck: d })),
  ]
  // Stable sort: position, then folders before decks, then original order within a type.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) =>
      (a.r.position - b.r.position) ||
      ((a.r.kind === 'folder' ? 0 : 1) - (b.r.kind === 'folder' ? 0 : 1)) ||
      (a.i - b.i))
    .map(x => x.r)
}

export interface MixedReorder {
  folders: { id: string; position: number }[]
  decks:   { id: string; position: number }[]
}

/**
 * Moves one row before/after another (either type on either side) and returns the position writes
 * for BOTH tables. Null when the move is invalid or a no-op — nothing should be written then.
 */
export function planMixedReorder(
  rows: LibraryRow[],
  dragging: { type: 'folder' | 'deck'; id: string },
  targetId: string,
  pos: 'before' | 'after',
): MixedReorder | null {
  const fromIdx = rows.findIndex(r => r.kind === dragging.type && r.id === dragging.id)
  const targetIdx = rows.findIndex(r => r.id === targetId)
  if (fromIdx < 0 || targetIdx < 0 || fromIdx === targetIdx) return null

  const next = [...rows]
  const [moved] = next.splice(fromIdx, 1)
  const insertAt = next.findIndex(r => r.id === targetId) + (pos === 'after' ? 1 : 0)
  next.splice(insertAt, 0, moved!)
  if (next.every((r, i) => r === rows[i])) return null // landed back where it started

  const out: MixedReorder = { folders: [], decks: [] }
  next.forEach((r, i) => (r.kind === 'folder' ? out.folders : out.decks).push({ id: r.id, position: i }))
  return out
}
