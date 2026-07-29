'use client'

/**
 * VocabGrowthProjection — a "how big will my vocabulary get" line chart for the Future tab. Each
 * language starts at its CURRENT graduated (learned) word count today, then grows linearly by that
 * language's daily new-word goal: vocab(t) = learnedNow + dailyGoal · daysAhead. One line per language.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { langName, langFlag, assignLanguageColors } from '@/lib/languages'

const HORIZON = 730   // 2 years
const W = 720, H = 280, mL = 44, mR = 12, mT = 12, mB = 26

interface Lang { code: string; label: string; flag: string; base: number; slope: number }  // slope = words/day

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function ordinal(n: number): string { const t = n % 100; if (t >= 11 && t <= 13) return `${n}th`; return `${n}${(['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}` }
function forecastDate(dayOffset: number): string {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset)
  return `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`
}

export function VocabGrowthProjection() {
  const [langs, setLangs] = useState<Lang[] | null>(null)
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

        void supabase.from('profiles').select('language_colors').eq('user_id', uid).single()
          .then(r => { if (!cancelled) setLangColors((r.data?.language_colors as Record<string, string> | null) ?? {}) })

        const [decks, pairs] = await Promise.all([
          new SupabaseDeckRepository().list(uid),
          new SupabaseLanguagePairRepository().list(uid),
        ])
        const stateRepo = new SupabaseCardStateRepository()
        // ONE cached paged read for the whole library instead of a per-deck fan-out (each of which
        // was itself 2 serial round trips). Grouped back per deck so the logic below is untouched.
        const [allStates, deckIdByCard] = await Promise.all([
          stateRepo.listAllForUser(uid),
          new SupabaseCardRepository().deckIdsByCard(decks.map(d => d.id)),
        ])
        const statesByDeck = new Map<string, typeof allStates>()
        for (const s of allStates) {
          const dId = deckIdByCard.get(s.cardId)
          if (!dId) continue
          const arr = statesByDeck.get(dId)
          if (arr) arr.push(s); else statesByDeck.set(dId, [s])
        }
        const deckStates = decks.map(d => statesByDeck.get(d.id) ?? [])

        // Learned-now per source language = distinct graduated forward cards (dedupe shared cards).
        const gradByLang = new Map<string, Set<string>>()
        decks.forEach((d, i) => {
          for (const s of deckStates[i]!) {
            if (s.reviewDirection === 'reverse' || !s.graduated) continue
            const set = gradByLang.get(d.sourceLanguage) ?? new Set<string>()
            set.add(s.cardId); gradByLang.set(d.sourceLanguage, set)
          }
        })
        // Daily new-word goal per source language (avg over the week).
        const goalByLang = new Map<string, number>()
        for (const p of pairs) {
          const g = p.goals
          if (!g) continue
          const sum = [0, 1, 2, 3, 4, 5, 6].reduce((s, d) => s + (g[String(d)] ?? 0), 0)
          if (sum > 0) goalByLang.set(p.sourceLanguage, (goalByLang.get(p.sourceLanguage) ?? 0) + sum / 7)
        }

        const codes = [...new Set([...gradByLang.keys(), ...goalByLang.keys()])]
        const out: Lang[] = codes
          .map(code => ({ code, label: langName(code), flag: langFlag(code), base: gradByLang.get(code)?.size ?? 0, slope: goalByLang.get(code) ?? 0 }))
          .filter(l => l.base > 0 || l.slope > 0)
          .sort((a, b) => (b.base + b.slope * HORIZON) - (a.base + a.slope * HORIZON))
        if (!cancelled) setLangs(out)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const shown = useMemo(() => filterCode ? (langs ?? []).filter(l => l.code === filterCode) : (langs ?? []), [langs, filterCode])
  const valueAt = (l: Lang, day: number) => l.base + l.slope * day
  const maxY = useMemo(() => Math.max(10, ...shown.map(l => valueAt(l, HORIZON))) * 1.08, [shown])
  const colorMap = useMemo(() => assignLanguageColors((langs ?? []).map(l => l.code), langColors), [langs, langColors])

  if (error) return <p className="text-sm text-danger">Couldn&apos;t build projection: {error}</p>
  if (!langs) return <p className="text-sm text-ink-faint">Building projection…</p>
  if (langs.length === 0) return <p className="text-sm text-ink-faint">No graduated words or daily goals yet — learn some cards or set goals in Settings.</p>

  const x = (day: number) => mL + (day / HORIZON) * (W - mL - mR)
  const y = (v: number) => H - mB - (v / maxY) * (H - mT - mB)
  const xTicks = [{ day: 0, label: 'now' }, { day: 182, label: '6 mo' }, { day: 365, label: '1 yr' }, { day: 547, label: '18 mo' }, { day: 730, label: '2 yr' }]
  const yTicks = 4

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

          {hover && (
            <line x1={x(hover.day)} y1={mT} x2={x(hover.day)} y2={H - mB} stroke="currentColor" className="text-ink-faint" strokeWidth={1} opacity={0.5} strokeDasharray="3 3" />
          )}

          {shown.map(l => (
            <g key={l.code}>
              <line x1={x(0)} y1={y(valueAt(l, 0))} x2={x(HORIZON)} y2={y(valueAt(l, HORIZON))} stroke={colorMap[l.code]} strokeWidth={2} />
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
        Each language starts at the words you&apos;ve already learned (graduated) today and grows by your daily new-word goal. Straight-line estimate — it assumes you keep hitting your goal (and keep adding cards to learn).
      </p>
    </div>
  )
}
