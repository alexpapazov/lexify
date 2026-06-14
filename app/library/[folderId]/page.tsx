'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseDeckRepository }   from '@/lib/data/decks'
import { SupabaseCardRepository }      from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { descendantDeckIds, folderMatchesPair, type FolderCounts } from '@/lib/folderStats'
import type { Folder, Deck, Card, CardState } from '@/domain'

type FilterKey = 'new' | 'learning' | 'graduated' | 'due'

interface DeckWithCards {
  deck:   Deck
  cards:  Card[]
  states: CardState[]
}

// A flat card entry for the cross-deck filtered view
interface FilteredCard {
  card:     Card
  state:    CardState | undefined
  deckName: string
  deckId:   string
  status:   string
}

// ─── Types ────────────────────────────────────────────────────────────────────

type DragItem  = { type: 'folder'; id: string } | { type: 'deck'; id: string }
type DropPos   = 'before' | 'into' | 'after'
type DropTarget = { id: string; pos: DropPos } | null

// ─── Custom drag image ────────────────────────────────────────────────────────

const FOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="33" height="33" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.75"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`
const DECK_SVG   = `<svg xmlns="http://www.w3.org/2000/svg" width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.75"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M6 6V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/></svg>`

function applyDragImage(e: React.DragEvent, type: 'folder' | 'deck') {
  const ghost = document.createElement('div')
  ghost.innerHTML = type === 'folder' ? FOLDER_SVG : DECK_SVG
  ghost.style.cssText = 'position:fixed;top:-200px;left:-200px;opacity:0.9;pointer-events:none'
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, 20, 20)
  setTimeout(() => document.body.removeChild(ghost), 0)
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function FolderIcon({ className = 'text-accent-soft' }: { className?: string }) {
  return (
    <svg width="33" height="33" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className={`shrink-0 ${className}`}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}

function DeckIcon() {
  return (
    <svg width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-ink-muted shrink-0">
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <path d="M6 6V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDropPos(e: React.DragEvent, isFolder: boolean): DropPos {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const pct  = (e.clientY - rect.top) / rect.height
  if (pct < 0.33) return 'before'
  if (isFolder && pct < 0.67) return 'into'
  return 'after'
}

function reorder<T>(arr: T[], fromIdx: number, toIdx: number, pos: 'before' | 'after'): T[] {
  const next = [...arr]
  const item = next.splice(fromIdx, 1)[0] as T
  const insertAt = pos === 'before' ? toIdx : toIdx + 1
  const adjusted = fromIdx < insertAt ? insertAt - 1 : insertAt
  next.splice(adjusted, 0, item)
  return next
}

function buildAncestors(allFolders: Folder[], currentId: string): Folder[] {
  const map = new Map(allFolders.map(f => [f.id, f]))
  const chain: Folder[] = []
  let cur = map.get(currentId)
  while (cur?.parentId) {
    const parent = map.get(cur.parentId)
    if (!parent) break
    chain.unshift(parent)
    cur = parent
  }
  return chain
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FolderPage() {
  return (
    <Suspense fallback={<div className="text-ink-muted pt-16 text-center">Loading…</div>}>
      <FolderPageInner />
    </Suspense>
  )
}

function FolderPageInner() {
  const params   = useParams()
  const router   = useRouter()
  const searchParams = useSearchParams()
  const folderId = params.folderId as string

  const pairSource = searchParams.get('source')
  const pairTarget = searchParams.get('target')
  const inPair = !!(pairSource && pairTarget)
  const qs = inPair ? `?source=${pairSource}&target=${pairTarget}` : ''

  const [folder,       setFolder]       = useState<Folder | null>(null)
  const [ancestors,    setAncestors]    = useState<Folder[]>([])
  const [subfolders,   setSubfolders]   = useState<Folder[]>([])
  const [decks,        setDecks]        = useState<Deck[]>([])
  const [allFolders,   setAllFolders]   = useState<Folder[]>([])
  const [allDecks,     setAllDecks]     = useState<Deck[]>([])
  const [loading,      setLoading]      = useState(true)
  const [authed,       setAuthed]       = useState(false)
  const [userId,       setUserId]       = useState('')
  const [addingFolder, setAddingFolder] = useState(false)
  const [newName,      setNewName]      = useState('')
  const [counts,       setCounts]       = useState<FolderCounts | null>(null)
  const [deckStats,    setDeckStats]    = useState<DeckWithCards[]>([])
  const [activeFilter, setActiveFilter] = useState<FilterKey | null>(null)

  // Drag state
  const [dragging,    setDragging]    = useState<DragItem | null>(null)
  const [dropTarget,  setDropTarget]  = useState<DropTarget>(null)
  // Which breadcrumb segment is being hovered: null | 'root' | ancestorId
  const [crumbTarget, setCrumbTarget] = useState<string | null>(null)

  // Touch drag state
  const [touchGhost,  setTouchGhost]  = useState<{ x: number; y: number; type: 'folder' | 'deck' } | null>(null)
  const draggingRef   = useRef<DragItem | null>(null)
  const dropTargetRef = useRef<DropTarget>(null)
  const commitDropRef = useRef(commitDrop)
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { draggingRef.current   = dragging   }, [dragging])
  useEffect(() => { dropTargetRef.current = dropTarget }, [dropTarget])

  const supabase = createClient()

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoading(false); return }
    setAuthed(true)
    setUserId(session.user.id)

    const folderRepo = new SupabaseFolderRepository()
    const deckRepo   = new SupabaseDeckRepository()

    const [thisFolder, folders, decksData] = await Promise.all([
      folderRepo.get(folderId),
      folderRepo.list(session.user.id),
      deckRepo.list(session.user.id),
    ])

    if (!thisFolder) { setLoading(false); return }

    setFolder(thisFolder)
    setAncestors(buildAncestors(folders, folderId))
    setSubfolders(folders.filter(f => f.parentId === folderId))
    setDecks(decksData.filter(d => d.folderId === folderId))
    setAllFolders(folders)
    setAllDecks(decksData)
    setLoading(false)

    // Aggregate stats for every card in this folder (including subfolders)
    const deckIds = descendantDeckIds(folderId, folders, decksData)
    const cardRepo  = new SupabaseCardRepository()
    const stateRepo = new SupabaseCardStateRepository()
    const relevantDecks = decksData.filter(d => deckIds.includes(d.id))

    const stats = await Promise.all(relevantDecks.map(async deck => {
      const [cards, states] = await Promise.all([
        cardRepo.listByDeck(deck.id),
        stateRepo.listByDeck(session.user.id, deck.id),
      ])
      return { deck, cards, states }
    }))
    setDeckStats(stats)

    const now = new Date()
    setCounts(stats.reduce((acc, { cards, states }) => {
      const stateMap = new Map(states.map(s => [s.cardId, s]))
      return {
        unlearned: acc.unlearned + cards.filter(c => !stateMap.has(c.id)).length,
        learning:  acc.learning  + states.filter(s => !s.graduated).length,
        graduated: acc.graduated + states.filter(s => s.graduated).length,
        dueNow:    acc.dueNow    + states.filter(s => s.graduated && s.dueAt && new Date(s.dueAt) <= now).length,
      }
    }, { unlearned: 0, learning: 0, graduated: 0, dueNow: 0 }))
  }

  useEffect(() => { load() }, [folderId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Subfolders/decks visible in the active language-pairing view (if any)
  function getVisibleItems() {
    if (!inPair) return { subfolders, decks }
    return {
      subfolders: subfolders.filter(f => folderMatchesPair(f.id, allFolders, allDecks, pairSource!, pairTarget!)),
      decks:      decks.filter(d => d.sourceLanguage === pairSource && d.targetLanguage === pairTarget),
    }
  }

  // Build the filtered card list across all decks in this folder (incl. subfolders)
  const now = new Date()
  const filteredCards: FilteredCard[] = activeFilter ? deckStats.flatMap(({ deck, cards, states }) => {
    const stateMap = new Map(states.map(s => [s.cardId, s]))
    return cards
      .filter(card => {
        const s = stateMap.get(card.id)
        if (activeFilter === 'new')       return !s
        if (activeFilter === 'learning')  return s && !s.graduated
        if (activeFilter === 'graduated') return !!s?.graduated
        if (activeFilter === 'due')       return s?.graduated && s.dueAt && new Date(s.dueAt) <= now
        return false
      })
      .map(card => {
        const s = stateMap.get(card.id)
        const status = !s ? 'New' : s.graduated ? 'Graduated' : `Step ${s.currentStepOrder + 1}`
        return { card, state: s, deckName: deck.name, deckId: deck.id, status }
      })
  }) : []

  const COUNTER_CONFIG = counts ? [
    { key: 'new'       as FilterKey, label: 'Unlearned', value: counts.unlearned, color: 'text-ink-muted',   border: 'border-ink-faint' },
    { key: 'learning'  as FilterKey, label: 'Learning',  value: counts.learning,  color: 'text-warning',     border: 'border-warning'   },
    { key: 'graduated' as FilterKey, label: 'Graduated', value: counts.graduated, color: 'text-success',     border: 'border-success'   },
    { key: 'due'       as FilterKey, label: 'Due Now',   value: counts.dueNow,    color: 'text-accent-soft', border: 'border-accent'    },
  ] : []

  // ── Drop onto row ─────────────────────────────────────────────────────────

  async function commitDrop(target: DropTarget) {
    if (!dragging || !target) return
    const folderRepo = new SupabaseFolderRepository()
    const deckRepo   = new SupabaseDeckRepository()

    if (target.pos === 'into') {
      if (dragging.type === 'folder' && dragging.id !== target.id) {
        await folderRepo.updateParent(dragging.id, target.id)
      } else if (dragging.type === 'deck') {
        await deckRepo.update(dragging.id, { folderId: target.id })
      }
    } else {
      const { subfolders: visibleSubfolders, decks: visibleDecks } = getVisibleItems()
      if (dragging.type === 'folder') {
        const fromIdx = visibleSubfolders.findIndex(f => f.id === dragging.id)
        const toIdx   = visibleSubfolders.findIndex(f => f.id === target.id)
        if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
          const reordered = reorder(visibleSubfolders, fromIdx, toIdx, target.pos)
          await folderRepo.updatePositions(reordered.map((f, i) => ({ id: f.id, position: i })))
        }
      } else {
        // Deck → dropped on folder = move into
        if (allFolders.some(f => f.id === target.id)) {
          await deckRepo.update(dragging.id, { folderId: target.id })
        } else {
          const fromIdx = visibleDecks.findIndex(d => d.id === dragging.id)
          const toIdx   = visibleDecks.findIndex(d => d.id === target.id)
          if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
            const reordered = reorder(visibleDecks, fromIdx, toIdx, target.pos)
            await deckRepo.updatePositions(reordered.map((d, i) => ({ id: d.id, position: i })))
          }
        }
      }
    }

    setDragging(null)
    setDropTarget(null)
    load()
  }

  // ── Drop onto breadcrumb ──────────────────────────────────────────────────

  async function commitCrumbDrop(targetFolderId: string | null) {
    if (!dragging) return
    const folderRepo = new SupabaseFolderRepository()
    const deckRepo   = new SupabaseDeckRepository()

    if (dragging.type === 'folder') {
      await folderRepo.updateParent(dragging.id, targetFolderId)
    } else {
      await deckRepo.update(dragging.id, { folderId: targetFolderId })
    }

    setDragging(null)
    setCrumbTarget(null)
    load()
  }

  // ── Touch drag ────────────────────────────────────────────────────────────
  useEffect(() => { commitDropRef.current = commitDrop })

  function onItemTouchStart(e: React.TouchEvent, item: DragItem) {
    const t = e.touches[0]!
    const startX = t.clientX, startY = t.clientY
    touchTimerRef.current = setTimeout(() => {
      setDragging(item)
      setTouchGhost({ x: startX, y: startY, type: item.type })
    }, 350)
  }

  function onItemTouchMove(e: React.TouchEvent) {
    if (!touchGhost && touchTimerRef.current) {
      clearTimeout(touchTimerRef.current)
      touchTimerRef.current = null
    }
  }

  useEffect(() => {
    if (!touchGhost) return
    function onMove(e: TouchEvent) {
      e.preventDefault()
      const t = e.touches[0]!
      setTouchGhost(g => g ? { ...g, x: t.clientX, y: t.clientY } : null)
      const els = document.elementsFromPoint(t.clientX, t.clientY)
      const target = els.find(el => {
        const h = el as HTMLElement
        return h.dataset?.dragId && h.dataset.dragId !== draggingRef.current?.id
      }) as HTMLElement | undefined
      if (target?.dataset.dragId) {
        const rect = target.getBoundingClientRect()
        const pct  = (t.clientY - rect.top) / rect.height
        const isF  = target.dataset.dragType === 'folder'
        const pos: DropPos = pct < 0.33 ? 'before' : (isF && pct < 0.67 ? 'into' : 'after')
        setDropTarget({ id: target.dataset.dragId, pos })
      } else {
        setDropTarget(null)
      }
    }
    function onEnd() {
      const item = draggingRef.current
      const tgt  = dropTargetRef.current
      if (item && tgt) commitDropRef.current(tgt)
      else { setDragging(null); setDropTarget(null) }
      setTouchGhost(null)
      if (touchTimerRef.current) clearTimeout(touchTimerRef.current)
    }
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend',  onEnd)
    return () => {
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend',  onEnd)
    }
  }, [touchGhost]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAddFolder() {
    const name = newName.trim()
    if (!name || !userId) return
    const folderRepo = new SupabaseFolderRepository()
    await folderRepo.create(userId, name, folderId)
    setNewName('')
    setAddingFolder(false)
    load()
  }

  async function handlePin(deckId: string, pinned: boolean) {
    const deckRepo = new SupabaseDeckRepository()
    await deckRepo.update(deckId, { isPinned: pinned })
    load()
  }

  async function handleDeleteCurrentFolder() {
    if (!folder) return
    const destination = folder.parentId ? 'its parent folder' : 'the library root'
    if (!confirm(`Delete folder "${folder.name}"? Its subfolders and decks will move to ${destination}.`)) return

    const folderRepo = new SupabaseFolderRepository()
    const deckRepo   = new SupabaseDeckRepository()
    const parentId   = folder.parentId

    try {
      // Move this folder's direct contents (subfolders + decks) up to its parent
      // (or to the library root if this was a top-level folder) before deleting it.
      await Promise.all([
        ...subfolders.map(f => folderRepo.updateParent(f.id, parentId)),
        ...decks.map(d => deckRepo.update(d.id, { folderId: parentId })),
      ])
      await folderRepo.softDelete(folder.id)
    } catch (err) {
      alert(`Couldn't delete this folder: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    router.push((parentId ? `/library/${parentId}` : '/library') + qs)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  if (!authed) return (
    <div className="panel text-center space-y-4 py-12 max-w-2xl mx-auto">
      <p className="text-ink-muted">Sign in to access your Library.</p>
      <Link href="/auth" className="btn-primary inline-block">Sign in</Link>
    </div>
  )

  if (!folder) return (
    <div className="panel text-center space-y-4 py-12 max-w-2xl mx-auto">
      <p className="text-ink-muted">Folder not found.</p>
      <Link href="/library" className="btn-primary inline-block">Back to Library</Link>
    </div>
  )

  const { subfolders: visibleSubfolders, decks: visibleDecks } = getVisibleItems()

  return (
    <div
      className="space-y-5 max-w-2xl mx-auto"
      onDragEnd={() => { setDragging(null); setDropTarget(null); setCrumbTarget(null) }}
    >
      {/* Breadcrumb — each segment is a drop target when dragging */}
      <nav className="text-sm flex items-center gap-1.5 flex-wrap">
        {/* Library root */}
        <span
          onDragOver={e => { if (dragging) { e.preventDefault(); setCrumbTarget('root') } }}
          onDragLeave={() => setCrumbTarget(null)}
          onDrop={e => { e.preventDefault(); commitCrumbDrop(null) }}
          className={`transition-all rounded px-1 -mx-1 ${
            crumbTarget === 'root' && dragging
              ? 'bg-accent/20 text-accent ring-1 ring-accent/40'
              : 'text-ink-muted hover:text-ink'
          }`}
        >
          <Link href={`/library${qs}`}>Library</Link>
        </span>

        {/* Ancestor folders */}
        {ancestors.map(ancestor => (
          <>
            <span key={`sep-${ancestor.id}`} className="text-ink-faint">/</span>
            <span
              key={ancestor.id}
              onDragOver={e => { if (dragging) { e.preventDefault(); setCrumbTarget(ancestor.id) } }}
              onDragLeave={() => setCrumbTarget(null)}
              onDrop={e => { e.preventDefault(); commitCrumbDrop(ancestor.id) }}
              className={`transition-all rounded px-1 -mx-1 ${
                crumbTarget === ancestor.id && dragging
                  ? 'bg-accent/20 text-accent ring-1 ring-accent/40'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              <Link href={`/library/${ancestor.id}${qs}`}>{ancestor.name}</Link>
            </span>
          </>
        ))}

        <span className="text-ink-faint">/</span>
        <span className="text-ink font-medium">{folder.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">{folder.name}</h1>
        <div className="flex items-center gap-4">
          <button
            onClick={() => { setAddingFolder(true); setNewName('') }}
            className="text-sm text-accent hover:text-accent-soft transition-colors"
          >
            + New folder
          </button>
          <button
            onClick={handleDeleteCurrentFolder}
            className="text-sm text-ink-faint hover:text-danger transition-colors"
          >
            Delete folder
          </button>
        </div>
      </div>

      {/* Stats + Study button for this folder (including subfolders) */}
      {counts && (counts.unlearned + counts.learning + counts.graduated) > 0 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {COUNTER_CONFIG.map(({ key, label, value, color, border }) => {
              const isActive = activeFilter === key
              return (
                <button
                  key={key}
                  onClick={() => setActiveFilter(isActive ? null : key)}
                  className={`panel border-t-2 ${border} space-y-1 text-center transition-colors w-full
                    ${isActive ? 'bg-surface-raised ring-1 ring-white/10' : 'hover:bg-surface-raised/50'}`}
                >
                  <div className={`text-2xl font-semibold ${color}`}>{value}</div>
                  <div className="text-xs font-medium text-ink">{label}</div>
                </button>
              )
            })}
          </div>

          {/* Filtered card list (cross-deck within this folder) */}
          {activeFilter && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">
                  {COUNTER_CONFIG.find(c => c.key === activeFilter)?.label} — {filteredCards.length} card{filteredCards.length !== 1 ? 's' : ''}
                </h2>
                <button onClick={() => setActiveFilter(null)} className="text-xs text-accent hover:text-accent-soft transition-colors">
                  Show all ✕
                </button>
              </div>

              {filteredCards.length === 0 ? (
                <div className="panel text-ink-muted text-sm text-center py-6">No cards in this category.</div>
              ) : (
                <div className="panel divide-y divide-white/5 p-0 overflow-hidden">
                  {filteredCards.map(({ card, deckName, deckId, status }) => (
                    <Link
                      key={card.id}
                      href={`/study/${deckId}?filter=${activeFilter}`}
                      className="flex items-center justify-between px-4 py-3 hover:bg-surface-raised/50 transition-colors"
                    >
                      <div className="flex gap-6 text-sm min-w-0">
                        <span className="text-ink font-medium w-36 truncate shrink-0">{card.front}</span>
                        <span className="text-ink-muted truncate">{card.back}</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-2">
                        <span className="text-xs text-ink-faint hidden sm:block">{deckName}</span>
                        <span className="chip">{status}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          <Link
            href={`/study/folder/${folderId}/session`}
            className={(counts.dueNow + counts.learning) === 0 ? 'btn-primary opacity-40 pointer-events-none inline-block' : 'btn-primary inline-block'}
          >
            Study folder ({counts.dueNow + counts.learning})
          </Link>
        </div>
      )}

      {/* New folder input */}
      {addingFolder && (
        <div className="panel flex items-center gap-3 py-2.5">
          <FolderIcon />
          <input
            autoFocus
            className="flex-1 bg-transparent outline-none text-sm text-ink placeholder-ink-faint"
            placeholder="Folder name…"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAddFolder()
              if (e.key === 'Escape') { setAddingFolder(false); setNewName('') }
            }}
          />
          <button onClick={handleAddFolder} className="btn-primary text-xs py-1 px-3">Create</button>
          <button onClick={() => setAddingFolder(false)} className="text-ink-faint hover:text-ink text-xs transition-colors">Cancel</button>
        </div>
      )}

      {/* Contents */}
      {visibleSubfolders.length === 0 && visibleDecks.length === 0 && !addingFolder ? (
        <div className="panel text-ink-muted text-sm text-center py-10">
          This folder is empty. Add a subfolder or drag decks here.
        </div>
      ) : (
        <div className="space-y-0">
          {/* Subfolders */}
          {visibleSubfolders.map(sub => {
            const dt         = dropTarget?.id === sub.id ? dropTarget : null
            const isDragging = dragging?.type === 'folder' && dragging.id === sub.id

            return (
              <div key={sub.id} className="relative">
                {dt?.pos === 'before' && (
                  <div className="absolute top-0 left-0 right-0 h-0.5 bg-accent rounded-full z-10 -translate-y-0.5" />
                )}
                <div
                  draggable
                  data-drag-id={sub.id}
                  data-drag-type="folder"
                  onDragStart={e => { applyDragImage(e, 'folder'); setDragging({ type: 'folder', id: sub.id }) }}
                  onDragOver={e => {
                    e.preventDefault()
                    if (dragging?.id === sub.id) return
                    setDropTarget({ id: sub.id, pos: getDropPos(e, true) })
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={e => { e.preventDefault(); commitDrop({ id: sub.id, pos: dropTarget?.pos ?? 'after' }) }}
                  onTouchStart={e => onItemTouchStart(e, { type: 'folder', id: sub.id })}
                  onTouchMove={onItemTouchMove}
                  style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
                  className={`panel flex items-center gap-3 py-3 my-0.5 transition-all cursor-grab active:cursor-grabbing select-none ${
                    isDragging      ? 'opacity-40' :
                    dt?.pos === 'into' ? 'border-accent bg-accent/5 scale-[1.01]' :
                    'hover:border-white/10'
                  }`}
                >
                  <FolderIcon />
                  <Link
                    href={`/library/${sub.id}${qs}`}
                    className="flex-1 min-w-0"
                    onClick={e => { if (dragging) e.preventDefault() }}
                  >
                    <div className="text-sm font-medium text-ink truncate">{sub.name}</div>
                  </Link>
                </div>
                {dt?.pos === 'after' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-full z-10 translate-y-0.5" />
                )}
              </div>
            )
          })}

          {/* Decks */}
          {visibleDecks.map(deck => {
            const dt         = dropTarget?.id === deck.id ? dropTarget : null
            const isDragging = dragging?.type === 'deck' && dragging.id === deck.id

            return (
              <div key={deck.id} className="relative">
                {dt?.pos === 'before' && (
                  <div className="absolute top-0 left-0 right-0 h-0.5 bg-accent rounded-full z-10 -translate-y-0.5" />
                )}
                <div
                  draggable
                  data-drag-id={deck.id}
                  data-drag-type="deck"
                  onDragStart={e => { applyDragImage(e, 'deck'); setDragging({ type: 'deck', id: deck.id }) }}
                  onDragOver={e => {
                    e.preventDefault()
                    setDropTarget({ id: deck.id, pos: getDropPos(e, false) })
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={e => { e.preventDefault(); commitDrop({ id: deck.id, pos: dropTarget?.pos ?? 'after' }) }}
                  onTouchStart={e => onItemTouchStart(e, { type: 'deck', id: deck.id })}
                  onTouchMove={onItemTouchMove}
                  style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
                  className={`panel flex items-center gap-3 py-3 my-0.5 transition-all cursor-grab active:cursor-grabbing select-none ${
                    isDragging ? 'opacity-40' : 'hover:border-white/10'
                  }`}
                >
                  <DeckIcon />
                  <div className="flex-1 min-w-0">
                    <Link href={`/study/${deck.id}`} className="text-sm font-medium text-ink truncate block hover:text-accent transition-colors">
                      {deck.name}
                    </Link>
                    <div className="text-xs text-ink-muted mt-0.5">{deck.targetLanguage.toUpperCase()}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => handlePin(deck.id, !deck.isPinned)}
                      className="text-ink-faint hover:text-warning transition-colors text-sm">
                      {deck.isPinned ? '★' : '☆'}
                    </button>
                    <Link href={`/study/${deck.id}/session`} className="btn-primary text-xs py-1 px-3">Study</Link>
                  </div>
                </div>
                {dt?.pos === 'after' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-full z-10 translate-y-0.5" />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Touch drag ghost icon */}
      {touchGhost && (
        <div
          className="fixed pointer-events-none z-50 opacity-90"
          style={{ left: touchGhost.x - 16, top: touchGhost.y - 16 }}
          dangerouslySetInnerHTML={{ __html: touchGhost.type === 'folder' ? FOLDER_SVG : DECK_SVG }}
        />
      )}
    </div>
  )
}
