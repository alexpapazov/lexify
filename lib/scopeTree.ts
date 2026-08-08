/**
 * lib/scopeTree.ts — the library's shape as a pickable tree: pair → folders → subfolders → decks.
 *
 * Shared by every "choose part of my library" surface (the card-editor agent's scope picker, the
 * practice-mode deck picker) so they can't drift apart — a flat list of folder names is unreadable
 * once two folders share a name, which happens constantly with per-year or per-lesson structures.
 *
 * Each folder node carries `deckIds` — every deck beneath it, at any depth — so a UI can treat
 * checking a folder as "check all its decks" without walking the tree itself.
 *
 * Pure: plain data in, plain data out.
 */

import type { Deck, Folder } from '@/domain'

export type DeckNode   = { kind: 'deck'; id: string; name: string; source: string; target: string }
export type FolderNode = { kind: 'folder'; id: string; name: string; children: TreeNode[]; deckIds: string[] }
export type TreeNode   = DeckNode | FolderNode
export type PairNode   = { kind: 'pair'; key: string; source: string; target: string; children: TreeNode[]; deckIds: string[] }

/**
 * Build the pair→folder→deck tree from the user's folders + decks (mirrors the library).
 *
 * ⚠️ **Folders are NOT filtered by language pair, deliberately.** `Folder.sourceLanguage` is
 * nullable — it's set only on folders pinned to one pair's view, so ordinary subfolders carry null.
 * Filtering folders by `f.sourceLanguage === source` therefore drops most of the hierarchy, which
 * orphans every deck inside it to the root and leaves the surviving parents reporting zero decks.
 * (That was a real bug: "5 клас" showed 0 while its decks sat loose at the top level.)
 *
 * Instead the structure comes from ALL folders, this pair's decks are hung off it, and any folder
 * with none of those decks anywhere beneath it is pruned — which is also how the library itself
 * decides folder visibility (`folderMatchesPair`).
 */
export function buildScopeTree(folders: Folder[], decks: Deck[]): PairNode[] {
  const pairKeys = Array.from(new Set(decks.map(d => `${d.sourceLanguage}|${d.targetLanguage}`)))
  const folderIds = new Set(folders.map(f => f.id))
  const byPos = <T extends { position?: number; name: string }>(a: T, b: T) =>
    (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name)

  const childFoldersOf = new Map<string, Folder[]>()
  for (const f of folders) {
    const key = f.parentId && folderIds.has(f.parentId) ? f.parentId : '__root__'
    const list = childFoldersOf.get(key) ?? []
    list.push(f)
    childFoldersOf.set(key, list)
  }

  return pairKeys.map(key => {
    const [source, target] = key.split('|') as [string, string]
    const pd = decks.filter(d => d.sourceLanguage === source && d.targetLanguage === target)

    const decksOf = new Map<string, Deck[]>()
    for (const d of pd) {
      const k = d.folderId && folderIds.has(d.folderId) ? d.folderId : '__root__'
      const list = decksOf.get(k) ?? []
      list.push(d)
      decksOf.set(k, list)
    }

    const deckNode = (d: Deck): DeckNode =>
      ({ kind: 'deck', id: d.id, name: d.name, source: d.sourceLanguage, target: d.targetLanguage })

    // `seen` guards against a malformed parent cycle rather than recursing forever.
    const folderNode = (f: Folder, seen: Set<string>): FolderNode | null => {
      if (seen.has(f.id)) return null
      const nextSeen = new Set(seen).add(f.id)
      const kids = (childFoldersOf.get(f.id) ?? []).sort(byPos)
        .map(cf => folderNode(cf, nextSeen))
        .filter((n): n is FolderNode => n !== null)
      const ownDecks = (decksOf.get(f.id) ?? []).sort(byPos).map(deckNode)
      const children: TreeNode[] = [...kids, ...ownDecks]
      const deckIds = children.flatMap(c => c.kind === 'folder' ? c.deckIds : [c.id])
      // Prune: a folder holding none of THIS pair's decks is noise in this pair's picker.
      if (deckIds.length === 0) return null
      return { kind: 'folder', id: f.id, name: f.name, children, deckIds }
    }

    const rootFolders = (childFoldersOf.get('__root__') ?? []).sort(byPos)
      .map(f => folderNode(f, new Set()))
      .filter((n): n is FolderNode => n !== null)
    const rootDecks = (decksOf.get('__root__') ?? []).sort(byPos).map(deckNode)

    return {
      kind: 'pair', key, source, target,
      children: [...rootFolders, ...rootDecks],
      deckIds: pd.map(d => d.id),
    }
  })
}
