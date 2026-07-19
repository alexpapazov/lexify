'use client'

/**
 * OrbitReplay — the "orbit" movie for one Due Now session, rendered as a pure function of session-time
 * so playback, scrubbing, and comet-tails all stay perfectly consistent. "Today" is a breathing sun at
 * the centre; each card orbits at a radius = its review interval (log-scaled). At t=0 every card is
 * clustered at the sun (all due today); as the session's reviews fire in time order each card is flung
 * outward — Good/Easy sail far, Again crashes it back into a tight relearn orbit near the sun — trailing
 * a rating-coloured comet tail and pulsing a ring on each review. Purely visual.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DueSession, DueCard } from '@/lib/dueNowLog'
import { displayText } from '@/lib/cardText'

const RATING_COLOR: Record<string, string> = { again: '#F05068', hard: '#F0883E', good: '#4ADE80', easy: '#4C8DFF' }
const LEGEND = [
  { label: 'Again → relearn', color: '#F05068' },
  { label: 'Hard', color: '#F0883E' },
  { label: 'Good', color: '#4ADE80' },
  { label: 'Easy → far out', color: '#4C8DFF' },
]

const W = 400, H = 360, CX = W / 2, CY = H / 2
const R_INNER = 26, R_MAX = 156, R_RELEARN = R_INNER + 14
const MIN_I = 1 / 144, MAX_I = 730          // 10 minutes … 2 years
const GOLDEN = 2.399963236                  // radians — even spread around the circle
const OMEGA = 0.00000045                    // base angular speed (rad per ms of session-time)
const TAIL = 7                              // comet-tail samples
const PLAY_MS = 12000
const GUIDES = [{ d: 1, label: '1d' }, { d: 7, label: '1w' }, { d: 30, label: '1mo' }, { d: 365, label: '1yr' }]

function orbitRadius(intervalDays: number): number {
  const iv = Math.min(MAX_I, Math.max(MIN_I, intervalDays || MIN_I))
  const norm = (Math.log(iv) - Math.log(MIN_I)) / (Math.log(MAX_I) - Math.log(MIN_I))
  return R_INNER + norm * (R_MAX - R_INNER)
}
const easeIO = (p: number) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
const lerp = (a: number, b: number, p: number) => a + (b - a) * p
function fmtClock(ms: number): string { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
function fmtInterval(days: number): string {
  if (days < 1) return `${Math.round(days * 24)}h`
  if (days < 30) return `${Math.round(days)}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)}y`
}
/** Deterministic starfield (seeded LCG) so it doesn't flicker between renders. */
function makeStars(n: number) {
  let s = 0x9e3779b9
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff)
  return Array.from({ length: n }, () => ({ x: rnd() * W, y: rnd() * H, r: 0.4 + rnd() * 1.1, o: 0.15 + rnd() * 0.45, tw: rnd() * 6.283 }))
}

/** Target orbit radius a card should be at after its i-th review (piecewise crash/fling). */
function targetForReview(card: DueCard, idx: number): number {
  const rev = card.reviews[idx]!
  const isLast = idx === card.reviews.length - 1
  const rFinal = card.lapsed ? R_RELEARN : orbitRadius(card.intervalDays)
  if (rev.rating === 'again') return R_RELEARN                       // crash back toward today
  if (isLast) return rFinal
  const progress = 0.45 + 0.55 * ((idx + 1) / card.reviews.length)   // partial fling on the way out
  return R_INNER + (rFinal - R_INNER) * (rev.rating === 'easy' ? Math.min(1.06, progress + 0.15) : progress)
}
/** The card's radius at absolute session-time `t` — eased across its review keyframes. */
function radiusAt(card: DueCard, t: number, flingMs: number): number {
  const rs = card.reviews
  if (rs.length === 0 || t < rs[0]!.at) return R_INNER
  let i = 0
  for (let k = 0; k < rs.length; k++) if (rs[k]!.at <= t) i = k
  const prev = i === 0 ? R_INNER : targetForReview(card, i - 1)
  const p = Math.min(1, Math.max(0, (t - rs[i]!.at) / flingMs))
  return lerp(prev, targetForReview(card, i), easeIO(p))
}

export function OrbitReplay({ session }: { session: DueSession }) {
  const { cards, start, wallMs } = session
  const [frac, setFrac] = useState(1)
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)

  const t = start + frac * Math.max(1, wallMs)
  const flingMs = Math.max(350, wallMs * 0.05)
  const stars = useMemo(() => makeStars(46), [])
  const angle0 = useMemo(() => { const m = new Map<string, number>(); cards.forEach((c, i) => m.set(c.cardId, i * GOLDEN)); return m }, [cards])
  const showLabels = cards.length <= 16

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

  // Position of a card at absolute session-time `tt` — pure, so tails just re-sample the past.
  const posAt = (c: DueCard, tt: number) => {
    const r = radiusAt(c, tt, flingMs)
    // Kepler-ish: inner orbits sweep faster. Angle is a function of session-time only → deterministic tails.
    const theta = (angle0.get(c.cardId) ?? 0) + (tt - start) * OMEGA * (R_MAX / Math.max(R_INNER, r))
    return { x: CX + r * Math.cos(theta), y: CY + r * Math.sin(theta), r }
  }

  const reviewedCount = cards.filter(c => (c.reviews[0]?.at ?? Infinity) <= t).length
  const tailDt = flingMs / TAIL

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button onClick={() => { if (frac >= 1) setFrac(0); setPlaying(p => !p) }} className="btn-primary text-xs py-1.5 px-3 shrink-0">
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <input type="range" min={0} max={1000} value={Math.round(frac * 1000)}
          onChange={e => { setPlaying(false); setFrac(Number(e.target.value) / 1000) }} className="flex-1 accent-accent" />
        <span className="text-xs text-ink-muted tabular-nums w-16 text-right">{fmtClock(frac * wallMs)} / {fmtClock(wallMs)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
        {LEGEND.map(l => (
          <span key={l.label} className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: l.color }} />{l.label}</span>
        ))}
        <span className="ml-auto text-ink-muted tabular-nums">{reviewedCount}/{cards.length} launched</span>
      </div>

      <div className="rounded-lg border border-line/10 overflow-hidden" style={{ background: 'radial-gradient(120% 120% at 50% 45%, #14162A 0%, #0B0C16 70%)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 400 }}>
          <defs>
            <radialGradient id="orbit-sun" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FFF0C0" stopOpacity="1" />
              <stop offset="35%" stopColor="#FFD16B" stopOpacity="0.85" />
              <stop offset="70%" stopColor="#F0A94E" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#F0A94E" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="orbit-halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Starfield */}
          {stars.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#CBD2F0" opacity={s.o * (0.7 + 0.3 * Math.sin(t / 900 + s.tw))} />
          ))}

          {/* Orbit guide rings */}
          {GUIDES.map(g => {
            const r = orbitRadius(g.d)
            return (
              <g key={g.d}>
                <circle cx={CX} cy={CY} r={r} fill="none" stroke="#C9D2FF" strokeOpacity={0.12} strokeWidth={1} strokeDasharray="2 5" />
                <text x={CX} y={CY - r - 3} textAnchor="middle" fill="#8891B4" fontSize={9}>{g.label}</text>
              </g>
            )
          })}

          {/* Sun (Today) — gentle breathing */}
          {(() => { const pulse = 1 + 0.06 * Math.sin(t / 650); return (
            <g>
              <circle cx={CX} cy={CY} r={46 * pulse} fill="url(#orbit-sun)" />
              <circle cx={CX} cy={CY} r={10} fill="#FFE39A" />
              <text x={CX} y={CY + 1} textAnchor="middle" dominantBaseline="middle" fontSize={7} fontWeight={700} fill="rgba(0,0,0,0.65)">TODAY</text>
            </g>
          )})()}

          {/* Cards + comet tails */}
          {cards.map(c => {
            const reviewed = (c.reviews[0]?.at ?? Infinity) <= t
            const here = posAt(c, t)
            const seen = c.reviews.filter(r => r.at <= t)
            const lastEvt = seen[seen.length - 1]
            const color = lastEvt ? (RATING_COLOR[lastEvt.rating] ?? '#4ADE80') : '#5A6079'
            const justRated = !!lastEvt && (t - lastEvt.at) >= 0 && (t - lastEvt.at) < Math.max(500, wallMs * 0.045)
            const pulseR = justRated && lastEvt ? 6 + 16 * ((t - lastEvt.at) / Math.max(500, wallMs * 0.045)) : 0
            return (
              <g key={c.cardId}>
                {/* comet tail — re-sampled past positions */}
                {reviewed && Array.from({ length: TAIL }, (_, k) => {
                  const p = posAt(c, t - (k + 1) * tailDt)
                  const f = 1 - (k + 1) / (TAIL + 1)
                  return <circle key={k} cx={p.x} cy={p.y} r={3.4 * f} fill={color} opacity={0.28 * f} />
                })}
                {/* review pulse ring */}
                {pulseR > 0 && lastEvt && (
                  <circle cx={here.x} cy={here.y} r={pulseR} fill="none" stroke={RATING_COLOR[lastEvt.rating] ?? '#4ADE80'} strokeWidth={1.5} opacity={0.75 * (1 - pulseR / 22)} />
                )}
                {/* glow + head */}
                {reviewed && <circle cx={here.x} cy={here.y} r={9} fill="url(#orbit-halo)" opacity={0.35} />}
                <circle cx={here.x} cy={here.y} r={reviewed ? 4.6 : 3} fill={color} opacity={reviewed ? 1 : 0.5}>
                  <title>{displayText(c.label)} · {fmtInterval(c.intervalDays)}{c.lapsed ? ' · relearning' : ''}</title>
                </circle>
                {(showLabels || justRated) && reviewed && (
                  <text x={here.x} y={here.y - 8} textAnchor="middle" fontSize={8} fill="#B8C0E0" style={{ pointerEvents: 'none' }}>
                    {displayText(c.label).slice(0, 16)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      <p className="text-[11px] text-ink-faint">
        Every card starts at <span className="text-ink-muted">today</span> (the sun) and is flung to its review interval — inner rings are days, outer are months &amp; years (log scale). Colour = your rating; multiple reviews crash it in (Again) and fling it back out; a lapse settles in a tight relearn orbit near today.
      </p>
    </div>
  )
}
