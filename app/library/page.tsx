'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseDeckRepository }   from '@/lib/data/decks'
import { SupabaseCardRepository }      from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { descendantDeckIds, computeDeckCounts, folderMatchesPair, type FolderCounts } from '@/lib/folderStats'

const EMPTY_COUNTS: FolderCounts = { unlearned: 0, learning: 0, graduated: 0, dueNow: 0 }
import { LanguageCombobox } from '@/components/LanguageCombobox'
import { langName, langNativeName, langFlag } from '@/lib/languages'
import { FLAG_OPTIONS } from '@/lib/flagOptions'
import type { Folder, Deck, LanguagePair, Card, CardState } from '@/domain'

// ─── Types ────────────────────────────────────────────────────────────────────

type DragItem = { type: 'folder'; id: string } | { type: 'deck'; id: string }
type DropPos  = 'before' | 'into' | 'after'
type DropTarget = { id: string; pos: DropPos } | null

type FilterKey = 'new' | 'learning' | 'graduated' | 'due'

interface DeckStats {
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

// A card grouped across all the decks it belongs to (a shared card can live
// in multiple decks within the same pairing)
interface GroupedCard {
  card:   Card
  state:  CardState | undefined
  status: string
  decks:  { id: string; name: string }[]
}

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

/** Reorder array: remove item at fromIdx, insert before/after toIdx. */
function reorder<T>(arr: T[], fromIdx: number, toIdx: number, pos: 'before' | 'after'): T[] {
  const next = [...arr]
  const item = next.splice(fromIdx, 1)[0] as T
  const insertAt = pos === 'before' ? toIdx : toIdx + 1
  const adjusted = fromIdx < insertAt ? insertAt - 1 : insertAt
  next.splice(adjusted, 0, item)
  return next
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LibraryPage() {
  return (
    <Suspense fallback={<div className="text-ink-muted pt-16 text-center">Loading…</div>}>
      <LibraryPageInner />
    </Suspense>
  )
}

function LibraryPageInner() {
  const searchParams = useSearchParams()
  const pairSource = searchParams.get('source')
  const pairTarget = searchParams.get('target')
  // Force a full remount whenever the active pairing changes (including
  // navigating back to the plain `/library` with no pairing at all). Without
  // this, clicking "← Library" only updates the URL's search params — the
  // already-mounted component doesn't reliably re-derive `inPair` and switch
  // views, so the click appears to do nothing.
  return (
    <LibraryPageBody
      key={`${pairSource ?? ''}|${pairTarget ?? ''}`}
      pairSource={pairSource}
      pairTarget={pairTarget}
    />
  )
}

function LibraryPageBody({ pairSource: initPairSource, pairTarget: initPairTarget }: { pairSource: string | null; pairTarget: string | null }) {
  const router = useRouter()
  const [pairSource, setPairSource] = useState(initPairSource)
  const [pairTarget, setPairTarget] = useState(initPairTarget)
  const inPair = !!(pairSource && pairTarget)

  // Sync with URL-driven navigation (browser back/forward, direct URL entry)
  useEffect(() => {
    setPairSource(initPairSource)
    setPairTarget(initPairTarget)
    setSearchQuery('')
  }, [initPairSource, initPairTarget])

  // Reset pair selection when the Navbar Library link is clicked while already
  // on the library page (same-pathname navigation doesn't reliably update
  // useSearchParams in Next.js 16, so the key-remount trick can't fire).
  useEffect(() => {
    const reset = () => { setPairSource(null); setPairTarget(null) }
    window.addEventListener('lexify:library-reset', reset)
    return () => window.removeEventListener('lexify:library-reset', reset)
  }, [])

  const [allFolders,   setAllFolders]   = useState<Folder[]>([])
  const [allDecks,     setAllDecks]     = useState<Deck[]>([])
  const [pairs,        setPairs]        = useState<LanguagePair[]>([])
  const [loading,      setLoading]      = useState(true)
  const [authed,       setAuthed]       = useState(false)
  const [userId,       setUserId]       = useState('')
  const [addingFolder,   setAddingFolder]   = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newName,        setNewName]        = useState('')
  const [folderCounts, setFolderCounts] = useState<Record<string, FolderCounts>>({})
  const [pairCounts,   setPairCounts]   = useState<FolderCounts>(EMPTY_COUNTS)
  const [pairDeckStats, setPairDeckStats] = useState<DeckStats[]>([])
  const [activeFilter,  setActiveFilter]  = useState<FilterKey | null>(null)
  const [searchQuery,   setSearchQuery]   = useState('')
  // Flat card list for root-page card search (loaded lazily on first query)
  const [allCardsFlat,  setAllCardsFlat]  = useState<{ card: Card; deck: Deck }[]>([])
  const [cardsLoaded,   setCardsLoaded]   = useState(false)

  // "+ New language" form
  const [addingPair,    setAddingPair]    = useState(false)
  const [newPairSource, setNewPairSource] = useState('')
  const [newPairTarget, setNewPairTarget] = useState('')
  const [newPairFlag,   setNewPairFlag]   = useState('')
  const [showNewPairFlagPicker, setShowNewPairFlagPicker] = useState(false)

  // Flag editor for existing pairs
  const [editFlagFor, setEditFlagFor] = useState<string | null>(null)  // "src|tgt" key

  // Per-pair settings panel (instructions)
  const [pairSettingsFor,  setPairSettingsFor]  = useState<string | null>(null)  // "src|tgt" key
  const [pairInstructions, setPairInstructions] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)

  // Drag state (folder/deck tree — only active in the inPair view)
  const [dragging,    setDragging]    = useState<DragItem | null>(null)
  const [dropTarget,  setDropTarget]  = useState<DropTarget>(null)

  // Drag state for the language-pair grid (only active in the !inPair view)
  const [pairOrder,      setPairOrder]      = useState<string[] | null>(null)
  const [draggingPairKey, setDraggingPairKey] = useState<string | null>(null)
  const [pairDropTarget,  setPairDropTarget]  = useState<{ key: string; pos: 'before' | 'after' } | null>(null)
  const draggingPairKeyRef = useRef<string | null>(null)
  const pairDropPosRef     = useRef<'before' | 'after'>('before')

  // Touch drag state
  const [touchGhost,   setTouchGhost]  = useState<{ x: number; y: number; type: 'folder' | 'deck' } | null>(null)
  const draggingRef    = useRef<DragItem | null>(null)
  const dropTargetRef  = useRef<DropTarget>(null)
  const commitDropRef  = useRef(commitDrop)
  const touchTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    const pairRepo   = new SupabaseLanguagePairRepository()
    const [folders, decks, pairsData] = await Promise.all([
      folderRepo.list(session.user.id),
      deckRepo.list(session.user.id),
      pairRepo.list(session.user.id),
    ])
    setAllFolders(folders)
    setAllDecks(decks)
    setPairs(pairsData)
    setLoading(false)

    // Aggregate stats for each root folder (including its subfolders). When
    // viewing a specific language pairing, only count decks matching that
    // pairing's direction.
    const cardRepo  = new SupabaseCardRepository()
    const stateRepo = new SupabaseCardStateRepository()
    const rootFolders = folders.filter(f => f.parentId === null)
    const deckById = new Map(decks.map(d => [d.id, d]))
    const entries = await Promise.all(rootFolders.map(async folder => {
      let deckIds = descendantDeckIds(folder.id, folders, decks)
      if (pairSource && pairTarget) {
        deckIds = deckIds.filter(id => {
          const d = deckById.get(id)
          return d && d.sourceLanguage === pairSource && d.targetLanguage === pairTarget
        })
      }
      const counts = await computeDeckCounts(deckIds, session.user.id, cardRepo, stateRepo)
      return [folder.id, counts] as const
    }))
    setFolderCounts(Object.fromEntries(entries))

    // Pairing-wide totals (every deck in this language pairing, regardless
    // of which folder it lives in).
    if (pairSource && pairTarget) {
      const pairDecks = decks.filter(d => d.sourceLanguage === pairSource && d.targetLanguage === pairTarget)
      const stats = await Promise.all(pairDecks.map(async deck => {
        const [cards, states] = await Promise.all([
          cardRepo.listByDeck(deck.id),
          stateRepo.listByDeck(session.user.id, deck.id),
        ])
        return { deck, cards, states }
      }))
      setPairDeckStats(stats)

      // A shared card can belong to more than one deck — dedupe by card id
      // so each unique card is only counted once across the whole pairing.
      const uniqueCards = new Map<string, { card: Card; state: CardState | undefined }>()
      for (const { cards, states } of stats) {
        const stateMap = new Map(states.map(s => [s.cardId, s]))
        for (const card of cards) {
          if (!uniqueCards.has(card.id)) {
            uniqueCards.set(card.id, { card, state: stateMap.get(card.id) })
          }
        }
      }

      const now = new Date()
      const counts = { ...EMPTY_COUNTS }
      for (const { state } of uniqueCards.values()) {
        if (!state) {
          counts.unlearned++
        } else if (state.graduated) {
          counts.graduated++
          if (state.dueAt && new Date(state.dueAt) <= now) counts.dueNow++
        } else {
          counts.learning++
        }
      }
      setPairCounts(counts)
    } else {
      setPairDeckStats([])
      setPairCounts(EMPTY_COUNTS)
    }
  }

  useEffect(() => { load() }, [pairSource, pairTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  // Lazily load all cards for root-page card search (only when a query is typed and not yet loaded)
  useEffect(() => {
    if (!searchQuery.trim() || cardsLoaded || allDecks.length === 0 || !userId) return
    const cardRepo = new SupabaseCardRepository()
    Promise.all(allDecks.map(async deck => {
      const cards = await cardRepo.listByDeck(deck.id)
      return cards.map(card => ({ card, deck }))
    })).then(results => {
      setAllCardsFlat(results.flat())
      setCardsLoaded(true)
    }).catch(console.error)
  }, [searchQuery, cardsLoaded, allDecks.length, userId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Visible root items (filtered to the active pairing, if any) ───────────

  function getVisibleRoots() {
    const rootFolders = allFolders.filter(f => f.parentId === null)
    const rootDecks   = allDecks.filter(d => !d.folderId)
    if (!inPair) return { rootFolders, rootDecks }
    return {
      rootFolders: rootFolders.filter(f => {
        if (f.isSynced) {
          // Synced folders must only appear in the language pair they contain.
          // Skip the normal "empty = show everywhere" shortcut — an empty
          // synced root from another language would otherwise bleed into
          // every pair's library view.
          const dIds = descendantDeckIds(f.id, allFolders, allDecks)
          return allDecks.some(d => dIds.includes(d.id) && d.sourceLanguage === pairSource && d.targetLanguage === pairTarget)
        }
        return folderMatchesPair(f.id, allFolders, allDecks, pairSource!, pairTarget!)
      }),
      rootDecks:   rootDecks.filter(d => d.sourceLanguage === pairSource && d.targetLanguage === pairTarget),
    }
  }

  // ── Drop handling ──────────────────────────────────────────────────────────

  async function commitDrop(target: DropTarget) {
    if (!dragging || !target) return
    const folderRepo = new SupabaseFolderRepository()
    const deckRepo   = new SupabaseDeckRepository()

    const { rootFolders, rootDecks } = getVisibleRoots()

    if (target.pos === 'into') {
      // Move INTO a folder
      if (dragging.type === 'folder' && dragging.id !== target.id) {
        await folderRepo.updateParent(dragging.id, target.id)
      } else if (dragging.type === 'deck') {
        await deckRepo.update(dragging.id, { folderId: target.id })
      }
    } else {
      // Reorder within root
      if (dragging.type === 'folder') {
        const fromIdx = rootFolders.findIndex(f => f.id === dragging.id)
        const toIdx   = rootFolders.findIndex(f => f.id === target.id)
        if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
          const reordered = reorder(rootFolders, fromIdx, toIdx, target.pos)
          await folderRepo.updatePositions(reordered.map((f, i) => ({ id: f.id, position: i })))
        }
      } else {
        // Deck dropped on folder row → move into that folder
        if (allFolders.some(f => f.id === target.id)) {
          await deckRepo.update(dragging.id, { folderId: target.id })
        } else {
          // Deck dropped on deck row → reorder decks
          const fromIdx = rootDecks.findIndex(d => d.id === dragging.id)
          const toIdx   = rootDecks.findIndex(d => d.id === target.id)
          if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
            const reordered = reorder(rootDecks, fromIdx, toIdx, target.pos)
            await deckRepo.updatePositions(reordered.map((d, i) => ({ id: d.id, position: i })))
          }
        }
      }
    }

    setDragging(null)
    setDropTarget(null)
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
    if (!name || !userId || creatingFolder) return
    if (name.toUpperCase() === 'SYNCED VOCABULARY') {
      alert('"SYNCED VOCABULARY" is reserved for automatically synced cards.')
      return
    }
    setCreatingFolder(true)
    try {
      const folderRepo = new SupabaseFolderRepository()
      const languagePair = inPair && pairSource && pairTarget
        ? { sourceLanguage: pairSource, targetLanguage: pairTarget }
        : undefined
      await folderRepo.create(userId, name, null, languagePair)
      setNewName('')
      setAddingFolder(false)
      load()
    } finally {
      setCreatingFolder(false)
    }
  }

  async function handlePin(deckId: string, pinned: boolean) {
    const deckRepo = new SupabaseDeckRepository()
    await deckRepo.update(deckId, { isPinned: pinned })
    load()
  }

  async function handleAddPair() {
    if (!newPairSource || !newPairTarget || !userId) return
    const pairRepo = new SupabaseLanguagePairRepository()
    await pairRepo.create(userId, newPairSource, newPairTarget, newPairFlag || undefined)
    setNewPairSource('')
    setNewPairTarget('')
    setNewPairFlag('')
    setShowNewPairFlagPicker(false)
    setAddingPair(false)
    load()
  }

  async function handleChangePairFlag(pairKey: string, flag: string) {
    const [src, tgt] = pairKey.split('|') as [string, string]
    const pairRepo = new SupabaseLanguagePairRepository()
    await pairRepo.updateFlag(src, tgt, flag)
    setPairs(prev => prev.map(p =>
      p.sourceLanguage === src && p.targetLanguage === tgt ? { ...p, flag } : p
    ))
    setEditFlagFor(null)
  }

  async function handleSaveInstructions() {
    if (!pairSettingsFor) return
    const [src, tgt] = pairSettingsFor.split('|') as [string, string]
    setSavingInstructions(true)
    try {
      const pairRepo = new SupabaseLanguagePairRepository()
      const trimmed = pairInstructions.trim() || null
      await pairRepo.updateInstructions(src, tgt, trimmed)
      setPairs(prev => prev.map(p =>
        p.sourceLanguage === src && p.targetLanguage === tgt ? { ...p, instructions: trimmed } : p
      ))
      setPairSettingsFor(null)
    } finally {
      setSavingInstructions(false)
    }
  }

  async function handleDeletePair() {
    if (!pairSource || !pairTarget) return
    const confirmed = confirm(
      `Delete ${langName(pairSource)} / ${langName(pairTarget)}?\n\nThis will permanently delete ALL cards and folders in this language pairing, along with their progress. This cannot be undone.`
    )
    if (!confirmed) return

    // Folders shown in this pairing's view (and all their subfolders) get
    // deleted along with the pairing — same as the decks inside them.
    const { rootFolders } = getVisibleRoots()
    const folderIdsToDelete = new Set<string>()
    for (const folder of rootFolders) {
      folderIdsToDelete.add(folder.id)
      const queue = [folder.id]
      while (queue.length > 0) {
        const current = queue.shift()!
        for (const f of allFolders) {
          if (f.parentId === current && !folderIdsToDelete.has(f.id)) {
            folderIdsToDelete.add(f.id)
            queue.push(f.id)
          }
        }
      }
    }

    const pairRepo   = new SupabaseLanguagePairRepository()
    const folderRepo = new SupabaseFolderRepository()
    try {
      await pairRepo.deletePair(pairSource, pairTarget)
      await Promise.all([...folderIdsToDelete].map(id => folderRepo.softDelete(id)))
    } catch (err) {
      alert(`Couldn't delete this language pairing: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    router.push('/library')
  }

  // ── Language-pair grid helpers ─────────────────────────────────────────────

  function getAllPairs(): LanguagePair[] {
    const seen = new Set<string>()
    const result: LanguagePair[] = []
    for (const p of pairs) {
      const key = `${p.sourceLanguage}|${p.targetLanguage}`
      if (!seen.has(key)) { seen.add(key); result.push(p) }
    }
    for (const d of allDecks) {
      const key = `${d.sourceLanguage}|${d.targetLanguage}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push({ id: key, ownerId: userId, sourceLanguage: d.sourceLanguage, targetLanguage: d.targetLanguage, position: Number.MAX_SAFE_INTEGER, flag: null, instructions: null, createdAt: '' })
      }
    }
    if (pairOrder) {
      result.sort((a, b) => {
        const ak = `${a.sourceLanguage}|${a.targetLanguage}`
        const bk = `${b.sourceLanguage}|${b.targetLanguage}`
        const ai = pairOrder.indexOf(ak)
        const bi = pairOrder.indexOf(bk)
        return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi)
      })
    }
    return result
  }

  function applyPairDragImage(e: React.DragEvent, pairFlag: string) {
    const ghost = document.createElement('div')
    ghost.textContent = pairFlag
    ghost.style.cssText = 'font-size:52px;line-height:1;position:fixed;top:-200px;left:-200px;pointer-events:none'
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 30, 30)
    setTimeout(() => document.body.removeChild(ghost), 0)
  }

  async function commitPairDrop(fromKey: string, toKey: string, pos: 'before' | 'after') {
    const current = getAllPairs()
    const keys = current.map(p => `${p.sourceLanguage}|${p.targetLanguage}`)
    const fromIdx = keys.indexOf(fromKey)
    const toIdx   = keys.indexOf(toKey)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return

    const newKeys = reorder(keys, fromIdx, toIdx, pos)
    setPairOrder(newKeys)

    const pairRepo = new SupabaseLanguagePairRepository()
    await pairRepo.updatePositions(newKeys.map((k, i) => {
      const [sourceLanguage, targetLanguage] = k.split('|') as [string, string]
      return { sourceLanguage, targetLanguage, position: i }
    }))
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  if (!authed) return (
    <div className="panel text-center space-y-4 py-12 max-w-2xl mx-auto">
      <p className="text-ink-muted">Sign in to access your Library.</p>
      <Link href="/auth" className="btn-primary inline-block">Sign in</Link>
    </div>
  )

  // ── Pairing "boxes" view (root, no pairing selected) ───────────────────────

  if (!inPair) {
    const allPairs = getAllPairs()
    const q = searchQuery.trim().toLowerCase()

    // Card search results (all decks, lazy-loaded)
    const rootCardResults = q
      ? allCardsFlat.filter(({ card }) =>
          card.front.toLowerCase().includes(q) || card.back.toLowerCase().includes(q)
        )
      : []

    const activePairFlag = (p: LanguagePair) => p.flag || langFlag(p.sourceLanguage)

    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-ink">Library</h1>
          <button
            onClick={() => { setAddingPair(true); setNewPairSource(''); setNewPairTarget(''); setNewPairFlag(''); setShowNewPairFlagPicker(false) }}
            className="text-sm text-accent hover:text-accent-soft transition-colors"
          >
            + New language
          </button>
        </div>

        {allPairs.length > 0 && (
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              className="input pl-9 py-2 text-sm w-full"
              placeholder="Search cards…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        )}

        {addingPair && (
          <div className="panel space-y-3 py-3">
            <div className="grid grid-cols-2 gap-3">
              <LanguageCombobox label="Target language" value={newPairSource} onChange={v => { setNewPairSource(v); setNewPairFlag('') }} />
              <LanguageCombobox label="Basis language"  value={newPairTarget} onChange={setNewPairTarget} />
            </div>
            {newPairSource && (
              <div className="relative">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-muted">Flag:</span>
                  <button
                    onClick={() => setShowNewPairFlagPicker(v => !v)}
                    className="text-2xl hover:bg-white/10 rounded p-1 transition-colors leading-none"
                    title="Choose flag"
                  >
                    {newPairFlag || langFlag(newPairSource)}
                  </button>
                  {newPairFlag && (
                    <button onClick={() => setNewPairFlag('')} className="text-xs text-ink-faint hover:text-ink transition-colors">Reset</button>
                  )}
                </div>
                {showNewPairFlagPicker && (
                  <div className="absolute left-0 top-10 z-30 bg-surface border border-white/10 rounded-lg p-3 shadow-xl w-72">
                    <div className="grid grid-cols-8 gap-0.5 max-h-48 overflow-y-auto">
                      {FLAG_OPTIONS.map(({ flag, name }) => (
                        <button
                          key={flag}
                          onClick={() => { setNewPairFlag(flag); setShowNewPairFlagPicker(false) }}
                          className="text-xl hover:bg-white/10 rounded p-1 transition-colors leading-none"
                          title={name}
                        >
                          {flag}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button onClick={handleAddPair} className="btn-primary text-xs py-1 px-3" disabled={!newPairSource || !newPairTarget}>Create</button>
              <button onClick={() => { setAddingPair(false); setShowNewPairFlagPicker(false) }} className="text-ink-faint hover:text-ink text-xs transition-colors">Cancel</button>
            </div>
          </div>
        )}

        {q ? (
          // ── Card search results ─────────────────────────────────────────
          !cardsLoaded ? (
            <div className="panel text-ink-muted text-sm text-center py-6">Searching…</div>
          ) : rootCardResults.length === 0 ? (
            <div className="panel text-ink-muted text-sm text-center py-10">
              No cards match &ldquo;{searchQuery}&rdquo;.
            </div>
          ) : (
            <div className="panel divide-y divide-white/5 p-0 overflow-hidden">
              {rootCardResults.map(({ card, deck }) => (
                <Link
                  key={`${card.id}-${deck.id}`}
                  href={`/study/${deck.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-surface-raised/50 transition-colors"
                >
                  <div className="flex gap-6 text-sm min-w-0">
                    <span className="text-ink font-medium w-36 truncate shrink-0">{card.front}</span>
                    <span className="text-ink-muted truncate">{card.back}</span>
                  </div>
                  <span className="text-xs text-ink-faint shrink-0 ml-2 hidden sm:block">
                    {langNativeName(deck.sourceLanguage)} / {langNativeName(deck.targetLanguage)} · {deck.name}
                  </span>
                </Link>
              ))}
            </div>
          )
        ) : allPairs.length === 0 && !addingPair ? (
          <div className="panel text-ink-muted text-sm text-center py-10">
            No languages yet. Press &quot;+ New language&quot; to start a new vocabulary collection.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {allPairs.map(p => {
              const key        = `${p.sourceLanguage}|${p.targetLanguage}`
              const isDragging = draggingPairKey === key
              const pdt        = pairDropTarget?.key === key ? pairDropTarget : null
              const flag       = activePairFlag(p)
              return (
                <div
                  key={key}
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.effectAllowed = 'move'
                    applyPairDragImage(e, flag)
                    draggingPairKeyRef.current = key
                    setDraggingPairKey(key)
                  }}
                  onDragOver={e => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (!draggingPairKeyRef.current || draggingPairKeyRef.current === key) return
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    const pos: 'before' | 'after' = (e.clientX - rect.left) / rect.width < 0.5 ? 'before' : 'after'
                    pairDropPosRef.current = pos
                    setPairDropTarget({ key, pos })
                  }}
                  onDragLeave={e => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setPairDropTarget(t => t?.key === key ? null : t)
                    }
                  }}
                  onDragEnd={() => {
                    draggingPairKeyRef.current = null
                    setDraggingPairKey(null)
                    setPairDropTarget(null)
                  }}
                  onDrop={e => {
                    e.preventDefault()
                    const fromKey = draggingPairKeyRef.current
                    const pos     = pairDropPosRef.current
                    draggingPairKeyRef.current = null
                    setDraggingPairKey(null)
                    setPairDropTarget(null)
                    if (fromKey && fromKey !== key) commitPairDrop(fromKey, key, pos)
                  }}
                  className={`panel flex flex-col items-center justify-center gap-1 py-6 text-center transition-all cursor-grab active:cursor-grabbing select-none relative group ${
                    isDragging ? 'opacity-40' : 'hover:bg-surface-raised/50'
                  } ${pdt?.pos === 'before' ? 'border-l-2 border-l-accent' : pdt?.pos === 'after' ? 'border-r-2 border-r-accent' : ''}`}
                >
                  {/* Gear icon — pair settings */}
                  <button
                    className="absolute top-0 right-0 w-10 h-10 flex items-center justify-center opacity-0 group-hover:opacity-100 text-ink-faint hover:text-ink transition-opacity text-2xl leading-none"
                    onClick={e => {
                      e.stopPropagation(); e.preventDefault()
                      setPairInstructions(p.instructions ?? '')
                      setPairSettingsFor(key)
                    }}
                    title="Pair settings"
                    draggable={false}
                  >
                    ⚙
                  </button>
                  {/* Flag — click to change */}
                  <div className="relative group/flag mb-1">
                    <span className="text-2xl leading-none">{flag}</span>
                    <button
                      className="absolute inset-0 opacity-0 group-hover/flag:opacity-100 bg-black/50 rounded text-white text-xs flex items-center justify-center transition-opacity"
                      onClick={e => { e.stopPropagation(); e.preventDefault(); setEditFlagFor(key) }}
                      title="Change flag"
                    >
                      ✎
                    </button>
                  </div>
                  <Link
                    href={`/library?source=${p.sourceLanguage}&target=${p.targetLanguage}`}
                    draggable={false}
                    onClick={e => {
                      if (draggingPairKeyRef.current) { e.preventDefault(); return }
                      setPairSource(p.sourceLanguage)
                      setPairTarget(p.targetLanguage)
                    }}
                    className="flex flex-col items-center gap-0.5 w-full"
                  >
                    <span className="text-sm font-semibold text-ink">{langNativeName(p.sourceLanguage)}</span>
                    <span className="text-xs text-ink-muted">{langNativeName(p.targetLanguage)}</span>
                  </Link>
                </div>
              )
            })}
          </div>
        )}

        {/* Flag picker modal for existing pairs */}
        {editFlagFor && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            onClick={() => setEditFlagFor(null)}
          >
            <div className="panel p-4 max-w-xs w-full mx-4" onClick={e => e.stopPropagation()}>
              <p className="text-sm font-medium text-ink mb-3">Choose flag</p>
              <div className="grid grid-cols-8 gap-0.5 max-h-56 overflow-y-auto">
                {FLAG_OPTIONS.map(({ flag: f, name }) => (
                  <button
                    key={f}
                    onClick={() => handleChangePairFlag(editFlagFor, f)}
                    className="text-xl hover:bg-white/10 rounded p-1 transition-colors leading-none"
                    title={name}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <button onClick={() => setEditFlagFor(null)} className="mt-3 text-xs text-ink-faint hover:text-ink transition-colors">Cancel</button>
            </div>
          </div>
        )}

        {/* Pair settings modal */}
        {pairSettingsFor && (() => {
          const [src, tgt] = pairSettingsFor.split('|') as [string, string]
          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
              onClick={() => setPairSettingsFor(null)}
            >
              <div className="panel p-5 max-w-sm w-full mx-4 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-ink">{langNativeName(src)} / {langNativeName(tgt)} — Settings</h3>
                  <button onClick={() => setPairSettingsFor(null)} className="text-ink-faint hover:text-ink text-lg leading-none">✕</button>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-ink-muted uppercase tracking-wide">AI Instructions</label>
                  <p className="text-xs text-ink-faint">Default formatting rules used by the word-list agent and language syncing when no custom prompt is provided (e.g. &quot;use infinitive form for verbs&quot;).</p>
                  <textarea
                    className="input w-full text-sm resize-none"
                    rows={5}
                    maxLength={2000}
                    placeholder="e.g. Use infinitive form for verbs. Use masculine nominative singular for nouns."
                    value={pairInstructions}
                    onChange={e => setPairInstructions(e.target.value)}
                  />
                  <span className="text-xs text-ink-faint text-right">{pairInstructions.length} / 2000</span>
                </div>
                <div className="flex justify-end gap-3">
                  <button onClick={() => setPairSettingsFor(null)} className="text-sm text-ink-muted hover:text-ink transition-colors">Cancel</button>
                  <button
                    onClick={handleSaveInstructions}
                    disabled={savingInstructions}
                    className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50"
                  >
                    {savingInstructions ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    )
  }

  // ── Folder-tree view, filtered to the active pairing ───────────────────────

  const { rootFolders, rootDecks } = getVisibleRoots()
  const hasContent = rootFolders.length > 0 || rootDecks.length > 0

  // Flat card search results across all decks in this pairing
  const pairSearchQuery = searchQuery.trim().toLowerCase()
  const pairCardResults: { card: Card; deckId: string; deckName: string }[] = pairSearchQuery
    ? pairDeckStats.flatMap(({ deck, cards }) =>
        cards
          .filter(c => c.front.toLowerCase().includes(pairSearchQuery) || c.back.toLowerCase().includes(pairSearchQuery))
          .map(c => ({ card: c, deckId: deck.id, deckName: deck.name }))
      )
    : []

  // Build the filtered card list across the whole pairing
  const now = new Date()
  const filteredCards: FilteredCard[] = activeFilter ? pairDeckStats.flatMap(({ deck, cards, states }) => {
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

  // A shared card can appear in multiple decks — collapse those into a
  // single row listing every deck it belongs to.
  const groupedCards: GroupedCard[] = (() => {
    const map = new Map<string, GroupedCard>()
    for (const { card, state, deckName, deckId, status } of filteredCards) {
      const existing = map.get(card.id)
      if (existing) {
        existing.decks.push({ id: deckId, name: deckName })
      } else {
        map.set(card.id, { card, state, status, decks: [{ id: deckId, name: deckName }] })
      }
    }
    return [...map.values()]
  })()

  const PAIR_COUNTER_CONFIG = [
    { key: 'new'       as FilterKey, label: 'Unlearned', value: pairCounts.unlearned, color: 'text-ink-muted',   border: 'border-ink-faint', desc: 'Not yet started'  },
    { key: 'learning'  as FilterKey, label: 'Learning',  value: pairCounts.learning,  color: 'text-warning',     border: 'border-warning',   desc: 'In pipeline'      },
    { key: 'graduated' as FilterKey, label: 'Graduated', value: pairCounts.graduated, color: 'text-success',     border: 'border-success',   desc: 'Long-term review' },
    { key: 'due'       as FilterKey, label: 'Due Now',   value: pairCounts.dueNow,    color: 'text-accent-soft', border: 'border-accent',    desc: 'Ready to review'  },
  ]

  return (
    <div
      className="space-y-5"
      onDragEnd={() => { setDragging(null); setDropTarget(null) }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <button
            onClick={() => { setPairSource(null); setPairTarget(null); router.push('/library') }}
            className="text-xs text-ink-muted hover:text-ink transition-colors"
          >← Library</button>
          <h1 className="text-2xl font-semibold text-ink">
            {langName(pairSource!)} <span className="text-ink-faint text-base font-normal">/ {langName(pairTarget!)}</span>
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => { setAddingFolder(true); setNewName('') }}
            className="text-sm text-accent hover:text-accent-soft transition-colors"
          >
            + New folder
          </button>
          <button
            onClick={handleDeletePair}
            className="text-sm text-danger hover:text-danger/80 transition-colors"
          >
            Delete language
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          className="input pl-9 py-2 text-sm w-full"
          placeholder="Search cards…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Pairing-wide stat counters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {PAIR_COUNTER_CONFIG.map(({ key, label, value, color, border, desc }) => {
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
              <div className="text-xs text-ink-faint">{desc}</div>
            </button>
          )
        })}
      </div>

      {/* Filtered card list (cross-deck, whole pairing) */}
      {activeFilter && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">
              {PAIR_COUNTER_CONFIG.find(c => c.key === activeFilter)?.label} — {groupedCards.length} card{groupedCards.length !== 1 ? 's' : ''}
            </h2>
            <button onClick={() => setActiveFilter(null)} className="text-xs text-accent hover:text-accent-soft transition-colors">
              Show all ✕
            </button>
          </div>

          {(() => {
            const cfg = PAIR_COUNTER_CONFIG.find(c => c.key === activeFilter)
            return cfg && cfg.value > 0 ? (
              <Link
                href={`/study/all/session?category=${activeFilter}`}
                className="btn-primary block w-full text-center"
              >
                Study {cfg.label}
              </Link>
            ) : null
          })()}

          {groupedCards.length === 0 ? (
            <div className="panel text-ink-muted text-sm text-center py-6">No cards in this category.</div>
          ) : (
            <div className="panel divide-y divide-white/5 p-0 overflow-hidden">
              {groupedCards.map(({ card, decks, status }) => (
                <Link
                  key={card.id}
                  href={`/study/${decks[0]?.id ?? ''}?filter=${activeFilter}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-surface-raised/50 transition-colors"
                >
                  <div className="flex gap-6 text-sm min-w-0">
                    <span className="text-ink font-medium w-36 truncate shrink-0">{card.front}</span>
                    <span className="text-ink-muted truncate">{card.back}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-2">
                    <span className="text-xs text-ink-faint hidden sm:block truncate max-w-xs">
                      {decks.map(d => d.name).join(', ')}
                    </span>
                    <span className="chip">{status}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
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
          <button onClick={handleAddFolder} disabled={creatingFolder} className="btn-primary text-xs py-1 px-3 disabled:opacity-50">{creatingFolder ? 'Creating…' : 'Create'}</button>
          <button onClick={() => setAddingFolder(false)} className="text-ink-faint hover:text-ink text-xs transition-colors">Cancel</button>
        </div>
      )}

      {pairSearchQuery ? (
        // ── Card search results ──────────────────────────────────────────────
        pairCardResults.length === 0 ? (
          <div className="panel text-ink-muted text-sm text-center py-10">
            No cards match &ldquo;{searchQuery}&rdquo;.
          </div>
        ) : (
          <div className="panel divide-y divide-white/5 p-0 overflow-hidden">
            {pairCardResults.map(({ card, deckId, deckName }) => (
              <Link
                key={`${card.id}-${deckId}`}
                href={`/study/${deckId}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-surface-raised/50 transition-colors"
              >
                <div className="flex gap-6 text-sm min-w-0">
                  <span className="text-ink font-medium w-36 truncate shrink-0">{card.front}</span>
                  <span className="text-ink-muted truncate">{card.back}</span>
                </div>
                <span className="text-xs text-ink-faint shrink-0 ml-2 hidden sm:block">{deckName}</span>
              </Link>
            ))}
          </div>
        )
      ) : !hasContent && !addingFolder ? (
        <div className="panel text-ink-muted text-sm text-center py-10">
          Nothing here yet. Create a folder or move decks here from Study.
        </div>
      ) : (
        <div className="space-y-0">
          {/* Root folders */}
          {rootFolders.map(folder => {
            const dt            = dropTarget?.id === folder.id ? dropTarget : null
            const isDragging    = dragging?.type === 'folder' && dragging.id === folder.id

            return (
              <div key={folder.id} className="relative">
                {/* Insert line ABOVE */}
                {dt?.pos === 'before' && (
                  <div className="absolute top-0 left-0 right-0 h-0.5 bg-accent rounded-full z-10 -translate-y-0.5" />
                )}

                <div
                  draggable
                  data-drag-id={folder.id}
                  data-drag-type="folder"
                  onDragStart={e => { applyDragImage(e, 'folder'); setDragging({ type: 'folder', id: folder.id }) }}
                  onDragOver={e => {
                    e.preventDefault()
                    if (dragging?.id === folder.id) return
                    setDropTarget({ id: folder.id, pos: getDropPos(e, true) })
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={e => { e.preventDefault(); commitDrop({ id: folder.id, pos: dropTarget?.pos ?? 'after' }) }}
                  onTouchStart={e => onItemTouchStart(e, { type: 'folder', id: folder.id })}
                  onTouchMove={onItemTouchMove}
                  style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
                  className={`panel flex items-center gap-3 py-3 my-0.5 transition-all cursor-grab active:cursor-grabbing select-none ${
                    isDragging  ? 'opacity-40' :
                    dt?.pos === 'into' ? 'border-accent bg-accent/5 scale-[1.01]' :
                    'hover:border-white/10'
                  }`}
                >
                  <FolderIcon />
                  <Link
                    href={`/library/${folder.id}?source=${pairSource}&target=${pairTarget}`}
                    className="flex-1 min-w-0"
                    onClick={e => { if (dragging) e.preventDefault() }}
                  >
                    <div className="text-sm font-medium text-ink truncate">{folder.name}</div>
                  </Link>
                  {(() => {
                    const c = folderCounts[folder.id]
                    if (!c || (c.unlearned + c.learning + c.graduated) === 0) return null
                    return (
                      <div className="hidden sm:flex items-center gap-3 text-xs shrink-0">
                        <span className="text-ink-muted">{c.unlearned} new</span>
                        <span className="text-warning">{c.learning} learning</span>
                        <span className="text-success">{c.graduated} done</span>
                        <span className="text-accent-soft">{c.dueNow} due</span>
                      </div>
                    )
                  })()}
                </div>

                {/* Insert line BELOW */}
                {dt?.pos === 'after' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-full z-10 translate-y-0.5" />
                )}
              </div>
            )
          })}

          {/* Root-level decks */}
          {rootDecks.map(deck => {
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
