'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }      from '@/lib/data/decks'
import { SupabaseCardRepository }      from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import type { Deck, Card, CardState } from '@/domain'

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

// One day's worth of upcoming-review forecast data
interface ForecastDay {
  date:   string
  label:  string
  dayNum: number
  count:  number
}

const FORECAST_DAYS = 14

export default function StudyPage() {
  const [deckStats,    setDeckStats]    = useState<DeckWithStats[]>([])
  const [global,       setGlobal]       = useState<GlobalCounts>({ unlearned: 0, learning: 0, graduated: 0, dueNow: 0 })
  const [forecast,     setForecast]     = useState<ForecastDay[]>([])
  const [loading,      setLoading]      = useState(true)
  const [authed,       setAuthed]       = useState(false)
  const [activeFilter, setActiveFilter] = useState<FilterKey | null>(null)
  const supabase = createClient()

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoading(false); return }
    setAuthed(true)

    const deckRepo  = new SupabaseDeckRepository()
    const cardRepo  = new SupabaseCardRepository()
    const stateRepo = new SupabaseCardStateRepository()

    const decks = await deckRepo.list(session.user.id)
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

    // ── Upcoming review forecast ────────────────────────────────────────
    const endDate = new Date(now)
    endDate.setUTCDate(endDate.getUTCDate() + FORECAST_DAYS)
    const counts = await stateRepo.countDueByDateRange(session.user.id, now.toISOString(), endDate.toISOString())

    const days: ForecastDay[] = []
    for (let i = 0; i < FORECAST_DAYS; i++) {
      const d = new Date(now)
      d.setUTCDate(d.getUTCDate() + i)
      const dateStr = d.toISOString().slice(0, 10)
      days.push({
        date:   dateStr,
        label:  i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
        dayNum: d.getUTCDate(),
        count:  counts.get(dateStr) ?? 0,
      })
    }
    setForecast(days)

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
  const maxForecast = Math.max(1, ...forecast.map(d => d.count))

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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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

          {/* ── Upcoming reviews ─────────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-medium text-ink">Coming up</h2>
              <span className="text-xs text-ink-faint">Cards due over the next {FORECAST_DAYS} days</span>
            </div>

            {forecast.every(d => d.count === 0) ? (
              <div className="panel text-ink-muted text-sm text-center py-6">
                Nothing scheduled yet — keep studying to build up your review queue.
              </div>
            ) : (
              <div className="panel">
                <div className="flex items-end gap-1 sm:gap-2 h-40">
                  {forecast.map(day => (
                    <div key={day.date} className="flex-1 flex flex-col items-center justify-end h-full gap-1 min-w-0">
                      <div className="text-xs text-ink-muted h-4">{day.count > 0 ? day.count : ''}</div>
                      <div
                        className={`w-full rounded-t-sm transition-all ${day.count > 0 ? 'bg-accent' : 'bg-surface-raised'}`}
                        style={{ height: `${day.count > 0 ? Math.max(6, Math.round((day.count / maxForecast) * 100)) : 2}%` }}
                        title={`${day.label} ${day.dayNum}: ${day.count} card${day.count !== 1 ? 's' : ''} due`}
                      />
                      <div className="text-[10px] text-ink-faint text-center leading-tight">
                        <div>{day.label}</div>
                        <div>{day.dayNum}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
