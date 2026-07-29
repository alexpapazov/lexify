'use client'

/**
 * LearningEfficiency — how much time each language costs you, and how efficiently that time turns
 * into learned words. Sits under the accuracy chart in Analytics → Present.
 *
 * Three metrics off the same data:
 *   • Time spent    — minutes/day, split by activity (learning ladder vs Due Now reviews)
 *   • Words learned — non-accelerated graduations/day (imported "already known" cards don't count,
 *                     since they cost no learning time and would flatter the ratio)
 *   • Min per word  — ladder time ÷ words graduated. The efficiency number: lower is better.
 *
 * Windows pool RAW totals rather than averaging daily figures, so a 2-word day can't swing the line
 * as hard as a 40-word day. A window with too few graduations plots nothing instead of a wild ratio.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { fetchAnalyticsProfile, fetchLadderEventsWindow, fetchReviewEventsWindow, fetchGraduationsWindow } from '@/lib/analyticsData'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabasePaged'
import { localDateWithTurnover } from '@/lib/dates'
import { langName, langFlag, assignLanguageColors } from '@/lib/languages'

const DAY_MS = 86_400_000
const SMOOTH_DAYS = 7
const MIN_WORDS_FOR_RATIO = 3   // below this a "min per word" point is noise, so we leave a gap

type Metric = 'time' | 'words' | 'perword'
type Activity = 'learn' | 'review' | 'both'
type Gran = 'day' | 'week'

/** One day's totals for one language. */
interface Day { day: string; lang: string; learnMs: number; reviewMs: number; words: number }

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set)
  if (next.has(v)) next.delete(v); else next.add(v)
  return next
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function LearningEfficiency() {
  const [rows, setRows] = useState<Day[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [langColors, setLangColors] = useState<Record<string, string>>({})
  const [metric, setMetric] = useState<Metric>('time')
  const [activity, setActivity] = useState<Activity>('both')
  const [rangeDays, setRangeDays] = useState(30)
  const [gran, setGran] = useState<Gran>('day')
  const [langSel, setLangSel] = useState<Set<string>>(() => new Set<string>())
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

        const profile = await fetchAnalyticsProfile(uid)
        const tz = (profile?.timezone as string | null) ?? deviceTimeZone()
        const turnover = (profile?.day_turnover_hour as number | null) ?? 0
        if (!cancelled) setLangColors((profile?.language_colors as Record<string, string> | null) ?? {})

        // All three are shared with PresentSnapshot (identical windows/filters) — see
        // lib/analyticsData.ts. Still paged internally; the cache collapses the duplicate fetches.
        const [lad, rev, grad] = await Promise.all([
          fetchLadderEventsWindow(uid, rangeDays),
          fetchReviewEventsWindow(uid, rangeDays),
          fetchGraduationsWindow(uid, rangeDays),
        ])

        const byKey = new Map<string, Day>()
        const bump = (day: string, lang: string, patch: Partial<Day>) => {
          const k = `${day}|${lang}`
          const cur = byKey.get(k) ?? { day, lang, learnMs: 0, reviewMs: 0, words: 0 }
          byKey.set(k, {
            ...cur,
            learnMs:  cur.learnMs  + (patch.learnMs  ?? 0),
            reviewMs: cur.reviewMs + (patch.reviewMs ?? 0),
            words:    cur.words    + (patch.words    ?? 0),
          })
        }
        for (const e of lad) {
          const lang = e.source_language as string | null
          if (!lang) continue
          bump(localDateWithTurnover(e.created_at as string, tz, turnover), lang, { learnMs: (e.duration_ms as number | null) ?? 0 })
        }
        for (const e of rev) {
          const lang = e.source_language as string | null
          if (!lang) continue
          bump(localDateWithTurnover(e.reviewed_at as string, tz, turnover), lang, { reviewMs: (e.response_ms as number | null) ?? 0 })
        }
        for (const r of grad) {
          const mode = r.accelerated_mode as string | null
          // Imported "already known" cards graduate without costing learning time — counting them
          // would make the min-per-word ratio look far better than the work actually done.
          if (mode === 'import_known' || mode === 'bulk_known') continue
          const lang = (r.cards as { source_language?: string } | null)?.source_language
          if (!lang || !r.graduated_at) continue
          bump(localDateWithTurnover(r.graduated_at as string, tz, turnover), lang, { words: 1 })
        }
        if (!cancelled) setRows([...byKey.values()])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [rangeDays])

  const langs = useMemo(() => rows ? [...new Set(rows.map(r => r.lang))].sort() : [], [rows])

  const model = useMemo(() => {
    if (!rows) return null
    const today = new Date().toISOString().slice(0, 10)
    const days: string[] = []
    for (let i = rangeDays - 1; i >= 0; i--) days.push(addDays(today, -i))
    const dayIndex = new Map(days.map((d, i) => [d, i]))

    const keep = rows.filter(r => langSel.size === 0 || langSel.has(r.lang))
    const perLang = new Map<string, { learn: Float64Array; review: Float64Array; words: Float64Array }>()
    for (const r of keep) {
      const i = dayIndex.get(r.day)
      if (i === undefined) continue
      let a = perLang.get(r.lang)
      if (!a) {
        a = { learn: new Float64Array(days.length), review: new Float64Array(days.length), words: new Float64Array(days.length) }
        perLang.set(r.lang, a)
      }
      a.learn[i]! += r.learnMs; a.review[i]! += r.reviewMs; a.words[i]! += r.words
    }

    // Daily = rolling 7-day window; weekly = discrete 7-day blocks ending today.
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
        let learn = 0, review = 0, words = 0
        for (let j = w.from; j < w.to; j++) { learn += a.learn[j]!; review += a.review[j]!; words += a.words[j]! }
        const spanDays = Math.max(1, w.to - w.from)
        if (metric === 'words') return words / spanDays                       // words per day
        if (metric === 'time') {
          const ms = activity === 'learn' ? learn : activity === 'review' ? review : learn + review
          return ms / 60000 / spanDays                                        // minutes per day
        }
        // Efficiency: ladder time per word actually graduated. Needs enough words to mean anything.
        return words >= MIN_WORDS_FOR_RATIO ? (learn / 60000) / words : null
      })
      const totLearn = a.learn.reduce((x, y) => x + y, 0)
      const totReview = a.review.reduce((x, y) => x + y, 0)
      const totWords = a.words.reduce((x, y) => x + y, 0)
      return { lang, pts, totLearn, totReview, totWords }
    }).filter(s => s.totLearn > 0 || s.totReview > 0 || s.totWords > 0)
      .sort((x, y) => (y.totLearn + y.totReview) - (x.totLearn + x.totReview))

    const all = series.flatMap(s => s.pts.filter((p): p is number => p !== null))
    return { labels: windows.map(w => w.label), series, hi: all.length ? Math.max(...all) : 1 }
  }, [rows, rangeDays, metric, activity, langSel, gran])

  const colorMap = useMemo(() => assignLanguageColors(langs, langColors), [langs, langColors])

  const pill = (on: boolean) =>
    `px-2 py-0.5 rounded-full border text-xs ${on ? 'bg-accent/20 border-accent text-ink' : 'border-surface-border text-ink-muted hover:text-ink'}`

  const metricLabel = metric === 'time' ? 'minutes per day' : metric === 'words' ? 'words learned per day' : 'minutes per word learned'
  const fmtVal = (v: number) => metric === 'words' ? v.toFixed(1) : v < 10 ? v.toFixed(1) : Math.round(v).toString()
  const filtersAreDefault = metric === 'time' && activity === 'both' && langSel.size === 0 && rangeDays === 30 && gran === 'day'
  const filterSummary = [
    metric === 'time' ? `time spent (${activity === 'both' ? 'learning + reviews' : activity === 'learn' ? 'learning only' : 'reviews only'})`
      : metric === 'words' ? 'words learned' : 'minutes per word learned',
    langSel.size === 0 ? 'all languages' : [...langSel].map(l => `${langFlag(l)} ${langName(l)}`).join(' + '),
    `last ${rangeDays} days`,
    gran === 'day' ? `${SMOOTH_DAYS}-day rolling` : 'weekly',
  ]

  if (error) return <p className="text-sm text-danger">Couldn&apos;t load efficiency: {error}</p>
  if (!rows || !model) return <p className="text-sm text-ink-faint">Loading efficiency…</p>

  const W = 720, H = 240, mL = 42, mR = 12, mT = 10, mB = 22
  // Round the top up to a clean step so the axis reads in sensible units.
  const rawHi = Math.max(model.hi, metric === 'words' ? 1 : 5)
  const step = Math.max(1, Math.pow(10, Math.floor(Math.log10(rawHi / 4))) * (rawHi / 4 / Math.pow(10, Math.floor(Math.log10(rawHi / 4))) > 2 ? 5 : 2))
  const yHi = Math.ceil(rawHi / step) * step
  const ticks = Math.max(2, Math.round(yHi / step))
  const n = model.labels.length
  const x = (i: number) => mL + (n <= 1 ? 0 : (i / (n - 1)) * (W - mL - mR))
  const y = (v: number) => H - mB - (v / (yHi || 1)) * (H - mT - mB)

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
    // Map cursor into viewBox user units via the SVG's CTM — a plain rect.width ratio is wrong when
    // preserveAspectRatio letterboxes the drawing (w-full + maxHeight caps a wide chart and centres it).
    const _ctm = el.getScreenCTM()
    if (!_ctm) return
    const _pt = el.createSVGPoint(); _pt.x = e.clientX; _pt.y = e.clientY
    const relX = _pt.matrixTransform(_ctm.inverse()).x
    const i = Math.round(((relX - mL) / (W - mL - mR)) * (n - 1))
    if (i < 0 || i >= n) { setHover(null); return }
    setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  return (
    <div className="panel space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Time &amp; efficiency</h3>
          <p className="text-xs text-ink-faint">
            How much time each language costs you, and how efficiently that time becomes learned words.
            Imported &quot;already known&quot; cards are excluded — they graduate without costing learning time.
          </p>
        </div>
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

      <p className="text-[11px] text-ink-faint">{filterSummary.join('  ·  ')}</p>

      {showFilters && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-surface-border bg-surface-deep/40 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint w-20">Show</span>
            {([['time', 'Time spent'], ['words', 'Words learned'], ['perword', 'Min per word']] as const).map(([v, l]) => (
              <button key={v} onClick={() => setMetric(v)} className={pill(metric === v)}>{l}</button>
            ))}
          </div>
          {metric === 'time' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-ink-faint w-20">Activity</span>
              {([['learn', 'Learning'], ['review', 'Reviews'], ['both', 'Both']] as const).map(([v, l]) => (
                <button key={v} onClick={() => setActivity(v)} className={pill(activity === v)}>{l}</button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint w-20">Language</span>
            <button onClick={() => setLangSel(new Set())} className={pill(langSel.size === 0)}>All</button>
            {langs.map(l => (
              <button key={l} onClick={() => setLangSel(s => toggle(s, l))}
                className={`${pill(langSel.has(l))} inline-flex items-center gap-1.5`}>
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
          </div>
          {!filtersAreDefault && (
            <button
              onClick={() => { setMetric('time'); setActivity('both'); setLangSel(new Set()); setRangeDays(30); setGran('day') }}
              className="self-start mt-1 text-[11px] text-ink-muted hover:text-ink underline underline-offset-2"
            >Reset filters</button>
          )}
        </div>
      )}

      {model.series.length === 0 ? (
        <p className="text-sm text-ink-faint py-6 text-center">No study activity in the last {rangeDays} days.</p>
      ) : (
        <>
          <div className="relative">
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 260 }}
              onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
              {Array.from({ length: ticks + 1 }, (_, i) => {
                const v = step * i
                return (
                  <g key={i}>
                    <line x1={mL} y1={y(v)} x2={W - mR} y2={y(v)} stroke="currentColor" className="text-surface-border" strokeWidth={1} opacity={0.4} />
                    <text x={mL - 6} y={y(v) + 3} textAnchor="end" className="fill-ink-faint" fontSize={10}>{fmtVal(v)}</text>
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
            <p className="text-[10px] text-ink-faint text-center -mt-1">{metricLabel}</p>

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
                    <span className="text-ink font-medium">{s.pts[hover.i] === null ? '—' : fmtVal(s.pts[hover.i]!)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Totals for the window — the honest bottom line per language. */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {model.series.map(s => {
              const mins = (s.totLearn + s.totReview) / 60000
              const perWord = s.totWords > 0 ? (s.totLearn / 60000) / s.totWords : null
              return (
                <span key={s.lang} className="flex items-center gap-1.5 text-ink-muted">
                  <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: colorMap[s.lang] }} />
                  {langFlag(s.lang)} {langName(s.lang)}
                  <span className="text-ink font-medium">{mins < 60 ? `${Math.round(mins)}m` : `${(mins / 60).toFixed(1)}h`}</span>
                  <span className="text-ink-faint">
                    · {s.totWords} words{perWord !== null ? ` · ${perWord.toFixed(1)} min/word` : ''}
                  </span>
                </span>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
