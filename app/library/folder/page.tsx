'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { routes } from '@/lib/routes'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseDeckRepository }   from '@/lib/data/decks'
import { SupabaseCardRepository }      from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseCardOnboardingRepository } from '@/lib/data/cardOnboarding'
import { descendantDeckIds, loadLibraryBulk, computeDeckCounts, folderMatchesPair, type FolderCounts } from '@/lib/folderStats'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { climbInProgress } from '@/lib/climbProgress'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildEnabledTracksMap, type EnabledTracks } from '@/lib/sessionLimits'
import { isCardStateDueNow } from '@/lib/dueStatus'
import { getToday } from '@/lib/dates'
import { langName } from '@/lib/languages'
import { StarFilterButton } from '@/components/StarFilterButton'
import { CardBulkPanel } from '@/components/CardBulkPanel'
import type { Folder, Deck, Card, CardState } from '@/domain'

type FilterKey = 'new' | 'learning' | 'graduated' | 'due' | 'dormant' | 'starred'

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
  const router   = useRouter()
  const searchParams = useSearchParams()
  const folderId = searchParams.get('folder') ?? ''

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
  const [addingFolder,   setAddingFolder]   = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newName,        setNewName]        = useState('')
  const [renaming,     setRenaming]     = useState(false)
  const [renameValue,  setRenameValue]  = useState('')
  // Folder settings gear (header) + folder-level vocabulary onboarding
  const [settingsOpen,    setSettingsOpen]    = useState(false)
  const [queueingOnboard, setQueueingOnboard] = useState(false)
  const [onboardError,    setOnboardError]    = useState<string | null>(null)
  const [pendingOnboard,  setPendingOnboard]  = useState(0)
  /** Every card with an onboarding row, rated or not — band 1 ("don't know") writes no card state,
   *  so without this set an idk-rated card would look onboardable again. */
  const [onboardedIds,    setOnboardedIds]    = useState<Set<string>>(new Set())
  const [counts,       setCounts]       = useState<FolderCounts | null>(null)
  const [subfolderCounts, setSubfolderCounts] = useState<Record<string, FolderCounts>>({})
  const [deckCounts,      setDeckCounts]      = useState<Record<string, FolderCounts>>({})
  // Due-now context (enabled tracks per pair + tz + turnover-adjusted today) so counts match the
  // dashboard/session via the shared helper. Set in load(), read by both countDeck and the card filter.
  const [dueCtx, setDueCtx] = useState<{ enabledByPair: Map<string, EnabledTracks>; tz: string; today: string } | null>(null)
  // Climb rows for every card in the folder — a pathway/ladder card mid-climb has NO card_states row
  // yet, so without these the counts here call it Unlearned while the deck page calls it Learning.
  const [climbMap, setClimbMap] = useState<Map<string, unknown>>(new Map())
  const [deckStats,    setDeckStats]    = useState<DeckWithCards[]>([])
  const [activeFilter, setActiveFilter] = useState<FilterKey | null>(null)
  const [searchQuery,  setSearchQuery]  = useState('')
  /** Selection inside the filtered card list, for the shared bulk-action panel. */
  const [selectedFilterIds, setSelectedFilterIds] = useState<Set<string>>(new Set())

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

    // Aggregate stats for every card in this folder (including subfolders).
    // When viewing in a language-pair context, only count decks for that pair.
    const deckIds = descendantDeckIds(folderId, folders, decksData)
    const cardRepo  = new SupabaseCardRepository()
    const stateRepo = new SupabaseCardStateRepository()
    const relevantDecks = decksData.filter(d => {
      if (!deckIds.includes(d.id)) return false
      if (pairSource && pairTarget) return d.sourceLanguage === pairSource && d.targetLanguage === pairTarget
      return true
    })

    const [stats, climb] = await Promise.all([
      Promise.all(relevantDecks.map(async deck => {
        const [cards, states] = await Promise.all([
          cardRepo.listByDeck(deck.id),
          stateRepo.listByDeck(session.user.id, deck.id),
        ])
        return { deck, cards, states }
      })),
      new SupabaseLadderClimbRepository().listAllForUser(session.user.id)
        .catch(() => new Map<string, unknown>()),
    ])
    setDeckStats(stats)
    setClimbMap(climb)

    // Due-now context: enabled tracks per pair + tz + turnover-adjusted today, so the count matches
    // the dashboard/session via the shared helper (lib/dueStatus.ts). Small extra fetches; cheap.
    const [profileRow, paramRows, onboardRows] = await Promise.all([
      Promise.resolve(supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', session.user.id).single())
        .then(r => r.data).catch(() => null),
      new SupabaseUserSchedulerParamsRepository().listForUser(session.user.id).catch(() => []),
      new SupabaseCardOnboardingRepository().listForDecks(session.user.id, relevantDecks.map(d => d.id)).catch(() => []),
    ])
    // Onboarding rows across this folder's decks: un-rated ones drive "Continue onboarding (N left)",
    // and the full card-id set keeps already-rated cards (incl. band-1 "don't know") out of the
    // onboardable count.
    setPendingOnboard(onboardRows.filter(r => r.band === null).length)
    setOnboardedIds(new Set(onboardRows.map(r => r.cardId)))
    const dTz = (profileRow?.timezone as string | null) ?? deviceTimeZone()
    const dToday = getToday(dTz, (profileRow?.day_turnover_hour as number | null) ?? 0)
    const enabledByPair = buildEnabledTracksMap(paramRows)
    setDueCtx({ enabledByPair, tz: dTz, today: dToday })

    // Counts a single deck's {cards, states}, anchored to the deck's current cards
    // so orphaned states (deleted/moved cards) don't inflate the totals — matches
    // the deck-detail page's `activeForwardStates` filter. Due Now via the shared helper.
    const countDeck = (deck: typeof stats[number]['deck'], cards: typeof stats[number]['cards'], states: typeof stats[number]['states']): FolderCounts => {
      const forwardStates = states.filter(s => s.reviewDirection !== 'reverse')
      const fwdMap = new Map(forwardStates.map(s => [s.cardId, s]))
      const activeCardIds = new Set(cards.map(cd => cd.id))
      const tracks = enabledByPair.get(`${deck.sourceLanguage}|${deck.targetLanguage}`)
      // The SAME statusOf rule as the deck page / lib/folderStats: a card mid-climb has no state row
      // until graduation, so classifying from card_states alone called it Unlearned here while the
      // deck page said Learning — the counts have to walk CARDS, with climbInProgress as a source.
      const statusOf = (cardId: string): 'graduated' | 'dormant' | 'learning' | 'new' => {
        const st = fwdMap.get(cardId)
        if (st?.dormant) return 'dormant'
        if (st?.graduated) return 'graduated'
        if (climbInProgress(climb.get(cardId)) || (st && !st.graduated)) return 'learning'
        return 'new'
      }
      return {
        unlearned: cards.filter(cd => statusOf(cd.id) === 'new').length,
        learning:  cards.filter(cd => statusOf(cd.id) === 'learning').length,
        graduated: cards.filter(cd => statusOf(cd.id) === 'graduated').length,
        dormant:   cards.filter(cd => statusOf(cd.id) === 'dormant').length,
        dueNow:    states.filter(s =>
          activeCardIds.has(s.cardId) &&
          isCardStateDueNow(s, { tracks, tz: dTz, today: dToday, forwardState: fwdMap.get(s.cardId) })
        ).length,
      }
    }

    setCounts(stats.reduce((acc, { deck, cards, states }) => {
      const c = countDeck(deck, cards, states)
      return {
        unlearned: acc.unlearned + c.unlearned,
        learning:  acc.learning  + c.learning,
        graduated: acc.graduated + c.graduated,
        dormant:   acc.dormant   + c.dormant,
        dueNow:    acc.dueNow    + c.dueNow,
      }
    }, { unlearned: 0, learning: 0, graduated: 0, dueNow: 0, dormant: 0 }))

    // Per-deck counts for the deck row summaries (derived from the states we just loaded).
    setDeckCounts(Object.fromEntries(stats.map(({ deck, cards, states }) =>
      [deck.id, countDeck(deck, cards, states)] as const
    )))

    // Per-subfolder counts for the subfolder row summaries. One bulk load shared across every
    // subfolder — otherwise each one fans out 3 queries per deck it contains.
    const subs = folders.filter(f => f.parentId === folderId)
    const bulk = subs.length > 0
      ? await loadLibraryBulk(session.user.id, decksData, cardRepo, stateRepo)
      : undefined
    const subEntries = await Promise.all(subs.map(async sf => {
      let dIds = descendantDeckIds(sf.id, folders, decksData)
      if (pairSource && pairTarget) {
        dIds = dIds.filter(id => {
          const dk = decksData.find(d => d.id === id)
          return !!dk && dk.sourceLanguage === pairSource && dk.targetLanguage === pairTarget
        })
      }
      const c = await computeDeckCounts(dIds, session.user.id, cardRepo, stateRepo, bulk)
      return [sf.id, c] as const
    }))
    setSubfolderCounts(Object.fromEntries(subEntries))
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
  const filteredCards: FilteredCard[] = activeFilter ? deckStats.flatMap(({ deck, cards, states }) => {
    const stateMap = new Map(states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]))
    const tracks = dueCtx?.enabledByPair.get(`${deck.sourceLanguage}|${deck.targetLanguage}`)
    // A card shows under "Due Now" if ANY of its rows (forward production/recall or reverse) is due —
    // via the shared helper, so this matches the stat-box count exactly.
    const cardIsDue = (cardId: string) => !!dueCtx && states.some(s =>
      s.cardId === cardId && isCardStateDueNow(s, { tracks, tz: dueCtx.tz, today: dueCtx.today, forwardState: stateMap.get(cardId) }))
    // Same climb-aware classification as the counts above, so clicking a stat box lists exactly the
    // cards it counted (a mid-climb card has no state row but is still Learning, not New).
    const inProgress = (cardId: string) => climbInProgress(climbMap.get(cardId))
    return cards
      .filter(card => {
        const s = stateMap.get(card.id)
        if (activeFilter === 'new')       return !s && !inProgress(card.id)
        if (activeFilter === 'learning')  return (s && !s.graduated && !s.dormant) || (!s && inProgress(card.id))
        if (activeFilter === 'graduated') return !!s?.graduated && !s.dormant
        if (activeFilter === 'dormant')   return !!s?.dormant
        if (activeFilter === 'due')       return cardIsDue(card.id)
        if (activeFilter === 'starred')   return !!card.starred
        return false
      })
      .map(card => {
        const s = stateMap.get(card.id)
        const status = !s ? (inProgress(card.id) ? 'Learning' : 'New')
          : s.dormant ? 'Dormant' : s.graduated ? 'Graduated' : `Step ${s.currentStepOrder + 1}`
        return { card, state: s, deckName: deck.name, deckId: deck.id, status }
      })
  }) : []

  const COUNTER_CONFIG = counts ? [
    { key: 'new'       as FilterKey, label: 'Unlearned', value: counts.unlearned, color: 'text-ink-muted',   border: 'border-ink-faint', desc: 'Not yet started'  },
    { key: 'learning'  as FilterKey, label: 'Learning',  value: counts.learning,  color: 'text-warning',     border: 'border-warning',   desc: 'In pipeline'      },
    { key: 'graduated' as FilterKey, label: 'Graduated', value: counts.graduated, color: 'text-success',     border: 'border-success',   desc: 'Long-term review' },
    { key: 'due'       as FilterKey, label: 'Due Now',   value: counts.dueNow,    color: 'text-accent-soft', border: 'border-accent',    desc: 'Ready to review'  },
    { key: 'dormant'   as FilterKey, label: 'Dormant',   value: counts.dormant,   color: 'text-ink',         border: 'border-line/70',  desc: 'Paused — manual'  },
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
      touchTimerRef.current = null
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

  // Finger lifted (or gesture cancelled) before the long-press fired → it was a tap,
  // not a drag. Cancel the pending drag so taps navigate normally.
  function onItemTouchEnd() {
    if (touchTimerRef.current) {
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
      alert('"SYNCED VOCABULARY" is a reserved name used by the sync system.')
      return
    }
    setCreatingFolder(true)
    try {
      const folderRepo = new SupabaseFolderRepository()
      await folderRepo.create(userId, name, folderId)
      setNewName('')
      setAddingFolder(false)
      load()
    } finally {
      setCreatingFolder(false)
    }
  }

  async function handleRenameFolder() {
    const name = renameValue.trim()
    if (!name || !folder || folder.isSynced) return
    if (name.toUpperCase() === 'SYNCED VOCABULARY') {
      alert('"SYNCED VOCABULARY" is a reserved name.')
      setRenaming(false)
      return
    }
    const folderRepo = new SupabaseFolderRepository()
    await folderRepo.rename(folderId, name)
    setRenaming(false)
    load()
  }

  async function handlePin(deckId: string, pinned: boolean) {
    const deckRepo = new SupabaseDeckRepository()
    await deckRepo.update(deckId, { isPinned: pinned })
    load()
  }

  async function handleMoveDeckToRoot(deckId: string) {
    const deckRepo = new SupabaseDeckRepository()
    await deckRepo.update(deckId, { folderId: null })
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

    router.push(parentId ? routes.library(parentId, { source: pairSource, target: pairTarget }) : '/library' + qs)
  }

  /**
   * Queues every never-studied card across this folder's decks (subfolders included; kept to the
   * active language pair when there is one) for confidence rating, then opens the rating screen in
   * folder scope — so onboarding a whole frequency-list tree doesn't mean visiting each deck.
   *
   * Cards that already carry an onboarding row are left alone, so this can't reset ratings you
   * already gave — same contract as the deck-level entry in DeckSettingsPanel.
   */
  async function startFolderOnboarding() {
    if (queueingOnboard) return
    setQueueingOnboard(true)
    setOnboardError(null)
    try {
      const repo = new SupabaseCardOnboardingRepository()
      const already = new Set((await repo.listForDecks(userId, deckStats.map(s => s.deck.id))).map(r => r.cardId))
      for (const { deck, cards, states } of deckStats) {
        const fwd = new Set(states.filter(s => s.reviewDirection !== 'reverse').map(s => s.cardId))
        const fresh = cards.filter(c => !fwd.has(c.id) && !already.has(c.id)).map(c => c.id)
        if (fresh.length > 0) await repo.createPending(userId, deck.id, fresh)
      }
      router.push(routes.folderOnboard(folderId, { source: pairSource, target: pairTarget }))
    } catch (err) {
      setOnboardError(err instanceof Error ? err.message : 'Could not start onboarding.')
      setQueueingOnboard(false)
    }
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

  // Never-studied, never-onboarded cards across the folder — what a fresh onboarding run would queue.
  // Derived from the stats we already load; 0 until they arrive (counts === null doubles as the
  // "still loading" flag). Excluding onboarded ids keeps band-1 ("don't know") ratings from being
  // offered again — they write no card state, so "never studied" alone would re-count them.
  const onboardableCount = deckStats.reduce((n, { cards, states }) => {
    const fwd = new Set(states.filter(s => s.reviewDirection !== 'reverse').map(s => s.cardId))
    return n + cards.filter(c => !fwd.has(c.id) && !onboardedIds.has(c.id)).length
  }, 0)

  const folderSearchQuery = searchQuery.trim().toLowerCase()
  // Card search across all decks in this folder (and subfolders)
  const folderCardResults: { card: Card; deckId: string; deckName: string }[] = folderSearchQuery
    ? deckStats.flatMap(({ deck, cards }) =>
        cards
          .filter(c => c.front.toLowerCase().includes(folderSearchQuery) || c.back.toLowerCase().includes(folderSearchQuery))
          .map(c => ({ card: c, deckId: deck.id, deckName: deck.name }))
      )
    : []

  return (
    <div
      className="space-y-5"
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
          <Link href="/library">Library</Link>
        </span>

        {/* Language pair segment — shown when accessed from a language library */}
        {inPair && pairSource && pairTarget && (
          <>
            <span className="text-ink-faint">/</span>
            <span className="text-ink-muted hover:text-ink">
              <Link href={`/library${qs}`}>{langName(pairSource)}</Link>
            </span>
          </>
        )}

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
              <Link href={routes.library(ancestor.id, { source: pairSource, target: pairTarget })}>{ancestor.name}</Link>
            </span>
          </>
        ))}

        <span className="text-ink-faint">/</span>
        <span className="text-ink font-medium">{folder.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        {renaming ? (
          <input
            autoFocus
            className="text-2xl font-semibold bg-transparent outline-none border-b border-accent text-ink w-full max-w-sm"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={handleRenameFolder}
            onKeyDown={e => {
              if (e.key === 'Enter') handleRenameFolder()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <h1
            className={`text-2xl font-semibold text-ink ${!folder.isSynced ? 'cursor-text select-none' : ''}`}
            title={!folder.isSynced ? 'Double-click to rename' : undefined}
            onDoubleClick={() => {
              if (folder.isSynced) return
              setRenameValue(folder.name)
              setRenaming(true)
            }}
          >
            {folder.name}
          </h1>
        )}
        {/* Folder settings gear — new subfolder / vocabulary onboarding / delete live in here. */}
        <div className="relative shrink-0">
          <button
            onClick={() => setSettingsOpen(v => !v)}
            title="Folder settings"
            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-raised transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          {settingsOpen && (
            <div className="absolute right-0 top-full mt-1 z-20 bg-surface-raised border border-line/10 rounded-lg py-1 w-64 shadow-xl">
              {!folder.isSynced && (
                <button
                  onClick={() => { setSettingsOpen(false); setAddingFolder(true); setNewName('') }}
                  className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-line/5 transition-colors"
                >
                  + New subfolder
                </button>
              )}
              <button
                disabled={queueingOnboard || (pendingOnboard === 0 && onboardableCount === 0)}
                onClick={() => void startFolderOnboarding()}
                title="Rate how well you already know each never-studied card in this folder — no need to open each deck"
                className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-line/5 transition-colors disabled:opacity-50"
              >
                {queueingOnboard
                  ? 'Opening…'
                  : pendingOnboard > 0
                    ? `Continue onboarding (${pendingOnboard} left)`
                    : onboardableCount > 0
                      ? `Onboard ${onboardableCount} unlearned card${onboardableCount !== 1 ? 's' : ''}`
                      : counts === null ? 'Onboard vocabulary…' : 'Nothing to onboard'}
              </button>
              {!folder.isSynced && (
                <button
                  onClick={() => { setSettingsOpen(false); void handleDeleteCurrentFolder() }}
                  className="w-full text-left px-4 py-2 text-sm text-danger/80 hover:bg-line/5 transition-colors"
                >
                  Delete folder
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {onboardError && <p className="text-danger text-xs text-right">{onboardError}</p>}

      {/* Stats + Study button for this folder (including subfolders) */}
      {counts && (counts.unlearned + counts.learning + counts.graduated) > 0 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {COUNTER_CONFIG.map(({ key, label, value, color, border, desc }) => {
              const isActive = activeFilter === key
              return (
                <button
                  key={key}
                  onClick={() => setActiveFilter(isActive ? null : key)}
                  className={`panel border-t-2 ${border} space-y-1 text-center transition-colors w-full
                    ${isActive ? 'bg-surface-raised ring-1 ring-ink/10' : 'hover:bg-surface-raised/50'}`}
                >
                  <div className={`text-2xl font-semibold ${color}`}>{value}</div>
                  <div className="text-xs font-medium text-ink">{label}</div>
                  <div className="text-xs text-ink-faint">{desc}</div>
                </button>
              )
            })}
          </div>

          {/* Filtered card list (cross-deck within this folder) */}
          {activeFilter && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">
                  {activeFilter === 'starred' ? 'Starred' : COUNTER_CONFIG.find(c => c.key === activeFilter)?.label} — {filteredCards.length} card{filteredCards.length !== 1 ? 's' : ''}
                </h2>
                <div className="flex items-center gap-3">
                  {filteredCards.length > 0 && (
                    <button
                      onClick={() => setSelectedFilterIds(prev =>
                        prev.size === filteredCards.length ? new Set() : new Set(filteredCards.map(f => f.card.id)))}
                      className="text-xs text-ink-faint hover:text-ink transition-colors"
                    >
                      {selectedFilterIds.size === filteredCards.length ? 'Deselect all' : 'Select all'}
                    </button>
                  )}
                  <button onClick={() => { setActiveFilter(null); setSelectedFilterIds(new Set()) }} className="text-xs text-accent hover:text-accent-soft transition-colors">
                    Show all ✕
                  </button>
                </div>
              </div>

              {userId && (
                <CardBulkPanel
                  userId={userId}
                  cards={filteredCards.map(f => f.card)}
                  states={deckStats.flatMap(ds => ds.states)}
                  selectedIds={selectedFilterIds}
                  onClear={() => setSelectedFilterIds(new Set())}
                  onApplied={() => { setSelectedFilterIds(new Set()); void load() }}
                />
              )}

              {(() => {
                // Starred has no stat-box config (it's a flag, not a graduation state) but is still
                // studyable — as an elective session that takes each card in whatever state it's in.
                if (activeFilter === 'starred') {
                  return filteredCards.length > 0 ? (
                    <Link
                      href={routes.folderSession(folderId, { category: 'starred' })}
                      className="btn-primary block w-full text-center"
                    >
                      Study Starred
                    </Link>
                  ) : null
                }
                const cfg = COUNTER_CONFIG.find(c => c.key === activeFilter)
                return cfg && cfg.value > 0 ? (
                  <Link
                    href={activeFilter === 'new' || activeFilter === 'learning'
                      ? routes.ladderFolder(folderId, { category: activeFilter })
                      : routes.folderSession(folderId, { category: activeFilter })}
                    className="btn-primary block w-full text-center"
                  >
                    Study {cfg.label}
                  </Link>
                ) : null
              })()}

              {filteredCards.length === 0 ? (
                <div className="panel text-ink-muted text-sm text-center py-6">No cards in this category.</div>
              ) : (
                <div className="panel divide-y divide-line/5 p-0 overflow-hidden">
                  {filteredCards.map(({ card, deckName, deckId, status }) => (
                    // Checkbox OUTSIDE the Link — inside it, stopPropagation would suppress Next's
                    // client-side handler but leave the anchor's native navigation intact.
                    <div key={card.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-raised/50 transition-colors">
                      <input
                        type="checkbox"
                        checked={selectedFilterIds.has(card.id)}
                        onChange={() => setSelectedFilterIds(prev => {
                          const next = new Set(prev)
                          if (next.has(card.id)) next.delete(card.id); else next.add(card.id)
                          return next
                        })}
                        className="accent-accent w-4 h-4 shrink-0 cursor-pointer"
                      />
                      <Link
                        href={routes.deck(deckId, { filter: activeFilter })}
                        className="flex items-center justify-between flex-1 min-w-0"
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
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <Link
            href={routes.ladderFolder(folderId)}
            className={(counts.dueNow + counts.learning) === 0 ? 'btn-primary opacity-40 pointer-events-none inline-block' : 'btn-primary inline-block'}
          >
            Study folder ({counts.dueNow + counts.learning})
          </Link>
        </div>
      )}

      {/* Search bar */}
      {(visibleSubfolders.length > 0 || visibleDecks.length > 0 || searchQuery) && (
        <div className="flex items-center gap-2">
        <div className="relative flex-1">
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
          <StarFilterButton active={activeFilter === 'starred'}
            onToggle={() => setActiveFilter(activeFilter === 'starred' ? null : 'starred')} />
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

      {/* Contents */}
      {folderSearchQuery ? (
        folderCardResults.length === 0 ? (
          <div className="panel text-ink-muted text-sm text-center py-10">
            No cards match &ldquo;{searchQuery}&rdquo;.
          </div>
        ) : (
          <div className="panel divide-y divide-line/5 p-0 overflow-hidden">
            {folderCardResults.map(({ card, deckId, deckName }) => (
              <Link
                key={`${card.id}-${deckId}`}
                href={routes.deck(deckId)}
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
      ) : visibleSubfolders.length === 0 && visibleDecks.length === 0 && !addingFolder ? (
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
                  onTouchEnd={onItemTouchEnd}
                  onTouchCancel={onItemTouchEnd}
                  style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
                  className={`panel flex items-center gap-3 py-3 my-0.5 transition-all cursor-grab active:cursor-grabbing select-none ${
                    isDragging      ? 'opacity-40' :
                    dt?.pos === 'into' ? 'border-accent bg-accent/5 scale-[1.01]' :
                    'hover:border-line/10'
                  }`}
                >
                  <FolderIcon />
                  <Link
                    href={routes.library(sub.id, { source: pairSource, target: pairTarget })}
                    className="flex-1 min-w-0"
                    onClick={e => { if (dragging) e.preventDefault() }}
                  >
                    <div className="text-sm font-medium text-ink truncate">{sub.name}</div>
                  </Link>
                  {(() => {
                    const c = subfolderCounts[sub.id]
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
                  onTouchEnd={onItemTouchEnd}
                  onTouchCancel={onItemTouchEnd}
                  style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
                  className={`panel flex items-center gap-3 py-3 my-0.5 transition-all cursor-grab active:cursor-grabbing select-none ${
                    isDragging ? 'opacity-40' : 'hover:border-line/10'
                  }`}
                >
                  <DeckIcon />
                  <div className="flex-1 min-w-0">
                    <Link href={routes.deck(deck.id)} className="text-sm font-medium text-ink truncate block hover:text-accent transition-colors">
                      {deck.name}
                    </Link>
                    <div className="text-xs text-ink-muted mt-0.5">{deck.targetLanguage.toUpperCase()}</div>
                  </div>
                  {(() => {
                    const c = deckCounts[deck.id]
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
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => handlePin(deck.id, !deck.isPinned)}
                      className="text-ink-faint hover:text-warning transition-colors text-sm">
                      {deck.isPinned ? '★' : '☆'}
                    </button>
                    {folder?.isSynced && (
                      <button
                        onClick={() => handleMoveDeckToRoot(deck.id)}
                        title="Move to library root"
                        className="text-xs text-ink-faint hover:text-ink transition-colors px-2 py-1 rounded border border-line/10 hover:border-line/20"
                      >
                        Move to library
                      </button>
                    )}
                    <Link href={routes.ladderDeck(deck.id)} className="btn-primary text-xs py-1 px-3">Study</Link>
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
