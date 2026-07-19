'use client'

/**
 * ReviewCalendar — a month grid of study history. Each active day shows the date in its top-left, a
 * ring whose colored segments are the relative distribution of that day's cards across languages, and
 * a centered percentage = cards done that day ÷ that weekday's summed daily goal (can exceed 100%).
 *
 * Percentage color:
 *   < 50%            → red
 *   50%–<100%        → yellow
 *   ≥ 100%           → green ONLY if every language also individually met its own daily goal for that
 *                      weekday; otherwise yellow (you hit the total but skewed the mix).
 *
 * "Done that day" = cards graduated that day per language (the same metric the dashboard's Today's
 * goals uses). Navigation spans [first day with data … today]; out-of-range days are greyed out.
 */
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { langName, LANG_COLOR_PALETTE } from '@/lib/languages'
import { localDateWithTurnover, getToday } from '@/lib/dates'
import { DayDetailModal } from '@/components/analytics/DayDetailModal'
import type { LanguagePair } from '@/domain'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** YYYY-MM-DD for a given year/month(0-based)/day. */
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const weekdayOf = (dateStr: string) => new Date(dateStr + 'T12:00:00Z').getUTCDay()

interface DayInfo { counts: Map<string, number>; total: number }

export function ReviewCalendar() {
  const [byDay, setByDay] = useState<Map<string, DayInfo>>(new Map())
  const [pairs, setPairs] = useState<LanguagePair[]>([])
  const [minDate, setMinDate] = useState<string | null>(null)
  const [todayStr, setTodayStr] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [tz, setTz] = useState('UTC')
  const [turnover, setTurnover] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  // Displayed month (year, month 0-based)
  const [view, setView] = useState<{ y: number; m: number } | null>(null)

  useEffect(() => {
    ;(async () => {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setLoading(false); return }
      const uid = session.user.id

      const { data: profile } = await supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', uid).single()
      const tzv = (profile?.timezone as string | null) ?? 'UTC'
      const turnoverv = (profile?.day_turnover_hour as number | null) ?? 0
      const today = getToday(tzv, turnoverv)
      setTz(tzv); setTurnover(turnoverv)

      const [{ data: grads }, pairList] = await Promise.all([
        supabase.from('card_states')
          .select('graduated_at, cards(source_language, target_language)')
          .eq('user_id', uid).eq('graduated', true).neq('review_direction', 'reverse')
          .not('graduated_at', 'is', null),
        new SupabaseLanguagePairRepository().list(uid),
      ])

      const map = new Map<string, DayInfo>()
      let earliest: string | null = null
      for (const s of grads ?? []) {
        const card = s.cards as unknown as { source_language: string | null; target_language: string | null } | null
        if (!card?.source_language || !card?.target_language) continue
        const d = localDateWithTurnover(s.graduated_at as string, tzv, turnoverv)
        if (d > today) continue
        if (!earliest || d < earliest) earliest = d
        const key = `${card.source_language}|${card.target_language}`
        let info = map.get(d)
        if (!info) { info = { counts: new Map(), total: 0 }; map.set(d, info) }
        info.counts.set(key, (info.counts.get(key) ?? 0) + 1)
        info.total++
      }

      setByDay(map)
      setPairs(pairList)
      setMinDate(earliest)
      setTodayStr(today)
      const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1]
      setView({ y: ty, m: tm })
      setLoading(false)
    })()
  }, [])

  // Stable color per language-pair key.
  const colorFor = useMemo(() => {
    const keys = [...new Set(pairs.map(p => `${p.sourceLanguage}|${p.targetLanguage}`))].sort()
    const m = new Map(keys.map((k, i) => [k, LANG_COLOR_PALETTE[i % LANG_COLOR_PALETTE.length]!]))
    return (key: string) => m.get(key) ?? '#64748b'
  }, [pairs])

  const goalsByWeekday = useMemo(() => {
    // weekday → Map<pairKey, goal>
    const out = new Map<number, Map<string, number>>()
    for (let wd = 0; wd < 7; wd++) {
      const g = new Map<string, number>()
      for (const p of pairs) {
        const goal = p.goals?.[String(wd)]
        if (typeof goal === 'number' && goal > 0) g.set(`${p.sourceLanguage}|${p.targetLanguage}`, goal)
      }
      out.set(wd, g)
    }
    return out
  }, [pairs])

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>
  if (!view || !minDate) {
    return <p className="text-sm text-ink-muted">No study history yet — graduate some cards and they&apos;ll appear here.</p>
  }

  const { y, m } = view
  const firstWeekday = new Date(Date.UTC(y, m, 1)).getUTCDay()
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

  const canPrev = iso(y, m, 1) > minDate
  const canNext = iso(y, m, daysInMonth) < todayStr
  const step = (delta: number) => {
    const nm = m + delta
    setView({ y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 })
  }

  // Build the cell list (leading blanks + days).
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={() => step(-1)} disabled={!canPrev}
          className="px-3 py-1.5 rounded-md text-sm text-ink-muted hover:text-ink hover:bg-surface-raised disabled:opacity-30 disabled:hover:bg-transparent transition-colors">← Prev</button>
        <div className="text-sm font-semibold text-ink">{MONTHS[m]} {y}</div>
        <button onClick={() => step(1)} disabled={!canNext}
          className="px-3 py-1.5 rounded-md text-sm text-ink-muted hover:text-ink hover:bg-surface-raised disabled:opacity-30 disabled:hover:bg-transparent transition-colors">Next →</button>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map(w => <div key={w} className="text-center text-[11px] font-medium text-ink-faint uppercase tracking-wide">{w}</div>)}
        {cells.map((day, i) => {
          if (day === null) return <div key={`b${i}`} />
          const date = iso(y, m, day)
          const active = date >= minDate && date <= todayStr
          if (!active) {
            return (
              <div key={date} className="aspect-square rounded-lg border border-line/5 bg-surface-deep/40 p-1.5 opacity-40">
                <span className="text-[11px] text-ink-faint">{day}</span>
              </div>
            )
          }
          return <DayCell key={date} day={day} date={date} info={byDay.get(date)} goals={goalsByWeekday.get(weekdayOf(date))!} colorFor={colorFor} onSelect={setSelected} />
        })}
      </div>

      {/* Legend */}
      {pairs.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
          {[...new Set(pairs.map(p => `${p.sourceLanguage}|${p.targetLanguage}`))].sort().map(key => {
            const [src, tgt] = key.split('|') as [string, string]
            return (
              <div key={key} className="flex items-center gap-1.5 text-xs text-ink-muted">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colorFor(key) }} />
                {langName(src)} → {langName(tgt)}
              </div>
            )
          })}
        </div>
      )}

      {selected && <DayDetailModal date={selected} tz={tz} turnover={turnover} onClose={() => setSelected(null)} />}
    </div>
  )
}

function DayCell({ day, date, info, goals, colorFor, onSelect }: {
  day: number; date: string; info: DayInfo | undefined
  goals: Map<string, number>; colorFor: (k: string) => string
  onSelect: (date: string) => void
}) {
  const total = info?.total ?? 0
  const totalGoal = [...goals.values()].reduce((a, b) => a + b, 0)

  // Percentage of the day's summed goal.
  const pct = totalGoal > 0 ? Math.round((total / totalGoal) * 100) : null
  const allIndividualMet = [...goals.entries()].every(([key, g]) => (info?.counts.get(key) ?? 0) >= g)

  let pctColor = 'text-ink-faint'
  if (pct !== null) {
    if (pct < 50) pctColor = 'text-danger'
    else if (pct < 100) pctColor = 'text-warning'
    else pctColor = allIndividualMet ? 'text-success' : 'text-warning'
  }

  // Ring: conic-gradient of language segments by share of the day's total.
  let ring = 'transparent'
  if (total > 0 && info) {
    let acc = 0
    const stops: string[] = []
    for (const [key, count] of info.counts) {
      const start = (acc / total) * 100
      acc += count
      const end = (acc / total) * 100
      stops.push(`${colorFor(key)} ${start}% ${end}%`)
    }
    ring = `conic-gradient(${stops.join(', ')})`
  }

  return (
    <button
      onClick={() => onSelect(date)}
      className="aspect-square rounded-lg border border-line/10 bg-surface-raised/40 p-1.5 flex flex-col text-left hover:border-accent/40 hover:bg-surface-raised/70 transition-colors"
    >
      <div className="flex items-start justify-between leading-none">
        <span className="text-[11px] text-ink-muted">{day}</span>
        {total > 0 && <span className="text-[10px] font-semibold text-accent-soft">{total}</span>}
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="relative rounded-full" style={{ width: 'min(94%, 76px)', aspectRatio: '1', background: ring }}>
          <div className="absolute inset-[26%] rounded-full bg-surface-deep flex items-center justify-center">
            <span className={`text-[11px] sm:text-sm font-semibold ${pctColor}`}>
              {pct !== null ? `${pct}%` : (total > 0 ? total : '')}
            </span>
          </div>
        </div>
      </div>
    </button>
  )
}
