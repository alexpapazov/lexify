'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { displayText } from '@/lib/cardText'
import { ConnectionGraph } from '@/components/analytics/ConnectionGraph'

type RangeDays = 7 | 14 | 30 | 90

interface DayData {
  date:       string   // YYYY-MM-DD
  graduated:  number   // cards that graduated this day
  reviewed:   number   // distinct graduated-card reviews ('due' mode) this day
  newCards:   { front: string; back: string; cardId: string }[]
}

function isoDate(d: Date) { return d.toISOString().slice(0, 10) }

function labelDate(iso: string, range: RangeDays) {
  const d = new Date(iso + 'T12:00:00')
  if (range <= 14) return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  if (range <= 30) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fullDate(iso: string) {
  const today     = isoDate(new Date())
  const yesterday = isoDate(new Date(Date.now() - 86400000))
  if (iso === today)     return 'Today'
  if (iso === yesterday) return 'Yesterday'
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export default function AnalyticsPage() {
  const [range,   setRange]   = useState<RangeDays>(30)
  const [data,    setData]    = useState<DayData[]>([])
  const [loading, setLoading] = useState(true)
  const [userId,  setUserId]  = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ day: DayData; x: number; y: number } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async (days: RangeDays) => {
    setLoading(true)
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoading(false); return }
    const userId = session.user.id
    setUserId(userId)

    const end   = new Date()
    const start = new Date(end)
    start.setDate(start.getDate() - (days - 1))
    const startIso = isoDate(start)
    const endIso   = isoDate(end)

    // Build full date range (all days, even empty ones)
    const allDays: string[] = []
    const cur = new Date(start)
    while (isoDate(cur) <= endIso) { allDays.push(isoDate(cur)); cur.setDate(cur.getDate() + 1) }

    const dayMap = new Map<string, DayData>(
      allDays.map(d => [d, { date: d, graduated: 0, reviewed: 0, newCards: [] }])
    )

    // Graduated cards in range
    const { data: gradStates } = await supabase
      .from('card_states')
      .select('card_id, graduated_at')
      .eq('user_id', userId)
      .eq('graduated', true)
      .gte('graduated_at', startIso)
      .lte('graduated_at', endIso + 'T23:59:59Z')
    for (const s of gradStates ?? []) {
      const d = (s.graduated_at as string).slice(0, 10)
      if (dayMap.has(d)) dayMap.get(d)!.graduated++
    }

    // Due-mode reviews in range (distinct card_id per day)
    const { data: events } = await supabase
      .from('review_events')
      .select('card_id, reviewed_at')
      .eq('user_id', userId)
      .eq('review_mode', 'due')
      .gte('reviewed_at', startIso)
      .lte('reviewed_at', endIso + 'T23:59:59Z')
    // Count distinct cards per day
    const reviewedByDay = new Map<string, Set<string>>()
    for (const e of events ?? []) {
      const d = (e.reviewed_at as string).slice(0, 10)
      if (!reviewedByDay.has(d)) reviewedByDay.set(d, new Set())
      reviewedByDay.get(d)!.add(e.card_id as string)
    }
    for (const [d, cardIds] of reviewedByDay) {
      if (dayMap.has(d)) dayMap.get(d)!.reviewed = cardIds.size
    }

    // New cards introduced in range (for the list below the chart)
    const { data: introStates } = await supabase
      .from('card_states')
      .select('card_id, introduced_date')
      .eq('user_id', userId)
      .not('introduced_date', 'is', null)
      .gte('introduced_date', startIso)
      .lte('introduced_date', endIso)
    if (introStates?.length) {
      const cardIds = introStates.map(s => s.card_id as string)
      const { data: cards } = await supabase.from('cards').select('id, front, back').in('id', cardIds)
      const cardMap = new Map((cards ?? []).map(c => [c.id as string, c as { id: string; front: string; back: string }]))
      for (const s of introStates) {
        const d = (s.introduced_date as string).slice(0, 10)
        const card = cardMap.get(s.card_id as string)
        if (card && dayMap.has(d)) {
          dayMap.get(d)!.newCards.push({ front: displayText(card.front), back: displayText(card.back), cardId: card.id })
        }
      }
    }

    setData(allDays.map(d => dayMap.get(d)!))
    setExpanded(new Set([isoDate(new Date()), isoDate(new Date(Date.now() - 86400000))]))
    setLoading(false)
  }, [])

  useEffect(() => { void load(range) }, [range, load])

  const maxVal   = Math.max(...data.map(d => d.graduated + d.reviewed), 1)
  const chartH   = 180
  const hasAny   = data.some(d => d.graduated > 0 || d.reviewed > 0)

  const RANGES: { label: string; value: RangeDays }[] = [
    { label: '1W', value: 7  },
    { label: '2W', value: 14 },
    { label: '1M', value: 30 },
    { label: '3M', value: 90 },
  ]

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-semibold text-ink">Analytics</h1>
        <div className="flex items-center gap-1 bg-surface-raised rounded-card p-1">
          {RANGES.map(r => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                range === r.value
                  ? 'bg-accent text-white font-medium'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >{r.label}</button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-5 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-success/70 inline-block" />Graduated</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-accent/70 inline-block" />Reviews due</span>
      </div>

      {/* Chart */}
      <div className="relative select-none" onMouseLeave={() => setTooltip(null)}>
        {loading ? (
          <div style={{ height: chartH }} className="flex items-center justify-center text-ink-faint text-sm">Loading…</div>
        ) : !hasAny ? (
          <div style={{ height: chartH }} className="flex items-center justify-center text-ink-faint text-sm">No data for this period.</div>
        ) : (
          <div className="flex items-end gap-0.5 overflow-hidden" style={{ height: chartH }}>
            {data.map((day, i) => {
              const totalH  = ((day.graduated + day.reviewed) / maxVal) * chartH
              const gradH   = (day.graduated / maxVal) * chartH
              const revH    = (day.reviewed  / maxVal) * chartH
              const isEmpty = day.graduated === 0 && day.reviewed === 0

              // X-axis label: show every Nth bar so they don't overlap
              const labelEvery = range <= 14 ? 1 : range <= 30 ? 3 : 7
              const showLabel  = i % labelEvery === 0 || i === data.length - 1

              return (
                <div
                  key={day.date}
                  className="flex flex-col items-center flex-1 min-w-0 cursor-default"
                  style={{ height: chartH }}
                  onMouseEnter={e => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    const parent = (e.currentTarget as HTMLElement).closest('.relative')!.getBoundingClientRect()
                    setTooltip({ day, x: rect.left - parent.left + rect.width / 2, y: rect.top - parent.top })
                  }}
                >
                  {/* spacer pushes bars to bottom */}
                  <div className="flex-1" />
                  {/* stacked bar */}
                  <div className="w-full flex flex-col" style={{ height: totalH || (isEmpty ? 2 : 0) }}>
                    {day.reviewed > 0 && (
                      <div className="w-full bg-accent/70 rounded-t-sm" style={{ height: revH }} />
                    )}
                    {day.graduated > 0 && (
                      <div
                        className={`w-full bg-success/70 ${day.reviewed === 0 ? 'rounded-t-sm' : ''}`}
                        style={{ height: gradH }}
                      />
                    )}
                    {isEmpty && <div className="w-full bg-white/5 rounded-sm" style={{ height: 2 }} />}
                  </div>
                  {/* x-axis label */}
                  {showLabel && (
                    <span className="text-[9px] text-ink-faint mt-1 truncate w-full text-center leading-tight">
                      {labelDate(day.date, range)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Tooltip */}
        {tooltip && (
          <div
            className="absolute z-10 pointer-events-none bg-surface-raised border border-white/10 rounded-card shadow-lg px-3 py-2 text-xs space-y-0.5 w-44"
            style={{ left: Math.min(tooltip.x - 88, 9999), top: tooltip.y - 10, transform: 'translateY(-100%)' }}
          >
            <p className="font-medium text-ink">{fullDate(tooltip.day.date)}</p>
            <p className="text-success/80">Graduated: <span className="font-medium text-ink">{tooltip.day.graduated}</span></p>
            <p className="text-accent/80">Reviews due: <span className="font-medium text-ink">{tooltip.day.reviewed}</span></p>
            {tooltip.day.newCards.length > 0 && (
              <p className="text-ink-faint">New introduced: {tooltip.day.newCards.length}</p>
            )}
          </div>
        )}
      </div>

      {/* Connection graphs */}
      {userId && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Card connections</h2>
          <ConnectionGraph userId={userId} />
        </div>
      )}

      {/* Daily new cards list */}
      {data.filter(d => d.newCards.length > 0).length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">New cards introduced</h2>
          <div className="space-y-2">
            {[...data].reverse().filter(d => d.newCards.length > 0).map(day => {
              const open = expanded.has(day.date)
              return (
                <div key={day.date} className="rounded-card border border-white/10 overflow-hidden">
                  <button
                    onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(day.date) ? n.delete(day.date) : n.add(day.date); return n })}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-raised/40 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-ink">{fullDate(day.date)}</span>
                      <span className="text-xs text-ink-faint">{day.date}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="chip text-xs">{day.newCards.length} new</span>
                      <span className="text-ink-faint text-xs">{open ? '▲' : '▼'}</span>
                    </div>
                  </button>
                  {open && (
                    <div className="border-t border-white/10 divide-y divide-white/5">
                      {day.newCards.map(c => (
                        <div key={c.cardId} className="flex items-center gap-4 px-4 py-2.5">
                          <span className="text-sm font-medium text-ink w-40 truncate shrink-0">{c.front}</span>
                          <span className="text-sm text-ink-muted truncate">{c.back}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
