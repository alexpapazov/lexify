'use client'

/**
 * OrbitReplay — the "orbit" movie for one Due Now session. "Today" is a sun at the centre; each card
 * orbits at a radius = its review interval (log-scaled: a 3-day card hugs the sun, a 1-year card sits
 * far out). At the start every card is clustered at the sun (all due today); as the session's reviews
 * fire (in time order) each card is flung out to its orbit, flashing its rating colour. A card that
 * lapsed (last rating = Again) crashes back into a tight relearn orbit near the sun. Purely visual.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DueSession } from '@/lib/dueNowLog'
import { displayText } from '@/lib/cardText'

const RATING_COLOR: Record<string, string> = {
  again: '#F05068', hard: '#F0883E', good: '#4ADE80', easy: '#4C8DFF',
}
const LEGEND = [
  { label: 'Again → relearn', color: '#F05068' },
  { label: 'Hard', color: '#F0883E' },
  { label: 'Good', color: '#4ADE80' },
  { label: 'Easy → far out', color: '#4C8DFF' },
]

const W = 380, H = 340, CX = W / 2, CY = H / 2
const R_INNER = 26, R_MAX = 150
const MIN_I = 1 / 144, MAX_I = 730   // 10 minutes … 2 years
const FLING_MS_FRAC = 0.06           // fraction of the session used to animate a card flying out
const GOLDEN = 2.399963              // radians — spreads cards evenly around the circle

function orbitRadius(intervalDays: number): number {
  const iv = Math.min(MAX_I, Math.max(MIN_I, intervalDays || MIN_I))
  const norm = (Math.log(iv) - Math.log(MIN_I)) / (Math.log(MAX_I) - Math.log(MIN_I))
  return R_INNER + norm * (R_MAX - R_INNER)
}
function easeOut(p: number): number { return 1 - Math.pow(1 - p, 3) }
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
function fmtInterval(days: number): string {
  if (days < 1) return `${Math.round(days * 24)}h`
  if (days < 30) return `${Math.round(days)}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)}y`
}

const GUIDES = [{ d: 1, label: '1d' }, { d: 7, label: '1w' }, { d: 30, label: '1mo' }, { d: 365, label: '1yr' }]

export function OrbitReplay({ session }: { session: DueSession }) {
  const { cards, start, wallMs } = session
  const [frac, setFrac] = useState(1)
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)

  const t = start + frac * Math.max(1, wallMs)
  const flingMs = Math.max(400, wallMs * FLING_MS_FRAC)

  // Stable base angle per card (golden-angle spread), computed once.
  const angles = useMemo(() => {
    const m = new Map<string, number>()
    cards.forEach((c, i) => m.set(c.cardId, i * GOLDEN))
    return m
  }, [cards])

  const PLAY_MS = 11000
  useEffect(() => {
    if (!playing) { if (rafRef.current) cancelAnimationFrame(rafRef.current); return }
    startRef.current = performance.now() - frac * PLAY_MS
    const tick = () => {
      const p = Math.min(1, (performance.now() - startRef.current) / PLAY_MS)
      setFrac(p)
      if (p >= 1) { setPlaying(false); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  const showLabels = cards.length <= 14

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <button onClick={() => { if (frac >= 1) setFrac(0); setPlaying(p => !p) }} className="btn-primary text-xs py-1.5 px-3 shrink-0">
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <input type="range" min={0} max={1000} value={Math.round(frac * 1000)}
          onChange={e => { setPlaying(false); setFrac(Number(e.target.value) / 1000) }} className="flex-1 accent-accent" />
        <span className="text-xs text-ink-muted tabular-nums w-16 text-right">{fmtClock(frac * wallMs)} / {fmtClock(wallMs)}</span>
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-ink-faint">
        {LEGEND.map(l => (
          <span key={l.label} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: l.color }} />{l.label}
          </span>
        ))}
      </div>

      <div className="rounded-lg border border-line/10 bg-surface-deep/60 overflow-hidden">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 380 }}>
          <defs>
            <radialGradient id="sun" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FFE08A" stopOpacity="0.95" />
              <stop offset="45%" stopColor="#F0A94E" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#F0A94E" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Orbit guide rings + labels */}
          {GUIDES.map(g => {
            const r = orbitRadius(g.d)
            return (
              <g key={g.d}>
                <circle cx={CX} cy={CY} r={r} fill="none" stroke="currentColor" className="text-line/20" strokeWidth={1} strokeDasharray="2 4" />
                <text x={CX} y={CY - r - 3} textAnchor="middle" className="fill-ink-faint" fontSize={9}>{g.label}</text>
              </g>
            )
          })}

          {/* Sun (Today) */}
          <circle cx={CX} cy={CY} r={40} fill="url(#sun)" />
          <circle cx={CX} cy={CY} r={9} fill="#FFD16B" />
          <text x={CX} y={CY + 1} textAnchor="middle" dominantBaseline="middle" fontSize={7} fontWeight={700} className="fill-black/70">TODAY</text>

          {/* Cards */}
          {cards.map(c => {
            const seen = c.reviews.filter(r => r.at <= t)
            const lastEvt = seen[seen.length - 1]
            const firstAt = c.reviews[0]?.at ?? start
            const reviewed = seen.length > 0
            const target = c.lapsed ? R_INNER + 14 : orbitRadius(c.intervalDays)
            const p = reviewed ? easeOut(Math.min(1, (t - firstAt) / flingMs)) : 0
            const r = R_INNER + p * (target - R_INNER)
            const theta = (angles.get(c.cardId) ?? 0) + frac * 0.5   // gentle drift so it feels alive
            const x = CX + r * Math.cos(theta), y = CY + r * Math.sin(theta)
            const color = lastEvt ? (RATING_COLOR[lastEvt.rating] ?? '#4ADE80') : '#5A6079'
            // Pulse briefly right after any review event lands.
            const justRated = seen.some(rv => t - rv.at >= 0 && t - rv.at < Math.max(500, wallMs * 0.04))
            return (
              <g key={c.cardId}>
                {justRated && lastEvt && (
                  <circle cx={x} cy={y} r={11} fill="none" stroke={RATING_COLOR[lastEvt.rating] ?? '#4ADE80'} strokeWidth={1.5} opacity={0.7} />
                )}
                <circle cx={x} cy={y} r={reviewed ? 4.5 : 3} fill={color} opacity={reviewed ? 1 : 0.5}>
                  <title>{displayText(c.label)} · {fmtInterval(c.intervalDays)}{c.lapsed ? ' · relearning' : ''}</title>
                </circle>
                {(showLabels || justRated) && reviewed && (
                  <text x={x} y={y - 7} textAnchor="middle" fontSize={8} className="fill-ink-muted" style={{ pointerEvents: 'none' }}>
                    {displayText(c.label).slice(0, 14)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      <p className="text-[11px] text-ink-faint">
        Every card starts at <span className="text-ink-muted">today</span> and is flung to its review interval (log scale — inner rings are days, outer are months &amp; years). Colour = how you rated it; a lapse (Again) keeps it in a tight relearn orbit near today.
      </p>
    </div>
  )
}
