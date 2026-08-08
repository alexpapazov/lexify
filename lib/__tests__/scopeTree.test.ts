import { buildScopeTree, type FolderNode } from '@/lib/scopeTree'
import type { Deck, Folder } from '@/domain'

function folder(id: string, name: string, parentId: string | null = null, pair: [string, string] | null = null): Folder {
  return {
    id, ownerId: 'u1', name, parentId, position: 0,
    createdAt: '', updatedAt: '', deletedAt: null, isSynced: false,
    // Null unless explicitly pinned — the default for ordinary subfolders, and the thing that
    // broke the old pair-filtered implementation.
    sourceLanguage: pair?.[0] ?? null,
    targetLanguage: pair?.[1] ?? null,
  }
}

function deck(id: string, name: string, folderId: string | null, source = 'bg', target = 'en'): Deck {
  return {
    id, ownerId: 'u1', name, sourceLanguage: source, targetLanguage: target,
    folderId, pipelineId: 'p1', position: 0,
    createdAt: '', updatedAt: '', deletedAt: null,
  } as unknown as Deck
}

const bg = (nodes: ReturnType<typeof buildScopeTree>) => nodes.find(p => p.key === 'bg|en')!

describe('buildScopeTree', () => {
  it('nests decks inside folders whose language fields are null', () => {
    // The reported bug: "5 клас" is pinned to the pair, its subfolder isn't, and the deck lives in
    // the subfolder. The folder must report its deck rather than showing 0 with the deck at root.
    const folders = [
      folder('f-klas', '5 клас', null, ['bg', 'en']),
      folder('f-lit', 'Литература', 'f-klas'),
    ]
    const decks = [deck('d1', 'Текст 1', 'f-lit')]
    const root = bg(buildScopeTree(folders, decks)).children

    expect(root).toHaveLength(1)
    const klas = root[0] as FolderNode
    expect(klas.kind).toBe('folder')
    expect(klas.name).toBe('5 клас')
    expect(klas.deckIds).toEqual(['d1'])          // the count the UI shows
    const lit = klas.children[0] as FolderNode
    expect(lit.name).toBe('Литература')
    expect(lit.children[0]).toMatchObject({ kind: 'deck', name: 'Текст 1' })
  })

  it('rolls descendant decks up through every level', () => {
    const folders = [folder('a', 'A'), folder('b', 'B', 'a'), folder('c', 'C', 'b')]
    const decks = [deck('d1', 'One', 'c'), deck('d2', 'Two', 'b')]
    const a = bg(buildScopeTree(folders, decks)).children[0] as FolderNode
    expect(a.deckIds.sort()).toEqual(['d1', 'd2'])
  })

  it('prunes folders holding none of this pair’s decks', () => {
    const folders = [folder('bgf', 'Bulgarian stuff'), folder('esf', 'Spanish stuff')]
    const decks = [deck('d1', 'BG deck', 'bgf'), deck('d2', 'ES deck', 'esf', 'es', 'en')]
    const names = bg(buildScopeTree(folders, decks)).children.map(n => n.name)
    expect(names).toEqual(['Bulgarian stuff'])
  })

  it('keeps a deck with no folder at the root', () => {
    const root = bg(buildScopeTree([], [deck('d1', 'Loose', null)])).children
    expect(root).toEqual([expect.objectContaining({ kind: 'deck', name: 'Loose' })])
  })

  it('treats a deck whose folder no longer exists as a root deck', () => {
    const root = bg(buildScopeTree([], [deck('d1', 'Orphan', 'deleted-folder')])).children
    expect(root).toEqual([expect.objectContaining({ kind: 'deck', name: 'Orphan' })])
  })

  it('treats a folder whose parent no longer exists as a root folder', () => {
    const folders = [folder('child', 'Child', 'gone')]
    const root = bg(buildScopeTree(folders, [deck('d1', 'Deck', 'child')])).children
    expect(root[0]).toMatchObject({ kind: 'folder', name: 'Child' })
  })

  it('lists folders before decks at the same level', () => {
    const folders = [folder('f', 'A folder')]
    const decks = [deck('d1', 'Loose deck', null), deck('d2', 'Nested', 'f')]
    const kinds = bg(buildScopeTree(folders, decks)).children.map(n => n.kind)
    expect(kinds).toEqual(['folder', 'deck'])
  })

  it('separates language pairs, and the pair node carries every deck', () => {
    const decks = [deck('d1', 'BG', null), deck('d2', 'ES', null, 'es', 'en')]
    const tree = buildScopeTree([], decks)
    expect(tree.map(p => p.key).sort()).toEqual(['bg|en', 'es|en'])
    expect(bg(tree).deckIds).toEqual(['d1'])
  })

  it('survives a parent cycle instead of recursing forever', () => {
    const folders = [folder('a', 'A', 'b'), folder('b', 'B', 'a')]
    expect(() => buildScopeTree(folders, [deck('d1', 'Deck', 'a')])).not.toThrow()
  })
})
