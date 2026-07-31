/**
 * lib/folderOptions.ts — flattening a language pairing's folder tree for a <select>.
 *
 * Shared by every "save this deck somewhere" picker (create → preview, create → onboarding).
 */

import type { Deck, Folder } from '@/domain'
import { folderMatchesPair, descendantDeckIds } from '@/lib/folderStats'

/**
 * Depth-first list of the folders belonging to a language pairing, with indentation depth.
 * Empty synced folders are excluded — they're auto-managed leftovers, never a valid destination.
 */
export function buildFolderOptions(
  folders: Folder[],
  decks: Deck[],
  sourceLanguage: string,
  targetLanguage: string,
): Array<{ folder: Folder; depth: number }> {
  const matching = folders.filter(f => {
    if (!folderMatchesPair(f.id, folders, decks, sourceLanguage, targetLanguage)) return false
    if (f.isSynced && descendantDeckIds(f.id, folders, decks).length === 0) return false
    return true
  })
  const byParent = new Map<string | null, Folder[]>()
  for (const f of matching) {
    const arr = byParent.get(f.parentId) ?? []
    arr.push(f)
    byParent.set(f.parentId, arr)
  }
  const result: Array<{ folder: Folder; depth: number }> = []
  function walk(parentId: string | null, depth: number) {
    const children = (byParent.get(parentId) ?? []).slice().sort((a, b) => a.position - b.position)
    for (const c of children) {
      result.push({ folder: c, depth })
      walk(c.id, depth + 1)
    }
  }
  walk(null, 0)
  return result
}

export const NEW_FOLDER_VALUE = '__new__'
export const ROOT_FOLDER_VALUE = '__root__'
