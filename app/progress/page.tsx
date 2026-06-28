'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { displayText } from '@/lib/cardText'
import { langName } from '@/lib/languages'
import { ConnectionGraph } from '@/components/analytics/ConnectionGraph'

type RangeDays = 7 | 14 | 30 | 90

interface LangCount {
  sourceLanguage: string
  targetLanguage: string
  count: number
}

interface DayData {
  date:      string        // YYYY-MM-DD
  graduated: LangCount[]  // per language pair
  reviewed:  number        // distinct graduated-card due reviews this day
  newCards:  { front: string; back: string; cardId: string }[]
}

function isoDate(d: Date) { return d.toISOString().slice(0, 10) }

function labelDate(iso: string, range: RangeDays) {
  const d = new Date(iso + 'T12:00:00')
  if (range <= 7)  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
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

function totalGrad(day: DayData) {
  return day.graduated.reduce((s, g) => s + g.count, 0)
}

// Palette for up to 10 language pairs — stable order, works on dark bg
const LANG_PALETTE = [
  '#6366f1', // indigo
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#84cc16', // lime
  '#ec4899', // pink
  '#14b8a6', // teal
]

export default function AnalyticsPage() {
  const [range,    setRange]    = useState<RangeDays>(30)
  const [data,     setData]     = useState<DayData[]>([])
  const [loading,  setLoading]  = useState(true)
  const [userId,   setUserId]   = useState<string | null>(null)
  const [tooltip,  setTooltip]  = useState<{ day: DayData; x: number; y: number } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async (days: RangeDays) => {
    setLoading(true)
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoading(false); return }
    const uid = session.user.id
    setUserId(uid)

    const end   = new Date()
    const start = new Date(end)
    start.setDate(start.getDate() - (days - 1))
    const startIso = isoDate(start)
    const endIso   = isoDate(end)

    // Build full date range with empty placeholders
    const allDays: string[] = []
    const cur = new Date(start)
    while (isoDate(cur) <= endIso) { allDays.push(isoDate(cur)); cur.setDate(cur.getDate() + 1) }

    const dayMap = new Map<string, DayData>(
      allDays.map(d => [d, { date: d, graduated: [], reviewed: 0, newCards: [] }])
    )

    // Graduated cards — join cards table to get language pair
    const { data: gradStates } = await supabase
      .from('card_states')
      .select('graduated_at, cards(source_language, target_language)')
      .eq('user_id', uid)
      .eq('graduated', true)
      .gte('graduated_at', startIso)
      .lte('graduated_at', endIso + 'T23:59:59Z')

    for (const s of gradStates ?? []) {
      const d = (s.graduated_at as string).slice(0, 10)
      if (!dayMap.has(d)) continue
      const card = s.cards as unknown as { source_language: string | null; target_language: string | null } | null
      const src  = card?.source_language ?? 'unknown'
      const tgt  = card?.target_language ?? 'unknown'
      const day  = dayMap.get(d)!
      const existing = day.graduated.find(g => g.sourceLanguage === src && g.targetLanguage === tgt)
      if (existing) existing.count++
      else day.graduated.push({ sourceLanguage: src, targetLanguage: tgt, count: 1 })
    }

    // Due-mode reviews — distinct card per day
    const { data: events } = await supabase
      .from('review_events')
      .select('card_id, reviewed_at')
      .eq('user_id', uid)
      .eq('review_mode', 'due')
      .gte('reviewed_at', startIso)
      .lte('reviewed_at', endIso + 'T23:59:59Z')
    const reviewedByDay = new Map<string, Set<string>>()
    for (const e of events ?? []) {
      const d = (e.reviewed_at as string).slice(0, 10)
      if (!reviewedByDay.has(d)) reviewedByDay.set(d, new Set())
      reviewedByDay.get(d)!.add(e.card_id as string)
    }
    for (const [d, ids] of reviewedByDay) {
      if (dayMap.has(d)) dayMap.get(d)!.reviewed = ids.size
    }

    // New cards introduced — for the list section below the chart
    const { data: introStates } = await supabase
      .from('card_states')
      .select('card_id, introduced_date')
      .eq('user_id', uid)
      .not('introduced_date', 'is', null)
      .gte('introduced_date', startIso)
      .lte('introduced_date', endIso)
    if (introStates?.length) {
      const cardIds = introStates.map(s => s.card_id as string)
      const { data: cards } = await supabase.from('cards').select('id, front, back').in('id', cardIds)
      const cardMap = new Map((cards ?? []).map(c => [c.id as string, c as { id: string; front: string; back: string }]))
      for (const s of introStates) {
        const d    = (s.introduced_date as string).slice(0, 10)
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

  // Build stable language-pair → color mapping from all data
  const langColorMap = useMemo(() => {
    const keys = [...new Set(
      data.flatMap(d => d.graduated.map(g => `${g.sourceLanguage}|${g.targetLanguage}`))
    )]
    return new Map(keys.map((k, i) => [k, LANG_PALETTE[i % LANG_PALETTE.length]!]))
  }, [data])

  const chartH  = 160
  const maxVal  = Math.max(...data.map(d => totalGrad(d) + d.reviewed), 1)
  const hasAny  = data.some(d => totalGrad(d) > 0 || d.reviewed > 0)

  const RANGES: { label: string; value: RangeDays }[] = [
    { label: '1W', value: 7  },
    { label: '2W', value: 14 },
    { label: '1M', value: 30 },
    { label: '3M', value: 90 },
  ]

  const langPairLabel = (src: string, tgt: string) =>
    `${langName(src)} → ${langName(tgt)}`

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

      {/* Legend — per language pair + reviews */}
      <div className="flex items-center gap-4 text-xs text-ink-muted flex-wrap">
        {[...langColorMap.entries()].map(([key, color]) => {
          const [src, tgt] = key.split('|') as [string, string]
          return (
            <span key={key} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block" style={{ background: color }} />
              {langPairLabel(src, tgt)}
            </span>
          )
        })}
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-accent/70 inline-block" />
          Reviews due
        </span>
      </div>

      {/* Chart */}
      <div className="relative select-none" onMouseLeave={() => setTooltip(null)}>
        {loading ? (
          <div style={{ height: chartH + 36 }} className="flex items-center justify-center text-ink-faint text-sm">Loading…</div>
        ) : !hasAny ? (
          <div style={{ height: chartH + 36 }} className="flex items-center justify-center text-ink-faint text-sm">No data for this period.</div>
        ) : (
          <div className="flex flex-col">
            {/* Bar area */}
            <div className="flex items-end gap-0.5" style={{ height: chartH }}>
              {data.map((day, i) => {
                const grad    = totalGrad(day)
                const total   = grad + day.reviewed
                const totalH  = (total / maxVal) * chartH
                const gradH   = (grad / maxVal) * chartH
                const revH    = (day.reviewed / maxVal) * chartH
                const isEmpty = total === 0

                return (
                  <div
                    key={day.date}
                    className="flex flex-col justify-end flex-1 min-w-0 h-full cursor-default"
                    onMouseEnter={e => {
                      const rect   = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      const parent = (e.currentTarget as HTMLElement).closest('.relative')!.getBoundingClientRect()
                      setTooltip({ day, x: rect.left - parent.left + rect.width / 2, y: rect.top - parent.top })
                    }}
                  >
                    <div className="w-full flex flex-col" style={{ height: totalH || (isEmpty ? 2 : 0) }}>
                      {/* Reviews due — top segment */}
                      {day.reviewed > 0 && (
                        <div className="w-full bg-accent/70 rounded-t-sm shrink-0" style={{ height: revH }} />
                      )}
                      {/* Graduated — stacked language segments */}
                      {grad > 0 && (() => {
                        const segments = day.graduated.filter(g => g.count > 0)
                        return (
                          <div
                            className={`w-full flex flex-col ${day.reviewed === 0 ? 'rounded-t-sm' : ''} overflow-hidden`}
                            style={{ height: gradH }}
                          >
                            {segments.map((g, si) => {
                              const segH = (g.count / grad) * gradH
                              const color = langColorMap.get(`${g.sourceLanguage}|${g.targetLanguage}`) ?? LANG_PALETTE[0]!
                              return (
                                <div
                                  key={si}
                                  className="w-full shrink-0"
                                  style={{ height: segH, background: color + 'b3' /* ~70% opacity */ }}
                                />
                              )
                            })}
                          </div>
                        )
                      })()}
                      {isEmpty && <div className="w-full bg-white/5 rounded-sm" style={{ height: 2 }} />}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* X-axis labels — vertical text avoids overlap at any density */}
            <div className="flex gap-0.5 mt-1" style={{ height: 36 }}>
              {data.map((day, i) => {
                const labelEvery = range <= 14 ? 1 : range <= 30 ? 3 : 7
                const showLabel  = i % labelEvery === 0 || i === data.length - 1
                return (
                  <div key={day.date} className="flex-1 min-w-0 flex justify-center items-start overflow-visible">
                    {showLabel && (
                      <span
                        className="text-[9px] text-ink-faint leading-none whitespace-nowrap"
                        style={{
                          writingMode: 'vertical-rl',
                          transform:   'rotate(180deg)',
                          display:     'block',
                          maxHeight:   34,
                        }}
                      >
                        {labelDate(day.date, range)}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Hover tooltip */}
        {tooltip && (
          <div
            className="absolute z-10 pointer-events-none bg-surface-raised border border-white/10 rounded-card shadow-lg px-3 py-2 text-xs space-y-1 w-48"
            style={{ left: Math.min(Math.max(tooltip.x - 96, 0), 9999), top: tooltip.y - 10, transform: 'translateY(-100%)' }}
          >
            <p className="font-medium text-ink">{fullDate(tooltip.day.date)}</p>
            {tooltip.day.graduated.map(g => {
              const color = langColorMap.get(`${g.sourceLanguage}|${g.targetLanguage}`) ?? LANG_PALETTE[0]!
              return (
                <p key={`${g.sourceLanguage}|${g.targetLanguage}`} className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm inline-block shrink-0" style={{ background: color }} />
                  <span className="text-ink-muted">{langPairLabel(g.sourceLanguage, g.targetLanguage)}:</span>
                  <span className="font-medium text-ink ml-auto">{g.count}</span>
                </p>
              )
            })}
            {tooltip.day.reviewed > 0 && (
              <p className="text-accent/80">Reviews due: <span className="font-medium text-ink">{tooltip.day.reviewed}</span></p>
            )}
            {tooltip.day.newCards.length > 0 && (
              <p className="text-ink-faint">New introduced: {tooltip.day.newCards.length}</p>
            )}
          </div>
        )}
      </div>

      {/* Connection graph */}
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
                    onClick={() => setExpanded(prev => {
                      const n = new Set(prev)
                      n.has(day.date) ? n.delete(day.date) : n.add(day.date)
                      return n
                    })}
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
