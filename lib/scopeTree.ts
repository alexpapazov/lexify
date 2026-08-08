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

/** Build the pair→folder→deck tree from the user's folders + decks (mirrors the library). */
export function buildScopeTree(folders: Folder[], decks: Deck[]): PairNode[] {
  const pairKeys = Array.from(new Set(decks.map(d => `${d.sourceLanguage}|${d.targetLanguage}`)))
  return pairKeys.map(key => {
    const [source, target] = key.split('|') as [string, string]
    const pf = folders.filter(f => f.sourceLanguage === source && f.targetLanguage === target)
    const pd = decks.filter(d => d.sourceLanguage === source && d.targetLanguage === target)
    const pfIds = new Set(pf.map(f => f.id))
    const byPos = <T extends { position?: number; name: string }>(a: T, b: T) =>
      (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name)
    const deckNode = (d: Deck): DeckNode =>
      ({ kind: 'deck', id: d.id, name: d.name, source: d.sourceLanguage, target: d.targetLanguage })
    const folderNode = (f: Folder): FolderNode => {
      const childFolders = pf.filter(x => x.parentId === f.id).sort(byPos).map(folderNode)
      const childDecks = pd.filter(d => d.folderId === f.id).sort(byPos).map(deckNode)
      const children = [...childFolders, ...childDecks]
      const deckIds = children.flatMap(c => c.kind === 'folder' ? c.deckIds : [c.id])
      return { kind: 'folder', id: f.id, name: f.name, children, deckIds }
    }
    // A folder whose parent isn't in this pair is a root here — otherwise it would vanish.
    const rootFolders = pf.filter(f => !f.parentId || !pfIds.has(f.parentId)).sort(byPos).map(folderNode)
    const rootDecks = pd.filter(d => !d.folderId || !pfIds.has(d.folderId)).sort(byPos).map(deckNode)
    const children = [...rootFolders, ...rootDecks]
    return { kind: 'pair', key, source, target, children, deckIds: pd.map(d => d.id) }
  })
}
