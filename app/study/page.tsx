'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }      from '@/lib/data/decks'
import { SupabaseCardRepository }      from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { getToday } from '@/lib/dates'
import { langName } from '@/lib/languages'
import type { Deck, Card, CardState } from '@/domain'
import { effectiveMultiplierRange, acceleratedEffectiveMultiplierRange } from '@/engine/scheduler'

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
  card:           Card
  state:          CardState | undefined
  deckName:       string
  deckId:         string
  status:         string
  sourceLanguage: string
  targetLanguage: string
}

// One day's worth of upcoming-review forecast data
interface ForecastDay {
  date:   string
  label:  string
  dayNum: number
  count:  number
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00.000Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function buildForecastDays(
  stats: DeckWithStats[],
  startDate: string,
  endDate: string,
  todayStr: string,
  dueNow: number,
): ForecastDay[] {
  if (!startDate || !endDate || startDate > endDate) return []
  const deckCounts = new Map<string, number>()
  for (const { states } of stats) {
    for (const s of states) {
      if (!s.graduated || !s.dueAt || s.reviewDirection === 'reverse') continue
      deckCounts.set(s.dueAt.slice(0, 10), (deckCounts.get(s.dueAt.slice(0, 10)) ?? 0) + 1)
    }
  }
  const days: ForecastDay[] = []
  const startMs = new Date(startDate + 'T00:00:00.000Z').getTime()
  const endMs   = new Date(endDate   + 'T00:00:00.000Z').getTime()
  for (let ms = startMs; ms <= endMs; ms += 86400000) {
    const d       = new Date(ms)
    const dateStr = d.toISOString().slice(0, 10)
    const isToday = dateStr === todayStr
    days.push({
      date:   dateStr,
      label:  isToday ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      dayNum: d.getUTCDate(),
      count:  isToday ? dueNow : (deckCounts.get(dateStr) ?? 0),
    })
  }
  return days
}

export default function StudyPage() {
  const [deckStats,    setDeckStats]    = useState<DeckWithStats[]>([])
  const [global,       setGlobal]       = useState<GlobalCounts>({ unlearned: 0, learning: 0, graduated: 0, dueNow: 0 })
  const [forecast,     setForecast]     = useState<ForecastDay[]>([])
  const [loading,      setLoading]      = useState(true)
  const [authed,       setAuthed]       = useState(false)
  const [userId,       setUserId]       = useState('')
  const [todayStr,     setTodayStr]     = useState('')
  const [activeFilter, setActiveFilter] = useState<FilterKey | null>(null)
  const [selectedForecastDate, setSelectedForecastDate] = useState<string | null>(null)
  const [forecastStartDate,    setForecastStartDate]    = useState('')
  const [forecastEndDate,      setForecastEndDate]      = useState('')
  const [redistributing, setRedistributing] = useState(false)
  const [redistributeMsg, setRedistributeMsg] = useState<string | null>(null)
  const [showDuePicker, setShowDuePicker] = useState(false)
  const duePickerRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const supabase = createClient()

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoading(false); return }
    setAuthed(true)
    setUserId(session.user.id)

    const deckRepo  = new SupabaseDeckRepository()
    const cardRepo  = new SupabaseCardRepository()
    const stateRepo = new SupabaseCardStateRepository()

    const [decks, profileRes] = await Promise.all([
      deckRepo.list(session.user.id),
      supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', session.user.id).single(),
    ])

    const tz           = (profileRes.data?.timezone as string | null) ?? 'UTC'
    const turnoverHour = (profileRes.data?.day_turnover_hour as number | null) ?? 0
    const todayStr     = getToday(tz, turnoverHour)
    setTodayStr(todayStr)
    const todayDate    = new Date(todayStr + 'T00:00:00.000Z')
    const now          = new Date()

    const stats = await Promise.all(decks.map(async deck => {
      const [cards, states] = await Promise.all([
        cardRepo.listByDeck(deck.id),
        stateRepo.listByDeck(session.user.id, deck.id),
      ])
      // Forward states are the authoritative source for card-level counts.
      // Reverse states are only valid when their forward counterpart is also graduated.
      const forwardStates = states.filter(s => s.reviewDirection !== 'reverse')
      const stateMap = new Map(forwardStates.map(s => [s.cardId, s]))
      return {
        deck, cards, states,
        unlearned: cards.filter(c => !stateMap.has(c.id)).length,
        learning:  forwardStates.filter(s => !s.graduated).length,
        graduated: forwardStates.filter(s => s.graduated).length,
        dueNow:    states.filter(s =>
          s.graduated && s.dueAt && new Date(s.dueAt) <= now &&
          (s.reviewDirection !== 'reverse' || stateMap.get(s.cardId)?.graduated === true)
        ).length,
      }
    }))

    const globalCounts = stats.reduce((acc, s) => ({
      unlearned: acc.unlearned + s.unlearned,
      learning:  acc.learning  + s.learning,
      graduated: acc.graduated + s.graduated,
      dueNow:    acc.dueNow    + s.dueNow,
    }), { unlearned: 0, learning: 0, graduated: 0, dueNow: 0 })
    setDeckStats(stats)
    setGlobal(globalCounts)

    // ── Upcoming review forecast ────────────────────────────────────────
    const initStart = todayStr
    const initEnd   = addDays(todayStr, 13)
    setForecastStartDate(initStart)
    setForecastEndDate(initEnd)
    setForecast(buildForecastDays(stats, initStart, initEnd, todayStr, globalCounts.dueNow))

    setLoading(false)
  }

  async function handleRedistribute() {
    if (!selectedForecastDate || redistributing || !userId || !todayStr) return
    setRedistributing(true)
    setRedistributeMsg(null)
    try {
      const today = new Date(todayStr + 'T00:00:00.000Z')
      const isToday = selectedForecastDate === forecast[0]?.date

      // First pass: compute each card's full acceptable date range.
      // Cards with lastRating='again' or in the relearn loop are not movable.
      interface Movable { state: CardState; earliest: string; latest: string }
      const movable: Movable[] = []

      for (const { states } of deckStats) {
        for (const s of states) {
          if (!s.graduated || !s.dueAt || s.reviewDirection === 'reverse') continue
          // Only process cards on the selected date
          const isOnSelected = isToday
            ? new Date(s.dueAt) <= new Date()
            : s.dueAt.slice(0, 10) === selectedForecastDate
          if (!isOnSelected) continue
          // Skip relearn loop cards
          if (s.relearningStep > 0) continue

          // Fast-track cards on their first review cycle: window = [today, graduatedAt + 14 days]
          if (s.acceleratedMode === 'import_known' && s.reps === 0 && s.graduatedAt) {
            const gradDay = new Date(s.graduatedAt)
            gradDay.setUTCHours(0, 0, 0, 0)
            const maxDate = new Date(gradDay.getTime() + 14 * 24 * 60 * 60 * 1000)
            const earliest = todayStr
            const latest   = maxDate.toISOString().slice(0, 10)
            if (earliest <= latest) movable.push({ state: s, earliest, latest })
            continue
          }

          // Standard graduated cards: use smooth multiplier window
          if (!s.lastRating || s.lastRating === 'again') continue
          if (!s.lastReviewedAt || s.scheduledIntervalDays <= 0) continue

          const rating = s.lastRating as 'hard' | 'good' | 'easy'
          const range = s.acceleratedMode === 'import_known' && s.acceleratedWrongStreak < 2
            ? acceleratedEffectiveMultiplierRange(rating, s.scheduledIntervalDays, s.acceleratedPenalty)
            : effectiveMultiplierRange(rating, s.scheduledIntervalDays)

          const baseInterval = s.scheduledIntervalDays / range.ideal
          const smoothMinDays = baseInterval * range.min
          const smoothMaxDays = baseInterval * range.max

          const lastReviewed = new Date(s.lastReviewedAt)
          lastReviewed.setUTCHours(0, 0, 0, 0)

          const minDate = new Date(lastReviewed)
          minDate.setUTCDate(minDate.getUTCDate() + Math.ceil(smoothMinDays))
          const maxDate = new Date(lastReviewed)
          maxDate.setUTCDate(maxDate.getUTCDate() + Math.floor(smoothMaxDays))

          // Constrain earliest to today (can't move to the past)
          const earliestDate = minDate < today ? today : minDate
          const earliest = earliestDate.toISOString().slice(0, 10)
          const latest   = maxDate.toISOString().slice(0, 10)

          if (earliest <= latest) {
            movable.push({ state: s, earliest, latest })
          }
        }
      }

      if (movable.length === 0) {
        setRedistributeMsg('No cards can be moved — all are at the boundary of their scheduling window.')
        return
      }

      // Build windowDays spanning from today to the furthest card's latest date.
      const maxLatest = movable.reduce((m, c) => c.latest > m ? c.latest : m, todayStr)
      const windowDays: string[] = []
      for (let d = new Date(today); d.toISOString().slice(0, 10) <= maxLatest; d.setUTCDate(d.getUTCDate() + 1)) {
        windowDays.push(d.toISOString().slice(0, 10))
      }

      // Build a load map counting all graduated cards on any day in the window.
      const loadMap = new Map<string, number>()
      for (const day of windowDays) loadMap.set(day, 0)
      for (const { states } of deckStats) {
        for (const s of states) {
          if (!s.graduated || !s.dueAt) continue
          const dayKey = s.dueAt.slice(0, 10)
          if (loadMap.has(dayKey)) loadMap.set(dayKey, (loadMap.get(dayKey) ?? 0) + 1)
        }
      }

      // Greedy assignment: sort by tightest window first, assign each card to the
      // least-loaded day in [earliest, latest].
      movable.sort((a, b) => {
        const aSpan = windowDays.filter(d => d >= a.earliest && d <= a.latest).length
        const bSpan = windowDays.filter(d => d >= b.earliest && d <= b.latest).length
        return aSpan - bSpan
      })
      const assignments = new Map<string, string>()
      for (const { state, earliest, latest } of movable) {
        let bestDay = state.dueAt!.slice(0, 10)
        let bestLoad = Infinity
        for (const day of windowDays) {
          if (day < earliest || day > latest) continue
          const load = loadMap.get(day) ?? 0
          if (load < bestLoad) { bestLoad = load; bestDay = day }
        }
        assignments.set(state.cardId, bestDay)
        loadMap.set(bestDay, (loadMap.get(bestDay) ?? 0) + 1)
        const prevDay = state.dueAt!.slice(0, 10)
        loadMap.set(prevDay, Math.max(0, (loadMap.get(prevDay) ?? 1) - 1))
      }

      // Upsert only states where the date changed
      const stateRepo = new SupabaseCardStateRepository()
      const toUpdate: CardState[] = []
      for (const { state } of movable) {
        const newDay = assignments.get(state.cardId)
        if (!newDay || newDay === state.dueAt!.slice(0, 10)) continue
        const timePart = state.dueAt!.slice(10)
        toUpdate.push({ ...state, dueAt: newDay + timePart })
      }

      if (toUpdate.length > 0) {
        await stateRepo.upsertBatch(toUpdate)
        const updatedMap = new Map(toUpdate.map(s => [s.cardId, s]))
        setDeckStats(prev => prev.map(ds => ({
          ...ds,
          states: ds.states.map(s => updatedMap.get(s.cardId) ?? s),
        })))
        setForecast(prev => {
          const next = prev.map(d => ({ ...d }))
          for (const s of toUpdate) {
            const orig = movable.find(m => m.state.cardId === s.cardId)?.state
            if (!orig?.dueAt) continue
            const oldDay = orig.dueAt.slice(0, 10)
            const newDay = s.dueAt!.slice(0, 10)
            if (oldDay === newDay) continue
            const oi = next.findIndex(d => d.date === oldDay)
            const ni = next.findIndex(d => d.date === newDay)
            if (oi >= 0) next[oi]!.count = Math.max(0, next[oi]!.count - 1)
            if (ni >= 0) {
              next[ni]!.count = next[ni]!.count + 1
            } else {
              // Card moved to a day not yet in the forecast — insert it sorted
              const d = new Date(newDay + 'T00:00:00.000Z')
              next.push({
                date: newDay,
                count: 1,
                label: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
                dayNum: d.getUTCDate(),
              })
              next.sort((a, b) => a.date.localeCompare(b.date))
            }
          }
          return next
        })
        setRedistributeMsg(`Moved ${toUpdate.length} card${toUpdate.length !== 1 ? 's' : ''} — ${movable.length - toUpdate.length} already optimal.`)
      } else {
        setRedistributeMsg('Cards are already well distributed within their scheduling windows.')
      }
    } catch (err) {
      console.error('Redistribute failed:', err)
      setRedistributeMsg('Something went wrong. Please try again.')
    } finally {
      setRedistributing(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!todayStr || !forecastStartDate || !forecastEndDate) return
    setForecast(buildForecastDays(deckStats, forecastStartDate, forecastEndDate, todayStr, global.dueNow))
    setSelectedForecastDate(prev => prev && prev >= forecastStartDate && prev <= forecastEndDate ? prev : null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecastStartDate, forecastEndDate])

  useEffect(() => {
    if (!showDuePicker) return
    function handleClick(e: MouseEvent) {
      if (duePickerRef.current && !duePickerRef.current.contains(e.target as Node)) {
        setShowDuePicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showDuePicker])

  // Build the filtered card list across all decks
  const now = new Date()
  const filteredCards: FilteredCard[] = activeFilter ? deckStats.flatMap(({ deck, cards, states }) => {
    const stateMap = new Map(states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]))
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
        return { card, state: s, deckName: deck.name, deckId: deck.id, status, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage }
      })
  }) : []

  const totalDue = global.dueNow
  const maxForecast = Math.max(1, ...forecast.map(d => d.count))

  // Group due counts by language pair for the "Study all due" popover
  interface LangPairDue { sourceLanguage: string; targetLanguage: string; dueNow: number }
  const langPairDue: LangPairDue[] = Object.values(
    deckStats.reduce<Record<string, LangPairDue>>((acc, { deck, dueNow }) => {
      const key = `${deck.sourceLanguage}|${deck.targetLanguage}`
      if (!acc[key]) acc[key] = { sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage, dueNow: 0 }
      acc[key]!.dueNow += dueNow
      return acc
    }, {})
  ).filter(p => p.dueNow > 0)

  // Cards due on the selected forecast date (for the click-to-expand panel)
  const forecastCards: FilteredCard[] = selectedForecastDate ? deckStats.flatMap(({ deck, cards, states }) => {
    // Use forward states only so orphaned reverse states don't appear in the list
    const stateMap = new Map(states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]))
    return cards
      .filter(card => {
        const s = stateMap.get(card.id)
        if (!s?.graduated || !s.dueAt) return false
        // "Today" date means due now; future date means exact date match
        const isToday = selectedForecastDate === forecast[0]?.date
        if (isToday) return new Date(s.dueAt) <= now
        return s.dueAt.slice(0, 10) === selectedForecastDate
      })
      .map(card => {
        const s = stateMap.get(card.id)
        return { card, state: s, deckName: deck.name, deckId: deck.id, status: 'Graduated', sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage }
      })
  }) : []

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
                  onClick={() => { setActiveFilter(isActive ? null : key); setSelectedForecastDate(null) }}
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
                  {filteredCards.map(({ card, deckName, deckId, status, sourceLanguage, targetLanguage }) => (
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
                        <span className="text-xs text-ink-faint hidden sm:block">{langName(targetLanguage)} → {langName(sourceLanguage)} · {deckName}</span>
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
            <div className="mt-8 relative inline-block" ref={duePickerRef}>
              {totalDue === 0 ? (
                <button disabled className="btn-primary opacity-40 cursor-not-allowed">No cards due</button>
              ) : (
                <button className="btn-primary" onClick={() => setShowDuePicker(v => !v)}>
                  Study all due ({totalDue})
                </button>
              )}
              {showDuePicker && langPairDue.length > 0 && (
                <div className="absolute left-0 top-full mt-2 z-20 min-w-[220px] rounded-card border border-white/10 bg-surface-deep shadow-xl overflow-hidden">
                  <p className="px-4 py-2.5 text-xs text-ink-faint border-b border-white/10">Choose a language to study</p>
                  {langPairDue.map(pair => (
                    <button
                      key={`${pair.sourceLanguage}|${pair.targetLanguage}`}
                      className="w-full flex items-center justify-between px-4 py-3 text-sm text-left hover:bg-surface-raised transition-colors"
                      onClick={() => {
                        setShowDuePicker(false)
                        router.push(`/study/all/session?category=due&source=${pair.sourceLanguage}&target=${pair.targetLanguage}`)
                      }}
                    >
                      <span className="text-ink">{langName(pair.targetLanguage)} → {langName(pair.sourceLanguage)}</span>
                      <span className="chip text-xs ml-3">{pair.dueNow}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Upcoming reviews ─────────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-base font-medium text-ink">Coming up</h2>
              <div className="flex items-center gap-1.5 text-xs text-ink-faint">
                <input
                  type="date"
                  value={forecastStartDate}
                  max={forecastEndDate || undefined}
                  onChange={e => setForecastStartDate(e.target.value)}
                  className="bg-surface-raised border border-white/10 rounded px-1.5 py-0.5 text-xs text-ink focus:outline-none focus:border-accent/50 [color-scheme:dark]"
                />
                <span>→</span>
                <input
                  type="date"
                  value={forecastEndDate}
                  min={forecastStartDate || undefined}
                  onChange={e => setForecastEndDate(e.target.value)}
                  className="bg-surface-raised border border-white/10 rounded px-1.5 py-0.5 text-xs text-ink focus:outline-none focus:border-accent/50 [color-scheme:dark]"
                />
              </div>
            </div>

            {forecast.every(d => d.count === 0) ? (
              <div className="panel text-ink-muted text-sm text-center py-6">
                Nothing scheduled yet — keep studying to build up your review queue.
              </div>
            ) : (
              <div className="panel overflow-x-auto">
                <div className="flex items-end gap-1 h-40" style={{ minWidth: `${forecast.length * 36}px` }}>
                  {forecast.map(day => {
                    const isSelected = selectedForecastDate === day.date
                    return (
                      <button
                        key={day.date}
                        onClick={() => {
                          if (day.count === 0) return
                          setSelectedForecastDate(isSelected ? null : day.date)
                          setActiveFilter(null)
                          setRedistributeMsg(null)
                        }}
                        disabled={day.count === 0}
                        className="flex-1 flex flex-col items-center justify-end h-full gap-1 min-w-0 group"
                      >
                        <div className="text-xs text-ink-muted h-4">{day.count > 0 ? day.count : ''}</div>
                        <div
                          className={`w-full rounded-t-sm transition-all ${
                            day.count > 0
                              ? isSelected
                                ? 'bg-accent-soft ring-1 ring-accent'
                                : 'bg-accent group-hover:bg-accent-soft'
                              : 'bg-surface-raised'
                          }`}
                          style={{ height: `${day.count > 0 ? Math.max(6, Math.round((day.count / maxForecast) * 100)) : 2}%` }}
                          title={`${day.label} ${day.dayNum}: ${day.count} card${day.count !== 1 ? 's' : ''} due`}
                        />
                        <div className={`text-[10px] text-center leading-tight ${isSelected ? 'text-accent' : 'text-ink-faint'}`}>
                          <div>{day.label}</div>
                          <div>{day.dayNum}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ── Forecast day card list ──────────────────────────────── */}
            {selectedForecastDate && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">
                    {forecast.find(d => d.date === selectedForecastDate)?.label === 'Today'
                      ? 'Due Today'
                      : `Due ${forecast.find(d => d.date === selectedForecastDate)?.label} ${forecast.find(d => d.date === selectedForecastDate)?.dayNum}`
                    } — {forecastCards.length} card{forecastCards.length !== 1 ? 's' : ''}
                  </h2>
                  <div className="flex items-center gap-3">
                    {selectedForecastDate !== forecast[0]?.date && (
                      <button
                        onClick={handleRedistribute}
                        disabled={redistributing}
                        className="btn-primary text-xs px-3 py-1"
                        title="Spread these cards across earlier days within their acceptable review window"
                      >
                        {redistributing ? 'Redistributing…' : 'Redistribute'}
                      </button>
                    )}
                    <button onClick={() => { setSelectedForecastDate(null); setRedistributeMsg(null) }} className="text-xs text-accent hover:text-accent-soft transition-colors">
                      Close ✕
                    </button>
                  </div>
                </div>
                {redistributeMsg && (
                  <p className="text-xs text-ink-muted">{redistributeMsg}</p>
                )}
                {forecastCards.length === 0 ? (
                  <div className="panel text-ink-muted text-sm text-center py-6">No cards found.</div>
                ) : (
                  <div className="panel divide-y divide-white/5 p-0 overflow-hidden">
                    {forecastCards.map(({ card, deckName, deckId, sourceLanguage, targetLanguage }) => (
                      <Link
                        key={card.id}
                        href={`/study/${deckId}?card=${card.id}`}
                        className="flex items-center justify-between px-4 py-3 hover:bg-surface-raised/50 transition-colors"
                      >
                        <div className="flex gap-6 text-sm min-w-0">
                          <span className="text-ink font-medium w-36 truncate shrink-0">{card.front}</span>
                          <span className="text-ink-muted truncate">{card.back}</span>
                        </div>
                        <span className="text-xs text-ink-faint hidden sm:block shrink-0 ml-2">
                          {langName(targetLanguage)} → {langName(sourceLanguage)} · {deckName}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
