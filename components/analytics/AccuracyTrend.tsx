'use client'

/**
 * AccuracyTrend — "% correct over time", one line per language, in Analytics → Present.
 *
 * Scoring matches the SRS calibration exactly: a clean correct = 1, a near-miss ("almost" — an
 * accepted accent/spelling slip) = 1 − its weight (0.2/0.3 → 0.7–0.8), a miss = 0. So the numbers
 * here line up with the "Measured retention" figure in a pair's SRS settings.
 *
 * Covers Due Now reviews only (`review_mode = 'due'`) — the same population the retention/calibration
 * numbers are computed from. Learning-ladder attempts are deliberately excluded: early-climb accuracy
 * is much lower and mixing it in would drag the curve without saying anything about retention.
 *
 * Filters (behind the gear): direction, card type, language, range, and points-per-day-or-week.
 * Data note: review_events records direction + typed-ness but NOT which track (typed and smart both
 * store was_typed = true), so "card type" is typed-vs-self-graded.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabasePaged'
import { localDateWithTurnover } from '@/lib/dates'
import { langName, langFlag, assignLanguageColors } from '@/lib/languages'

const DAY_MS = 86_400_000
const SMOOTH_DAYS = 7          // daily rolling window (pools counts, not percentages)
const MIN_WINDOW_N = 3         // don't plot a point backed by fewer reviews than this

type Dir = 'all' | 'forward' | 'reverse'
type CType = 'all' | 'typed' | 'selfgraded'
type Gran = 'day' | 'week'

interface Sample {
  day: string                          // local YYYY-MM-DD (turnover-aware)
  lang: string                         // source language
  dir: 'forward' | 'reverse'
  typed: boolean
  weight: number                       // 0..1 credit for this review
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function AccuracyTrend() {
  const [samples, setSamples] = useState<Sample[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [langColors, setLangColors] = useState<Record<string, string>>({})
  const [rangeDays, setRangeDays] = useState(30)
  const [dir, setDir] = useState<Dir>('all')
  const [ctype, setCtype] = useState<CType>('all')
  const [gran, setGran] = useState<Gran>('day')
  const [langFilter, setLangFilter] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setError('Not signed in'); return }
        const uid = session.user.id

        const { data: profile } = await supabase.from('profiles').select('timezone, day_turnover_hour, language_colors').eq('user_id', uid).single()
        const tz = (profile?.timezone as string | null) ?? 'UTC'
        const turnover = (profile?.day_turnover_hour as number | null) ?? 0
        if (!cancelled) setLangColors((profile?.language_colors as Record<string, string> | null) ?? {})

        const since = new Date(Date.now() - rangeDays * DAY_MS).toISOString()
        // Paged: a month of reviews is far past Supabase's 1000-row cap, which `.limit()` won't lift.
        const rows = await fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('review_events')
          .select('reviewed_at, was_correct, near_miss, near_miss_weight, source_language, review_direction, was_typed')
          .eq('user_id', uid).eq('review_mode', 'due').gte('reviewed_at', since)
          .order('reviewed_at', { ascending: false }).range(f, t))

        const out: Sample[] = []
        for (const e of rows) {
          const lang = e.source_language as string | null
          if (!lang) continue
          const nm = (e.near_miss_weight as number | null) ?? ((e.near_miss as boolean | null) ? 0.2 : 0)
          const weight = (e.was_correct as boolean) ? 1 : (nm > 0 ? 1 - nm : 0)
          out.push({
            day: localDateWithTurnover(e.reviewed_at as string, tz, turnover),
            lang,
            dir: (e.review_direction as string | null) === 'reverse' ? 'reverse' : 'forward',
            typed: !!(e.was_typed as boolean | null),
            weight,
          })
        }
        if (!cancelled) setSamples(out)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [rangeDays])

  const langs = useMemo(() => samples ? [...new Set(samples.map(s => s.lang))].sort() : [], [samples])

  const model = useMemo(() => {
    if (!samples) return null
    const today = new Date().toISOString().slice(0, 10)
    const days: string[] = []
    for (let i = rangeDays - 1; i >= 0; i--) days.push(addDays(today, -i))
    const dayIndex = new Map(days.map((d, i) => [d, i]))

    const keep = samples.filter(s => {
      if (dir !== 'all' && s.dir !== dir) return false
      if (ctype !== 'all' && s.typed !== (ctype === 'typed')) return false
      if (langFilter && s.lang !== langFilter) return false
      return true
    })

    // Raw per-language daily sums.
    const perLang = new Map<string, { sum: Float64Array; n: Float64Array }>()
    for (const s of keep) {
      const i = dayIndex.get(s.day)
      if (i === undefined) continue
      let a = perLang.get(s.lang)
      if (!a) { a = { sum: new Float64Array(days.length), n: new Float64Array(days.length) }; perLang.set(s.lang, a) }
      a.sum[i]! += s.weight; a.n[i]! += 1
    }

    // Point layout. Daily = one point per day over a rolling 7-day window; weekly = one point per
    // 7-day block, aligned so the newest block ends today (a partial block can lead). Either way the
    // percentage pools raw counts across the window rather than averaging daily percentages.
    const windows: { label: string; from: number; to: number }[] = []
    if (gran === 'week') {
      for (let end = days.length; end > 0; end -= 7) {
        const from = Math.max(0, end - 7)
        windows.unshift({ label: days[from]!, from, to: end })
      }
    } else {
      days.forEach((d, i) => windows.push({ label: d, from: Math.max(0, i - (SMOOTH_DAYS - 1)), to: i + 1 }))
    }

    const series = [...perLang.entries()].map(([lang, a]) => {
      const pts = windows.map(w => {
        let sum = 0, n = 0
        for (let j = w.from; j < w.to; j++) { sum += a.sum[j]!; n += a.n[j]! }
        return n >= MIN_WINDOW_N ? (sum / n) * 100 : null
      })
      const total = a.n.reduce((x, y) => x + y, 0)
      const overall = total > 0 ? (a.sum.reduce((x, y) => x + y, 0) / total) * 100 : null
      return { lang, pts, total, overall }
    }).filter(s => s.total > 0).sort((x, y) => y.total - x.total)

    const all = series.flatMap(s => s.pts.filter((p): p is number => p !== null))
    const grandN = series.reduce((s, x) => s + x.total, 0)
    const grandPct = grandN > 0 ? series.reduce((s, x) => s + (x.overall ?? 0) * x.total, 0) / grandN : null
    return {
      labels: windows.map(w => w.label), series, grandN, grandPct,
      lo: all.length ? Math.min(...all) : 0, hi: all.length ? Math.max(...all) : 100,
    }
  }, [samples, rangeDays, dir, ctype, langFilter, gran])

  const colorMap = useMemo(() => assignLanguageColors(langs, langColors), [langs, langColors])

  const pill = (on: boolean) =>
    `px-2 py-0.5 rounded-full border text-xs ${on ? 'bg-accent/20 border-accent text-ink' : 'border-surface-border text-ink-muted hover:text-ink'}`

  // Summary shown under the title while the gear panel is closed, plus whether anything is off-default
  // (which keeps the gear highlighted so an active filter is never invisible).
  const filtersAreDefault = dir === 'all' && ctype === 'all' && langFilter === null && rangeDays === 30 && gran === 'day'
  const filterSummary = [
    dir === 'all' ? 'both directions' : dir === 'forward' ? 'forward only' : 'reverse only',
    ctype === 'all' ? 'all card types' : ctype === 'typed' ? 'typed only' : 'self-graded only',
    langFilter === null ? 'all languages' : `${langFlag(langFilter)} ${langName(langFilter)}`,
    `last ${rangeDays} days`,
    gran === 'day' ? `${SMOOTH_DAYS}-day rolling` : 'weekly',
  ]

  if (error) return <p className="text-sm text-danger">Couldn&apos;t load accuracy: {error}</p>
  if (!samples || !model) return <p className="text-sm text-ink-faint">Loading accuracy…</p>

  const W = 720, H = 240, mL = 38, mR = 12, mT = 10, mB = 22
  // Zoom the y-axis to the data (with padding) — accuracy usually lives in a narrow high band.
  const yLo = Math.max(0, Math.floor((model.lo - 6) / 5) * 5)
  const yHi = Math.min(100, Math.ceil((model.hi + 4) / 5) * 5)
  const span = Math.max(5, yHi - yLo)
  const n = model.labels.length
  const x = (i: number) => mL + (n <= 1 ? 0 : (i / (n - 1)) * (W - mL - mR))
  const y = (v: number) => H - mB - ((v - yLo) / span) * (H - mT - mB)

  // Break the line across gaps (windows with too few reviews to be meaningful).
  const pathFor = (pts: (number | null)[]) => {
    let d = '', pen = false
    pts.forEach((p, i) => {
      if (p === null) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)} `
      pen = true
    })
    return d.trim()
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = svgRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.round(((relX - mL) / (W - mL - mR)) * (n - 1))
    if (i < 0 || i >= n) { setHover(null); return }
    setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  return (
    <div className="panel space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Accuracy over time</h3>
          <p className="text-xs text-ink-faint">
            Percent correct per language on Due Now reviews. Near-misses (accepted accent/spelling slips)
            count as partial credit, so this matches the &quot;Measured retention&quot; figure in your SRS settings.
          </p>
        </div>
        {/* Filters live behind the gear so the pill rows don't crowd out the chart. */}
        <button
          onClick={() => setShowFilters(s => !s)}
          aria-label={showFilters ? 'Hide filters' : 'Show filters'}
          aria-expanded={showFilters}
          className={`shrink-0 p-1.5 rounded-md border transition-colors ${
            showFilters || !filtersAreDefault
              ? 'bg-accent/20 border-accent text-ink'
              : 'border-surface-border text-ink-muted hover:text-ink hover:bg-surface/50'
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* What's currently applied, so the chart is never ambiguous with the panel closed. */}
      <p className="text-[11px] text-ink-faint">
        {filterSummary.join('  ·  ')}
        {filtersAreDefault ? '' : ' — filtered'}
      </p>

      {showFilters && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-surface-border bg-surface-deep/40 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint w-20">Direction</span>
            {([['all', 'All'], ['forward', 'Forward'], ['reverse', 'Reverse']] as const).map(([v, l]) => (
              <button key={v} onClick={() => setDir(v)} className={pill(dir === v)}>{l}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint w-20">Card type</span>
            {([['all', 'All'], ['typed', 'Typed'], ['selfgraded', 'Self-graded']] as const).map(([v, l]) => (
              <button key={v} onClick={() => setCtype(v)} className={pill(ctype === v)}>{l}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint w-20">Language</span>
            <button onClick={() => setLangFilter(null)} className={pill(langFilter === null)}>All</button>
            {langs.map(l => (
              <button key={l} onClick={() => setLangFilter(l)} className={`${pill(langFilter === l)} inline-flex items-center gap-1.5`}>
                <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: colorMap[l] }} />
                {langFlag(l)} {langName(l)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint w-20">Range</span>
            {[14, 30, 90].map(r => (
              <button key={r} onClick={() => setRangeDays(r)} className={pill(rangeDays === r)}>{r}d</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint w-20">Per point</span>
            {([['day', 'Day'], ['week', 'Week']] as const).map(([v, l]) => (
              <button key={v} onClick={() => setGran(v)} className={pill(gran === v)}>{l}</button>
            ))}
            <span className="text-[11px] text-ink-faint">
              {gran === 'day' ? `each point averages the previous ${SMOOTH_DAYS} days` : 'each point is one calendar week'}
            </span>
          </div>
          {!filtersAreDefault && (
            <button
              onClick={() => { setDir('all'); setCtype('all'); setLangFilter(null); setRangeDays(30); setGran('day') }}
              className="self-start mt-1 text-[11px] text-ink-muted hover:text-ink underline underline-offset-2"
            >
              Reset filters
            </button>
          )}
        </div>
      )}

      {model.series.length === 0 ? (
        <p className="text-sm text-ink-faint py-6 text-center">No reviews match these filters in the last {rangeDays} days.</p>
      ) : (
        <>
          <div className="relative">
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 260 }}
              onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
              {Array.from({ length: 5 }, (_, i) => {
                const v = yLo + (span / 4) * i
                return (
                  <g key={i}>
                    <line x1={mL} y1={y(v)} x2={W - mR} y2={y(v)} stroke="currentColor" className="text-surface-border" strokeWidth={1} opacity={0.4} />
                    <text x={mL - 6} y={y(v) + 3} textAnchor="end" className="fill-ink-faint" fontSize={10}>{Math.round(v)}%</text>
                  </g>
                )
              })}
              {[0, Math.floor((n - 1) / 2), n - 1].map(i => (
                <text key={i} x={x(i)} y={H - mB + 14} textAnchor="middle" className="fill-ink-faint" fontSize={10}>
                  {model.labels[i]!.slice(5)}
                </text>
              ))}
              {hover && (
                <line x1={x(hover.i)} y1={mT} x2={x(hover.i)} y2={H - mB} stroke="currentColor"
                  className="text-ink-faint" strokeWidth={1} opacity={0.5} strokeDasharray="3 3" />
              )}
              {model.series.map(s => (
                <path key={s.lang} d={pathFor(s.pts)} fill="none" stroke={colorMap[s.lang]} strokeWidth={2} strokeLinejoin="round" />
              ))}
            </svg>

            {hover && (
              <div className="absolute pointer-events-none z-10 rounded-lg border border-surface-border bg-surface-raised/95 backdrop-blur px-3 py-2 shadow-lg text-[11px]"
                style={{ left: Math.min(hover.x + 12, 520), top: Math.max(4, hover.y - 40) }}>
                <div className="text-ink-muted mb-1 pb-1 border-b border-surface-border">
                  {gran === 'week' ? `Week of ${model.labels[hover.i]}` : model.labels[hover.i]}
                </div>
                {model.series.map(s => (
                  <div key={s.lang} className="flex items-center gap-1.5 text-ink-muted whitespace-nowrap">
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colorMap[s.lang] }} />
                    {langFlag(s.lang)} {langName(s.lang)}
                    <span className="text-ink font-medium">{s.pts[hover.i] === null ? '—' : `${Math.round(s.pts[hover.i]!)}%`}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Per-language overall for the current filter */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {model.series.map(s => (
              <span key={s.lang} className="flex items-center gap-1.5 text-ink-muted">
                <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: colorMap[s.lang] }} />
                {langFlag(s.lang)} {langName(s.lang)}
                <span className="text-ink font-medium">{s.overall === null ? '—' : `${s.overall.toFixed(1)}%`}</span>
                <span className="text-ink-faint">({s.total.toLocaleString()})</span>
              </span>
            ))}
          </div>
          {model.grandPct !== null && (
            <p className="text-[11px] text-ink-faint">
              Overall for this filter: <span className="text-ink">{model.grandPct.toFixed(1)}%</span> across {model.grandN.toLocaleString()} reviews
              {' '}in the last {rangeDays} days.
            </p>
          )}
        </>
      )}
    </div>
  )
}
