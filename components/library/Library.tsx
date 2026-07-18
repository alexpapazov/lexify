'use client'

/**
 * Library — infinitely-nested folder tree for organizing decks.
 *
 * Architecture:
 * - All folders are loaded flat, then assembled into a tree in memory.
 * - FolderNode is recursive — renders subfolders and decks inside each folder.
 * - State for expand/collapse, rename, new-folder lives entirely in this component.
 * - All mutations (create/rename/delete folder, pin deck, move deck) call
 *   the repositories directly and update local state optimistically.
 */

import { useState, useRef, useEffect } from 'react'
import { routes } from '@/lib/routes'
import Link from 'next/link'
import type { Folder, Deck, UserId, FolderId } from '@/domain'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseDeckRepository }   from '@/lib/data/decks'

// ─── Tree building ────────────────────────────────────────────────────────────

interface FolderNode {
  folder:      Folder
  children:    FolderNode[]
  decks:       Deck[]
}

function buildTree(folders: Folder[], decks: Deck[], parentId: FolderId | null): FolderNode[] {
  return folders
    .filter(f => f.parentId === parentId)
    .map(folder => ({
      folder,
      children: buildTree(folders, decks, folder.id),
      decks:    decks.filter(d => d.folderId === folder.id),
    }))
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-accent-soft shrink-0">
      <path d="M20 6H12l-2-2H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2z"/>
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-muted shrink-0">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 2h9a2 2 0 012 2z"/>
    </svg>
  )
}

// ─── Inline rename input ──────────────────────────────────────────────────────

function InlineInput({ initial, onCommit, onCancel }: {
  initial:  string
  onCommit: (v: string) => void
  onCancel: () => void
}) {
  const [val, setVal] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.select() }, [])

  return (
    <input
      ref={ref}
      className="bg-surface-raised border border-accent/40 rounded px-2 py-0.5 text-sm text-ink outline-none w-40"
      value={val}
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && val.trim()) onCommit(val.trim())
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => { if (val.trim()) onCommit(val.trim()); else onCancel() }}
    />
  )
}

// ─── Deck row inside a folder ─────────────────────────────────────────────────

function DeckRow({ deck, allFolders, onMove, onPin }: {
  deck:       Deck
  allFolders: Folder[]
  onMove:     (deckId: string, folderId: FolderId | null) => void
  onPin:      (deckId: string, pinned: boolean) => void
}) {
  const [showMove, setShowMove] = useState(false)

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-surface-raised/50 group">
      <Link href={routes.deck(deck.id)} className="flex-1 text-sm text-ink truncate min-w-0">
        {deck.name}
      </Link>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {/* Pin toggle */}
        <button
          onClick={() => onPin(deck.id, !deck.isPinned)}
          title={deck.isPinned ? 'Unpin' : 'Pin to top'}
          className="text-ink-faint hover:text-warning transition-colors text-xs px-1"
        >
          {deck.isPinned ? '★' : '☆'}
        </button>
        {/* Move */}
        <div className="relative">
          <button
            onClick={() => setShowMove(v => !v)}
            className="text-ink-faint hover:text-ink transition-colors text-xs px-1"
            title="Move to folder"
          >
            ↪
          </button>
          {showMove && (
            <div className="absolute right-0 top-5 z-50 bg-surface border border-line/10 rounded-lg shadow-xl min-w-[160px] py-1">
              <button
                onClick={() => { onMove(deck.id, null); setShowMove(false) }}
                className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-raised hover:text-ink transition-colors"
              >
                ↑ Root (no folder)
              </button>
              {allFolders.map(f => (
                <button
                  key={f.id}
                  onClick={() => { onMove(deck.id, f.id); setShowMove(false) }}
                  className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-raised hover:text-ink transition-colors"
                >
                  {f.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <Link href={routes.ladderDeck(deck.id)}
          className="text-xs text-accent hover:text-accent-soft transition-colors px-1"
          title="Study">
          ▶
        </Link>
      </div>
    </div>
  )
}

// ─── Recursive folder node ────────────────────────────────────────────────────

function FolderNodeView({ node, depth, allFolders, userId, onRefresh, onMove, onPin }: {
  node:       FolderNode
  depth:      number
  allFolders: Folder[]
  userId:     UserId
  onRefresh:  () => void
  onMove:     (deckId: string, folderId: FolderId | null) => void
  onPin:      (deckId: string, pinned: boolean) => void
}) {
  const [open,       setOpen]       = useState(true)
  const [renaming,   setRenaming]   = useState(false)
  const [addingSub,  setAddingSub]  = useState(false)
  const [showMenu,   setShowMenu]   = useState(false)
  const folderRepo = new SupabaseFolderRepository()

  const indent = depth * 16

  async function handleRename(name: string) {
    await folderRepo.rename(node.folder.id, name)
    setRenaming(false)
    onRefresh()
  }

  async function handleDelete() {
    if (!confirm(`Delete folder "${node.folder.name}" and move its contents to root?`)) return
    await folderRepo.softDelete(node.folder.id)
    onRefresh()
  }

  async function handleAddSubfolder(name: string) {
    await folderRepo.create(userId, name, node.folder.id)
    setAddingSub(false)
    setOpen(true)
    onRefresh()
  }

  const hasContents = node.children.length > 0 || node.decks.length > 0

  return (
    <div>
      {/* Folder header row */}
      <div
        className="flex items-center gap-1.5 py-1.5 rounded-md hover:bg-surface-raised/40 group cursor-pointer select-none"
        style={{ paddingLeft: `${indent + 8}px` }}
      >
        {/* Expand/collapse chevron */}
        <button onClick={() => setOpen(v => !v)} className="text-ink-faint hover:text-ink transition-colors">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
            className={`transition-transform ${open ? 'rotate-90' : ''}`}>
            <path d="M8 5l8 7-8 7V5z"/>
          </svg>
        </button>

        <button onClick={() => setOpen(v => !v)} className="flex items-center gap-1.5 flex-1 min-w-0">
          <FolderIcon open={open} />
          {renaming ? (
            <InlineInput initial={node.folder.name} onCommit={handleRename} onCancel={() => setRenaming(false)} />
          ) : (
            <span className="text-sm text-ink truncate">{node.folder.name}</span>
          )}
          {hasContents && (
            <span className="text-xs text-ink-faint ml-1">
              {node.decks.length + node.children.length}
            </span>
          )}
        </button>

        {/* Folder actions — show on hover */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity pr-2 shrink-0">
          <button onClick={() => { setAddingSub(true); setOpen(true) }}
            title="New subfolder"
            className="text-ink-faint hover:text-ink text-xs px-1 transition-colors">+</button>
          <button onClick={() => setRenaming(true)}
            title="Rename"
            className="text-ink-faint hover:text-ink text-xs px-1 transition-colors">✎</button>
          <button onClick={handleDelete}
            title="Delete folder"
            className="text-ink-faint hover:text-danger text-xs px-1 transition-colors">✕</button>
        </div>
      </div>

      {/* Folder contents */}
      {open && (
        <div>
          {/* Add subfolder input */}
          {addingSub && (
            <div style={{ paddingLeft: `${indent + 28}px` }} className="py-1">
              <InlineInput initial="" onCommit={handleAddSubfolder} onCancel={() => setAddingSub(false)} />
            </div>
          )}

          {/* Subfolders (recursive) */}
          {node.children.map(child => (
            <FolderNodeView
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              allFolders={allFolders}
              userId={userId}
              onRefresh={onRefresh}
              onMove={onMove}
              onPin={onPin}
            />
          ))}

          {/* Decks in this folder */}
          <div style={{ paddingLeft: `${indent + 20}px` }}>
            {node.decks.map(deck => (
              <DeckRow
                key={deck.id}
                deck={deck}
                allFolders={allFolders}
                onMove={onMove}
                onPin={onPin}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Library component ───────────────────────────────────────────────────

interface LibraryProps {
  userId:    UserId
  folders:   Folder[]
  allDecks:  Deck[]
  onRefresh: () => void
}

export function Library({ userId, folders, allDecks, onRefresh }: LibraryProps) {
  const [addingRoot, setAddingRoot] = useState(false)
  const folderRepo = new SupabaseFolderRepository()
  const deckRepo   = new SupabaseDeckRepository()

  // Root-level decks: no folder
  const rootDecks    = allDecks.filter(d => !d.folderId)
  const rootTree     = buildTree(folders, allDecks, null)
  const hasContent   = rootDecks.length > 0 || rootTree.length > 0

  async function handleAddRootFolder(name: string) {
    await folderRepo.create(userId, name, null)
    setAddingRoot(false)
    onRefresh()
  }

  async function handleMove(deckId: string, folderId: FolderId | null) {
    await deckRepo.update(deckId, { folderId })
    onRefresh()
  }

  async function handlePin(deckId: string, pinned: boolean) {
    await deckRepo.update(deckId, { isPinned: pinned })
    onRefresh()
  }

  return (
    <div className="space-y-2">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-ink">Library</h2>
        <button
          onClick={() => setAddingRoot(true)}
          className="text-sm text-accent hover:text-accent-soft transition-colors"
        >
          + New folder
        </button>
      </div>

      {/* New root folder input */}
      {addingRoot && (
        <div className="px-2 py-1">
          <InlineInput initial="" onCommit={handleAddRootFolder} onCancel={() => setAddingRoot(false)} />
        </div>
      )}

      {!hasContent && !addingRoot ? (
        <div className="text-ink-muted text-sm panel">
          No decks in your library yet. Upload a deck or move one here from Pinned decks.
        </div>
      ) : (
        <div className="panel p-2 space-y-0.5">
          {/* Root-level folders */}
          {rootTree.map(node => (
            <FolderNodeView
              key={node.folder.id}
              node={node}
              depth={0}
              allFolders={folders}
              userId={userId}
              onRefresh={onRefresh}
              onMove={handleMove}
              onPin={handlePin}
            />
          ))}

          {/* Root-level decks (no folder) */}
          {rootDecks.map(deck => (
            <DeckRow
              key={deck.id}
              deck={deck}
              allFolders={folders}
              onMove={handleMove}
              onPin={handlePin}
            />
          ))}
        </div>
      )}
    </div>
  )
}
