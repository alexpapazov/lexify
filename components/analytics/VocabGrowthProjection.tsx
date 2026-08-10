'use client'

/**
 * VocabGrowthProjection — "how big will my vocabulary get" for the Future tab. Each language starts
 * at its CURRENT graduated word count and grows by the GOAL SYSTEM's actual per-day intake — a
 * schedule's re-spread plan (which STOPS at its deadline, so the curve flattens there), a pattern
 * schedule's per-day capacity, or the weekday goals — with the combined daily ceiling capping the
 * cross-language sum. The old version drew `base + avgGoal · day` straight to the horizon, which
 * ignored deadlines entirely and quoted vocabulary sizes no goal actually asks for.
 *
 * Dashed markers show where a goal's deadline lands — the point a line goes flat. Without them the
 * plateau reads as a rendering bug rather than a goal being completed with nothing scheduled after.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseGoalScheduleRepository, progressForSchedules } from '@/lib/data/goalSchedules'
import { schedulePlan, dayCapacity, isPatternSchedule, eachDate, addScheduleDays } from '@/lib/goalSchedule'
import { applyDailyCeiling } from '@/lib/dailyCeiling'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { getToday } from '@/lib/dates'
import { langName, langFlag, assignLanguageColors } from '@/lib/languages'
import type { GoalSchedule } from '@/domain'

const HORIZON = 730   // 2 years
const PATH_STEP = 7   // days between drawn points — the curve bends at deadlines, so a line won't do
const W = 720, H = 280, mL = 44, mR = 12, mT = 12, mB = 26

interface Lang {
  code: string; label: string; flag: string
  /** Cumulative words known at each day offset, 0..HORIZON. */
  series: number[]
}
interface Marker { day: number; code: string; label: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function ordinal(n: number): string { const t = n % 100; if (t >= 11 && t <= 13) return `${n}th`; return `${n}${(['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}` }
function forecastDate(dayOffset: number): string {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset)
  return `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`
}
function shortForecastDate(dayOffset: number): string {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function VocabGrowthProjection() {
  const [langs, setLangs] = useState<Lang[] | null>(null)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [error, setError] = useState<string | null>(null)
  const [filterCode, setFilterCode] = useState<string | null>(null)
  const [langColors, setLangColors] = useState<Record<string, string>>({})
  const [hover, setHover] = useState<{ day: number; x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setError('Not signed in'); return }
        const uid = session.user.id

        // Widest select first, narrowing on error — `daily_word_ceiling` needs migration 116, and a
        // missing column errors the WHOLE query (the documented profiles landmine).
        let profRes = await supabase.from('profiles').select('language_colors, timezone, day_turnover_hour, daily_word_ceiling').eq('user_id', uid).maybeSingle()
        if (profRes.error) profRes = await supabase.from('profiles').select('language_colors, timezone, day_turnover_hour').eq('user_id', uid).maybeSingle()
        const prof = profRes.data as Record<string, unknown> | null
        if (!cancelled) setLangColors((prof?.language_colors as Record<string, string> | null) ?? {})
        const tz = (prof?.timezone as string | null) ?? deviceTimeZone()
        const turnover = (prof?.day_turnover_hour as number | null) ?? 0
        const wordCeiling = (prof?.daily_word_ceiling as number | null) ?? null
        const today = getToday(tz, turnover)

        const [decks, pairs, schedules] = await Promise.all([
          new SupabaseDeckRepository().list(uid),
          new SupabaseLanguagePairRepository().list(uid),
          new SupabaseGoalScheduleRepository().listActive(uid).catch(() => [] as GoalSchedule[]),
        ])
        const stateRepo = new SupabaseCardStateRepository()
        const [allStates, deckIdByCard] = await Promise.all([
          stateRepo.listAllForUser(uid),
          new SupabaseCardRepository().deckIdsByCard(decks.map(d => d.id)),
        ])
        const deckByCardDeck = new Map(decks.map(d => [d.id, d]))

        // Learned-now per source language = distinct graduated forward cards (dedupe shared cards).
        const gradByLang = new Map<string, Set<string>>()
        for (const s of allStates) {
          if (s.reviewDirection === 'reverse' || !s.graduated) continue
          const dId = deckIdByCard.get(s.cardId)
          const deck = dId ? deckByCardDeck.get(dId) : undefined
          if (!deck) continue
          const set = gradByLang.get(deck.sourceLanguage) ?? new Set<string>()
          set.add(s.cardId); gradByLang.set(deck.sourceLanguage, set)
        }

        // ── New-word intake per pair, day by day — same construction as the due-load forecast ──
        // A schedule OWNS its pair's intake (plan for a target — ZERO after the deadline; capacity
        // for a pattern); weekday goals otherwise, each weekday its own number. Then the combined
        // ceiling caps the cross-language sum, deferring overflow exactly as the goal surfaces do.
        const dates = eachDate(today, addScheduleDays(today, HORIZON))
        const dateIndex = new Map(dates.map((d, i) => [d, i]))
        const scheduleDone = schedules.length
          ? await progressForSchedules({ userId: uid, schedules, timezone: tz, turnoverHour: turnover }).catch(() => new Map<string, number>())
          : new Map<string, number>()

        const intakeByPair = new Map<string, Float64Array>()
        const marks: Marker[] = []
        for (const sc of schedules) {
          const key = `${sc.sourceLanguage}|${sc.targetLanguage}`
          const arr = new Float64Array(HORIZON + 1)
          if (isPatternSchedule(sc)) {
            dates.forEach((dt, i) => { const cap = dayCapacity(sc, dt); arr[i] = isFinite(cap) ? cap : 0 })
          } else {
            for (const day of schedulePlan(sc, today, scheduleDone.get(key) ?? 0)) {
              const i = dateIndex.get(day.date)
              if (i != null) arr[i] = day.words
            }
            const end = sc.deadline ? dateIndex.get(sc.deadline) : null
            if (end != null) {
              marks.push({ day: end, code: sc.sourceLanguage, label: `${langFlag(sc.sourceLanguage)} ${sc.name?.trim() || `${langName(sc.sourceLanguage)} goal`}` })
            }
          }
          intakeByPair.set(key, arr)
        }
        for (const pr of pairs) {
          const key = `${pr.sourceLanguage}|${pr.targetLanguage}`
          if (intakeByPair.has(key)) continue   // the schedule supersedes the weekday goals
          const g = pr.goals
          if (!g) continue
          const arr = new Float64Array(HORIZON + 1)
          let any = false
          dates.forEach((dt, i) => {
            const v = g[String(new Date(dt + 'T12:00:00Z').getUTCDay())] ?? 0
            if (v > 0) { arr[i] = v; any = true }
          })
          if (any) intakeByPair.set(key, arr)
        }
        if (wordCeiling && wordCeiling > 0 && intakeByPair.size > 0) {
          const demand = new Map([...intakeByPair].map(([k, arr]) => [k, new Map(dates.map((dt, i) => [dt, arr[i] ?? 0]))]))
          const capped = applyDailyCeiling({ dates, demand, ceiling: wordCeiling })
          for (const [k, arr] of intakeByPair) {
            arr.fill(0)
            for (const [dt, words] of capped.planned.get(k) ?? []) {
              const i = dateIndex.get(dt)
              if (i != null) arr[i] = words
            }
          }
        }

        // Sum pair intakes per SOURCE LANGUAGE (this chart is per language, not per pair), then
        // cumulate from today's learned count: series[d] = base + Σ intake[0..d].
        const intakeByLang = new Map<string, Float64Array>()
        for (const [k, arr] of intakeByPair) {
          const code = k.split('|')[0]!
          let sum = intakeByLang.get(code)
          if (!sum) { sum = new Float64Array(HORIZON + 1); intakeByLang.set(code, sum) }
          for (let d = 0; d <= HORIZON; d++) sum[d]! += arr[d]!
        }
        const codes = [...new Set([...gradByLang.keys(), ...intakeByLang.keys()])]
        const out: Lang[] = codes
          .map(code => {
            const base = gradByLang.get(code)?.size ?? 0
            const intake = intakeByLang.get(code)
            const series: number[] = new Array(HORIZON + 1)
            let running = base
            for (let d = 0; d <= HORIZON; d++) { running += intake?.[d] ?? 0; series[d] = running }
            return { code, label: langName(code), flag: langFlag(code), series }
          })
          .filter(l => (l.series[HORIZON] ?? 0) > 0)
          .sort((a, b) => (b.series[HORIZON] ?? 0) - (a.series[HORIZON] ?? 0))
        if (!cancelled) { setLangs(out); setMarkers(marks) }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const shown = useMemo(() => filterCode ? (langs ?? []).filter(l => l.code === filterCode) : (langs ?? []), [langs, filterCode])
  const valueAt = (l: Lang, day: number) => l.series[Math.max(0, Math.min(HORIZON, Math.round(day)))] ?? 0
  const maxY = useMemo(() => Math.max(10, ...shown.map(l => l.series[HORIZON] ?? 0)) * 1.08, [shown])
  const colorMap = useMemo(() => assignLanguageColors((langs ?? []).map(l => l.code), langColors), [langs, langColors])

  if (error) return <p className="text-sm text-danger">Couldn&apos;t build projection: {error}</p>
  if (!langs) return <p className="text-sm text-ink-faint">Building projection…</p>
  if (langs.length === 0) return <p className="text-sm text-ink-faint">No graduated words, goals or schedules yet — learn some cards or set goals in Settings → Daily goals.</p>

  const x = (day: number) => mL + (day / HORIZON) * (W - mL - mR)
  const y = (v: number) => H - mB - (v / maxY) * (H - mT - mB)
  const xTicks = [{ day: 0, label: 'now' }, { day: 182, label: '6 mo' }, { day: 365, label: '1 yr' }, { day: 547, label: '18 mo' }, { day: 730, label: '2 yr' }]
  const yTicks = 4
  const linePath = (l: Lang) => {
    const parts: string[] = []
    for (let d = 0; d <= HORIZON; d += PATH_STEP) parts.push(`${parts.length === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(valueAt(l, d)).toFixed(1)}`)
    parts.push(`L${x(HORIZON).toFixed(1)},${y(valueAt(l, HORIZON)).toFixed(1)}`)
    return parts.join(' ')
  }
  const shownMarkers = markers.filter(m => !filterCode || m.code === filterCode)

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = svgRef.current; if (!el) return
    const rect = el.getBoundingClientRect()
    // Map cursor into viewBox user units via the SVG's CTM — a plain rect.width ratio is wrong when
    // preserveAspectRatio letterboxes the drawing (w-full + maxHeight caps a wide chart and centres it).
    const _ctm = el.getScreenCTM()
    if (!_ctm) return
    const _pt = el.createSVGPoint(); _pt.x = e.clientX; _pt.y = e.clientY
    const relX = _pt.matrixTransform(_ctm.inverse()).x
    const day = Math.max(0, Math.min(HORIZON, ((relX - mL) / (W - mL - mR)) * HORIZON))
    setHover({ day, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  return (
    <div className="flex flex-col gap-2">
      {langs.length > 1 && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          <button onClick={() => setFilterCode(null)} className={`px-2 py-0.5 rounded-full border ${filterCode === null ? 'bg-accent/20 border-accent text-ink' : 'border-surface-border text-ink-muted hover:text-ink'}`}>All languages</button>
          {langs.map(l => (
            <button key={l.code} onClick={() => setFilterCode(l.code)}
              className={`px-2 py-0.5 rounded-full border inline-flex items-center gap-1.5 ${filterCode === l.code ? 'bg-accent/20 border-accent text-ink' : 'border-surface-border text-ink-muted hover:text-ink'}`}>
              <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: colorMap[l.code] }} />{l.flag} {l.label}
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 320 }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {Array.from({ length: yTicks + 1 }, (_, i) => {
            const v = (maxY / yTicks) * i
            return (
              <g key={i}>
                <line x1={mL} y1={y(v)} x2={W - 12} y2={y(v)} stroke="currentColor" className="text-surface-border" strokeWidth={1} opacity={0.4} />
                <text x={mL - 6} y={y(v) + 3} textAnchor="end" className="fill-ink-faint" fontSize={10}>{Math.round(v)}</text>
              </g>
            )
          })}
          {xTicks.map(tk => <text key={tk.day} x={x(tk.day)} y={H - mB + 16} textAnchor="middle" className="fill-ink-faint" fontSize={10}>{tk.label}</text>)}

          {/* Goal deadlines — where a line goes flat because its schedule ends. */}
          {shownMarkers.map((m, i) => {
            const color = colorMap[m.code] ?? '#888888'
            const anchorEnd = x(m.day) > W - 120
            return (
              <g key={`${m.code}-${m.day}`}>
                <line x1={x(m.day)} y1={mT} x2={x(m.day)} y2={H - mB} stroke={color} strokeWidth={1} strokeDasharray="5 4" opacity={0.7} />
                <text x={x(m.day) + (anchorEnd ? -4 : 4)} y={mT + 9 + (i % 3) * 11}
                  textAnchor={anchorEnd ? 'end' : 'start'} fontSize={9} fill={color}>
                  {`${m.label} · ${shortForecastDate(m.day)}`}
                </text>
              </g>
            )
          })}

          {hover && (
            <line x1={x(hover.day)} y1={mT} x2={x(hover.day)} y2={H - mB} stroke="currentColor" className="text-ink-faint" strokeWidth={1} opacity={0.5} strokeDasharray="3 3" />
          )}

          {shown.map(l => (
            <g key={l.code}>
              <path d={linePath(l)} fill="none" stroke={colorMap[l.code]} strokeWidth={2} />
              {hover && <circle cx={x(hover.day)} cy={y(valueAt(l, hover.day))} r={3} fill={colorMap[l.code]} />}
            </g>
          ))}
        </svg>

        {hover && (
          <div className="absolute pointer-events-none z-10 rounded-lg border border-surface-border bg-surface-raised/95 backdrop-blur px-3 py-2 shadow-lg text-[11px]"
            style={{ left: Math.min(hover.x + 12, 520), top: Math.max(4, hover.y - 40) }}>
            <div className="text-ink-muted text-center mb-1 pb-1 border-b border-surface-border">{forecastDate(Math.round(hover.day))}</div>
            <div className="flex flex-col gap-0.5">
              {shown.map(l => (
                <span key={l.code} className="flex items-center gap-1.5 text-ink-muted whitespace-nowrap">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colorMap[l.code] }} />
                  {l.flag} {l.label} <span className="text-ink font-medium">{Math.round(valueAt(l, hover.day))} words</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Milestone readouts */}
      <div className="grid grid-cols-3 gap-2 text-xs text-ink-muted mt-1">
        {[{ day: 182, label: '6 months' }, { day: 365, label: '1 year' }, { day: 730, label: '2 years' }].map(mk => {
          const total = shown.reduce((s, l) => s + valueAt(l, mk.day), 0)
          return (
            <div key={mk.day} className="rounded-lg border border-line/10 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-faint">In {mk.label}</div>
              <div className="text-sm text-ink font-semibold">{Math.round(total)} words</div>
            </div>
          )
        })}
      </div>

      <p className="text-[11px] text-ink-faint">
        Each language starts at the words you&apos;ve already learned and grows by your actual plan —
        a schedule&apos;s daily numbers up to its deadline (the line flattens there, marked with a
        dashed line), or your weekday goals, with the combined daily limit applied. It assumes you
        keep hitting the plan and keep adding cards to learn.
      </p>
    </div>
  )
}
