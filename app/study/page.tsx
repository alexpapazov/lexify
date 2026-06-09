'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }      from '@/lib/data/decks'
import { SupabaseCardRepository }      from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseFolderRepository }    from '@/lib/data/folders'
import type { Deck, Card, CardState, Folder } from '@/domain'

type FilterKey = 'new' | 'learning' | 'graduated' | 'due'

interface DeckWithStats {
  deck:      Deck
  cards:     Card[]
  states:    CardState[]
  unlearned: number
  learning:  number
  graduated: number
  dueNow:    number
}

interface GlobalCounts {
  unlearned: number
  learning:  number
  graduated: number
  dueNow:    number
}

// A flat card entry for the cross-deck filtered view
interface FilteredCard {
  card:     Card
  state:    CardState | undefined
  deckName: string
  deckId:   string
  status:   string
}

export default function StudyPage() {
  const [deckStats,    setDeckStats]    = useState<DeckWithStats[]>([])
  const [global,       setGlobal]       = useState<GlobalCounts>({ unlearned: 0, learning: 0, graduated: 0, dueNow: 0 })
  const [rootFolders,  setRootFolders]  = useState<Folder[]>([])
  const [allDecks,     setAllDecks]     = useState<Deck[]>([])
  const [loading,      setLoading]      = useState(true)
  const [authed,       setAuthed]       = useState(false)
  const [activeFilter, setActiveFilter] = useState<FilterKey | null>(null)
  const router   = useRouter()
  const supabase = createClient()

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoading(false); return }
    setAuthed(true)

    const deckRepo   = new SupabaseDeckRepository()
    const cardRepo   = new SupabaseCardRepository()
    const stateRepo  = new SupabaseCardStateRepository()
    const folderRepo = new SupabaseFolderRepository()

    const [decks, folders] = await Promise.all([
      deckRepo.list(session.user.id),
      folderRepo.list(session.user.id),
    ])
    setRootFolders(folders.filter(f => f.parentId === null))
    setAllDecks(decks)
    const now = new Date()

    const stats = await Promise.all(decks.map(async deck => {
      const [cards, states] = await Promise.all([
        cardRepo.listByDeck(deck.id),
        stateRepo.listByDeck(session.user.id, deck.id),
      ])
      const stateMap = new Map(states.map(s => [s.cardId, s]))
      return {
        deck, cards, states,
        unlearned: cards.filter(c => !stateMap.has(c.id)).length,
        learning:  states.filter(s => !s.graduated).length,
        graduated: states.filter(s => s.graduated).length,
        dueNow:    states.filter(s => s.graduated && s.dueAt && new Date(s.dueAt) <= now).length,
      }
    }))

    setDeckStats(stats)
    setGlobal(stats.reduce((acc, s) => ({
      unlearned: acc.unlearned + s.unlearned,
      learning:  acc.learning  + s.learning,
      graduated: acc.graduated + s.graduated,
      dueNow:    acc.dueNow    + s.dueNow,
    }), { unlearned: 0, learning: 0, graduated: 0, dueNow: 0 }))
    setLoading(false)
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Build the filtered card list across all decks
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

  const totalDue = global.dueNow + global.learning

  const COUNTER_CONFIG = [
    { key: 'new'       as FilterKey, label: 'Unlearned', value: global.unlearned, color: 'text-ink-muted',   border: 'border-ink-faint', desc: 'Not yet started' },
    { key: 'learning'  as FilterKey, label: 'Learning',  value: global.learning,  color: 'text-warning',     border: 'border-warning',   desc: 'In pipeline'     },
    { key: 'graduated' as FilterKey, label: 'Graduated', value: global.graduated, color: 'text-success',     border: 'border-success',   desc: 'Long-term review' },
    { key: 'due'       as FilterKey, label: 'Due Now',   value: global.dueNow,    color: 'text-accent-soft', border: 'border-accent',    desc: 'Ready to review' },
  ]

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Study</h1>
        <p className="text-ink-muted mt-1">Welcome to your study space.</p>
      </div>

      {!authed ? (
        <div className="panel text-center space-y-4 py-12">
          <p className="text-ink-muted">Sign in to see your decks and start studying.</p>
          <Link href="/auth" className="btn-primary inline-block">Sign in</Link>
        </div>
      ) : (
        <>
          {/* ── Global counters ─────────────────────────────────────────── */}
          <div className="grid grid-cols-4 gap-3">
            {COUNTER_CONFIG.map(({ key, label, value, color, border, desc }) => {
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

          {/* ── Filtered card list (cross-deck) ─────────────────────────── */}
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

          {/* ── Study all due ───────────────────────────────────────────── */}
          {deckStats.length > 0 && (
            <div className="flex items-center gap-4">
              <Link
                href="/study/all/session"
                className={totalDue === 0 ? 'btn-primary opacity-40 pointer-events-none' : 'btn-primary'}
              >
                Study all due ({totalDue})
              </Link>
              {totalDue === 0 && (
                <p className="text-ink-muted text-sm">Nothing due right now — check back later!</p>
              )}
            </div>
          )}

          {/* ── Pinned decks ────────────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-medium text-ink">Pinned decks</h2>
              <Link href="/upload" className="text-sm text-accent hover:text-accent-soft transition-colors">
                + New deck
              </Link>
            </div>

            {deckStats.filter(s => s.deck.isPinned).length === 0 ? (
              <div className="panel text-ink-muted text-sm">
                No pinned decks. Pin a deck from your Library using the ☆ icon.
              </div>
            ) : (
              <div className="space-y-2">
                {deckStats.filter(s => s.deck.isPinned).map(({ deck, unlearned, learning, graduated, dueNow }) => (
                  <Link
                    key={deck.id}
                    href={`/study/${deck.id}`}
                    className="panel flex items-center gap-4 hover:border-white/10 transition-colors cursor-pointer"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-ink font-medium truncate">{deck.name}</div>
                      <div className="text-xs text-ink-muted mt-0.5">{deck.targetLanguage.toUpperCase()}</div>
                    </div>

                    <div className="hidden sm:flex items-center gap-3 text-xs" onClick={e => e.stopPropagation()}>
                      {[
                        { label: `${unlearned} new`,     filter: 'new',       color: 'text-ink-muted hover:text-ink'     },
                        { label: `${learning} learning`, filter: 'learning',  color: 'text-warning hover:text-yellow-300' },
                        { label: `${graduated} done`,    filter: 'graduated', color: 'text-success hover:text-green-300'  },
                        { label: `${dueNow} due`,        filter: 'due',       color: 'text-accent-soft hover:text-accent' },
                      ].map(({ label, filter, color }) => (
                        <button key={filter}
                          onClick={e => { e.preventDefault(); e.stopPropagation(); router.push(`/study/${deck.id}?filter=${filter}`) }}
                          className={`${color} transition-colors`}>
                          {label}
                        </button>
                      ))}
                    </div>

                    <div onClick={e => e.stopPropagation()} className="shrink-0">
                      <Link href={`/study/${deck.id}/session`} className="btn-primary text-sm py-1.5 px-4">Study</Link>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* ── Library ─────────────────────────────────────────────────── */}
          {/* ── Library ─────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-medium text-ink">Library</h2>
              <Link href="/library" className="text-sm text-accent hover:text-accent-soft transition-colors">
                Open Library →
              </Link>
            </div>

            {rootFolders.length === 0 ? (
              <div className="panel text-ink-muted text-sm">
                No folders yet. <Link href="/library" className="text-accent hover:text-accent-soft">Open Library</Link> to create one.
              </div>
            ) : (
              <div className="panel p-1.5 space-y-0.5">
                {rootFolders.slice(0, 5).map(folder => {
                  const deckCount = allDecks.filter(d => d.folderId === folder.id).length
                  return (
                    <Link
                      key={folder.id}
                      href={`/library/${folder.id}`}
                      className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-raised/50 transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-accent-soft shrink-0">
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                      </svg>
                      <span className="flex-1 text-sm text-ink truncate">{folder.name}</span>
                      {deckCount > 0 && (
                        <span className="text-xs text-ink-faint">{deckCount} deck{deckCount !== 1 ? 's' : ''}</span>
                      )}
                    </Link>
                  )
                })}
                {rootFolders.length > 5 && (
                  <Link href="/library" className="block px-3 py-2 text-xs text-ink-muted hover:text-ink transition-colors">
                    +{rootFolders.length - 5} more folders…
                  </Link>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
