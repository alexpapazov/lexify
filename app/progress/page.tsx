'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { displayText } from '@/lib/cardText'
import { langName, LANG_COLOR_PALETTE } from '@/lib/languages'
import { ConnectionGraph } from '@/components/analytics/ConnectionGraph'
import { DueForecastProjection } from '@/components/analytics/DueForecastProjection'
import { getToday } from '@/lib/dates'

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
  lapses:    number        // reviews that ungraduated a card back into the learning pipeline
  newCards:  { front: string; back: string; cardId: string }[]
}

function isoDate(d: Date) { return d.toISOString().slice(0, 10) }

/**
 * Converts a UTC ISO timestamp to a YYYY-MM-DD string in the user's timezone,
 * adjusted for the day turnover hour (same logic as getToday / snapDueAtToStartOfDay).
 */
function localDateWithTurnover(isoTs: string, tz: string, turnoverHour: number): string {
  const date  = new Date(isoTs)
  const local = new Date(date.toLocaleString('en-US', { timeZone: tz }))
  if (local.getHours() < turnoverHour) local.setDate(local.getDate() - 1)
  const y = local.getFullYear()
  const m = String(local.getMonth() + 1).padStart(2, '0')
  const d = String(local.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function labelDate(iso: string, range: RangeDays) {
  const d = new Date(iso + 'T12:00:00')
  if (range <= 7)  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  if (range <= 14) return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  if (range <= 30) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fullDate(iso: string, todayStr: string, yesterdayStr: string) {
  if (iso === todayStr)     return 'Today'
  if (iso === yesterdayStr) return 'Yesterday'
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

function totalGrad(day: DayData) {
  return day.graduated.reduce((s, g) => s + g.count, 0)
}

// 12 preset swatches for the color picker popover — the shared LexiCard categorical set.
const PRESET_COLORS = LANG_COLOR_PALETTE

const DEFAULT_REVIEWS_COLOR = '#4A4BD8' // primary
const DEFAULT_LAPSES_COLOR  = '#F05068' // danger

// Per-language-pair series colors — the same shared categorical set (stable order, dark-legible).
const LANG_PALETTE = LANG_COLOR_PALETTE

export default function AnalyticsPage() {
  const [range,        setRange]        = useState<RangeDays>(30)
  const [data,         setData]         = useState<DayData[]>([])
  const [loading,      setLoading]      = useState(true)
  const [userId,       setUserId]       = useState<string | null>(null)
  const [tooltip,      setTooltip]      = useState<{ day: DayData; x: number; y: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set())
  const [todayStr,     setTodayStr]     = useState(() => isoDate(new Date()))
  const [yesterdayStr, setYesterdayStr] = useState(() => isoDate(new Date(Date.now() - 86400000)))
  const [customColors, setCustomColors] = useState<Map<string, string>>(() => {
    try {
      const stored = localStorage.getItem('lexify-lang-colors')
      return stored ? new Map(JSON.parse(stored) as [string, string][]) : new Map()
    } catch { return new Map() }
  })
  const [pickerOpen, setPickerOpen] = useState<string | null>(null)

  useEffect(() => {
    if (!pickerOpen) return
    function handleMouseDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('[data-color-picker]')) setPickerOpen(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [pickerOpen])

  const load = useCallback(async (days: RangeDays) => {
    setLoading(true)
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoading(false); return }
    const uid = session.user.id
    setUserId(uid)

    // Load profile settings so we can bucket timestamps into the correct calendar day.
    const { data: profile } = await supabase
      .from('profiles')
      .select('timezone, day_turnover_hour')
      .eq('user_id', uid)
      .single()
    const tz           = (profile?.timezone as string | null) ?? 'UTC'
    const turnoverHour = (profile?.day_turnover_hour as number | null) ?? 0

    // Turnover-aware "today" and "yesterday"
    const today     = getToday(tz, turnoverHour)
    const yesterday = localDateWithTurnover(
      new Date(Date.now() - 86400000).toISOString(), tz, turnoverHour
    )
    setTodayStr(today)
    setYesterdayStr(yesterday)

    // Build full date range ending at today (turnover-aware)
    const allDays: string[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(new Date(today + 'T12:00:00Z').getTime() - i * 86400000)
      allDays.push(d.toISOString().slice(0, 10))
    }
    const startIso = allDays[0]!
    const endIso   = allDays[allDays.length - 1]!

    const dayMap = new Map<string, DayData>(
      allDays.map(d => [d, { date: d, graduated: [], reviewed: 0, lapses: 0, newCards: [] }])
    )

    // Over-fetch by 1 day on the start side and 2 days on the end side so
    // turnover boundaries and negative-UTC offsets are always covered.
    // A UTC-12 user's local midnight falls 12 h into the next UTC day, so
    // +1 day would silently drop evening graduations — +2 days is safe for
    // any timezone.  localDateWithTurnover buckets each row into the correct
    // study day, so extra rows from "tomorrow" are simply skipped.
    const queryStart = new Date(new Date(startIso + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10)
    const queryEnd   = new Date(new Date(endIso   + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString()

    // Graduated cards — join cards table to get language pair.
    // Skip cards with null language fields (deleted or incomplete cards).
    const { data: gradStates } = await supabase
      .from('card_states')
      .select('graduated_at, cards(source_language, target_language)')
      .eq('user_id', uid)
      .eq('graduated', true)
      .neq('review_direction', 'reverse')
      .gte('graduated_at', queryStart)
      .lte('graduated_at', queryEnd)

    for (const s of gradStates ?? []) {
      const card = s.cards as unknown as { source_language: string | null; target_language: string | null } | null
      if (!card?.source_language || !card?.target_language) continue
      const d = localDateWithTurnover(s.graduated_at as string, tz, turnoverHour)
      if (!dayMap.has(d)) continue
      const src = card.source_language
      const tgt = card.target_language
      const day = dayMap.get(d)!
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
      .gte('reviewed_at', queryStart)
      .lte('reviewed_at', queryEnd)
    const reviewedByDay = new Map<string, Set<string>>()
    for (const e of events ?? []) {
      const d = localDateWithTurnover(e.reviewed_at as string, tz, turnoverHour)
      if (!reviewedByDay.has(d)) reviewedByDay.set(d, new Set())
      reviewedByDay.get(d)!.add(e.card_id as string)
    }
    for (const [d, ids] of reviewedByDay) {
      if (dayMap.has(d)) dayMap.get(d)!.reviewed = ids.size
    }

    // Lapses — reviews that sent a graduated card back into the learning pipeline
    const { data: lapseEvents } = await supabase
      .from('review_events')
      .select('reviewed_at')
      .eq('user_id', uid)
      .eq('lapsed', true)
      .gte('reviewed_at', queryStart)
      .lte('reviewed_at', queryEnd)
    for (const e of lapseEvents ?? []) {
      const d = localDateWithTurnover(e.reviewed_at as string, tz, turnoverHour)
      if (dayMap.has(d)) dayMap.get(d)!.lapses++
    }

    // New cards introduced — introduced_date is already stored as a turnover-aware YYYY-MM-DD
    const { data: introStates } = await supabase
      .from('card_states')
      .select('card_id, introduced_date')
      .eq('user_id', uid)
      .neq('review_direction', 'reverse')
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
    setExpanded(new Set([today, yesterday]))
    setLoading(false)
  }, [])

  useEffect(() => { void load(range) }, [range, load])

  // Re-fetch when the tab becomes visible so studying in another tab/window
  // is reflected without requiring a manual page refresh.
  useEffect(() => {
    function onVisible() { if (document.visibilityState === 'visible') void load(range) }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [range, load])

  function setColor(key: string, color: string) {
    setCustomColors(prev => {
      const next = new Map(prev)
      next.set(key, color)
      try { localStorage.setItem('lexify-lang-colors', JSON.stringify([...next])) } catch {}
      return next
    })
  }

  const reviewsColor = customColors.get('__reviews__') ?? DEFAULT_REVIEWS_COLOR
  const lapsesColor  = customColors.get('__lapses__')  ?? DEFAULT_LAPSES_COLOR

  function renderSwatch(colorKey: string, displayColor: string, label: string) {
    const isOpen = pickerOpen === colorKey
    return (
      <span key={colorKey} className="flex items-center gap-1.5 relative" data-color-picker>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); setPickerOpen(isOpen ? null : colorKey) }}
          className="w-3 h-3 rounded-sm flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-ink/40 transition-shadow"
          style={{ background: displayColor }}
          title="Click to change color"
        />
        <span className="text-xs text-ink-muted select-none">{label}</span>
        {isOpen && (
          <div className="absolute bottom-full left-0 mb-2 bg-surface-raised border border-line/10 rounded-card p-2 z-50 shadow-lg">
            <div className="grid grid-cols-6 gap-1 mb-2">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setColor(colorKey, c); setPickerOpen(null) }}
                  className="w-4 h-4 rounded-sm cursor-pointer hover:scale-110 transition-transform"
                  style={{
                    background: c,
                    outline: c === displayColor ? '2px solid white' : 'none',
                    outlineOffset: '1px',
                  }}
                />
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer pt-1 border-t border-line/10">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(displayColor) ? displayColor : '#4A4BD8'}
                onChange={e => setColor(colorKey, e.target.value)}
                className="w-4 h-4 cursor-pointer rounded-sm border-0 p-0"
              />
              Custom
            </label>
          </div>
        )}
      </span>
    )
  }

  // Build stable language-pair → color mapping from all data, with custom overrides
  const langColorMap = useMemo(() => {
    const keys = [...new Set(
      data.flatMap(d => d.graduated.map(g => `${g.sourceLanguage}|${g.targetLanguage}`))
    )]
    return new Map(keys.map((k, i) => [k, customColors.get(k) ?? LANG_PALETTE[i % LANG_PALETTE.length]!]))
  }, [data, customColors])

  const chartH  = 160
  const maxVal  = Math.max(...data.map(d => totalGrad(d) + d.reviewed + d.lapses), 1)
  const hasAny  = data.some(d => totalGrad(d) > 0 || d.reviewed > 0 || d.lapses > 0)

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
      <h1 className="text-2xl font-semibold text-ink">Analytics</h1>

      {/* Forward projection: Due Now load over the next 2 years */}
      <div className="panel p-5 space-y-3" data-tour="projected-due">
        <div>
          <h2 className="text-sm font-semibold text-ink">Projected Due Now load</h2>
          <p className="text-xs text-ink-faint">Your existing cards plus new cards from your daily goals, simulated on the FSRS model by Monte Carlo per language — each language&apos;s measured initial interval, average difficulty, and rating mix (again/hard/good/easy). Every card is played forward many times, drawing a real rating each review; the lines are the average and the shaded band is the p10–p90 range. New-card intake is capped at each language&apos;s remaining cards. Split into typed, self-graded (recall + smart-typing past its threshold), and reverse recognition.</p>
        </div>
        <DueForecastProjection />
      </div>

      {/* Daily review history — this is what the range toggle controls */}
      <div className="flex items-center justify-between flex-wrap gap-3 pt-2">
        <h2 className="text-sm font-semibold text-ink">Daily review history</h2>
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

      {/* Legend — per language pair + reviews + lapses, all color-pickable */}
      <div className="flex items-center gap-4 flex-wrap">
        {[...langColorMap.entries()].map(([key, color]) => {
          const [src, tgt] = key.split('|') as [string, string]
          return renderSwatch(key, color, langPairLabel(src, tgt))
        })}
        {renderSwatch('__reviews__', reviewsColor, 'Reviews due')}
        {renderSwatch('__lapses__', lapsesColor, 'Lapsed (back to learning)')}
      </div>

      {/* Chart */}
      <div ref={chartRef} className="relative select-none" onMouseLeave={() => setTooltip(null)} onClick={() => setTooltip(null)}>
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
                const total   = grad + day.reviewed + day.lapses
                const totalH  = (total / maxVal) * chartH
                const gradH   = (grad / maxVal) * chartH
                const revH    = (day.reviewed / maxVal) * chartH
                const lapseH  = (day.lapses / maxVal) * chartH
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
                    onClick={e => {
                      e.stopPropagation()
                      if (tooltip?.day.date === day.date) { setTooltip(null); return }
                      const rect   = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      const parent = (e.currentTarget as HTMLElement).closest('.relative')!.getBoundingClientRect()
                      setTooltip({ day, x: rect.left - parent.left + rect.width / 2, y: rect.top - parent.top })
                    }}
                  >
                    <div className="w-full flex flex-col" style={{ height: totalH || (isEmpty ? 2 : 0) }}>
                      {/* Reviews due — top segment */}
                      {day.reviewed > 0 && (
                        <div className="w-full rounded-t-sm shrink-0" style={{ height: revH, background: reviewsColor + 'b3' }} />
                      )}
                      {/* Lapses — sent back to learning pipeline */}
                      {day.lapses > 0 && (
                        <div
                          className={`w-full shrink-0 ${day.reviewed === 0 ? 'rounded-t-sm' : ''}`}
                          style={{ height: lapseH, background: lapsesColor + 'b3' }}
                        />
                      )}
                      {/* Graduated — stacked language segments */}
                      {grad > 0 && (() => {
                        const segments = day.graduated.filter(g => g.count > 0)
                        return (
                          <div
                            className={`w-full flex flex-col ${day.reviewed === 0 && day.lapses === 0 ? 'rounded-t-sm' : ''} overflow-hidden`}
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
                      {isEmpty && <div className="w-full bg-line/5 rounded-sm" style={{ height: 2 }} />}
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
        {tooltip && (() => {
          const tooltipW   = 192 // w-48
          const chartWidth = chartRef.current?.offsetWidth ?? 9999
          const clampedLeft = Math.min(Math.max(tooltip.x - tooltipW / 2, 4), chartWidth - tooltipW - 4)
          return (
          <div
            className="absolute z-10 pointer-events-none bg-surface-raised border border-line/10 rounded-card shadow-lg px-3 py-2 text-xs space-y-1 w-48"
            style={{ left: clampedLeft, top: tooltip.y - 10, transform: 'translateY(-100%)' }}
          >
            <p className="font-medium text-ink">{fullDate(tooltip.day.date, todayStr, yesterdayStr)}</p>
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
            {tooltip.day.lapses > 0 && (
              <p style={{ color: '#F05068' }}>Lapsed: <span className="font-medium text-ink">{tooltip.day.lapses}</span></p>
            )}
            {tooltip.day.newCards.length > 0 && (
              <p className="text-ink-faint">New introduced: {tooltip.day.newCards.length}</p>
            )}
          </div>
          )
        })()}
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
                <div key={day.date} className="rounded-card border border-line/10 overflow-hidden">
                  <button
                    onClick={() => setExpanded(prev => {
                      const n = new Set(prev)
                      n.has(day.date) ? n.delete(day.date) : n.add(day.date)
                      return n
                    })}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-raised/40 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-ink">{fullDate(day.date, todayStr, yesterdayStr)}</span>
                      <span className="hidden sm:inline text-xs text-ink-faint">{day.date}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="chip text-xs">{day.newCards.length} new</span>
                      <span className="text-ink-faint text-xs">{open ? '▲' : '▼'}</span>
                    </div>
                  </button>
                  {open && (
                    <div className="border-t border-line/10 divide-y divide-line/5">
                      {day.newCards.map(c => (
                        <div key={c.cardId} className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-4 px-4 py-2.5">
                          <span className="text-sm font-medium text-ink sm:w-40 truncate sm:shrink-0">{c.front}</span>
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
