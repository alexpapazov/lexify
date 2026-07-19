'use client'

/**
 * OrbitReplay — the "orbit" movie for one DAY of Due Now reviews, rendered as a pure function of
 * session-time (so playback, scrubbing, and comet-tails stay consistent). "Today" is a breathing sun at
 * the centre. Every card starts clustered at the sun (all due today) and, as its reviews fire, is flung
 * to its review interval — then it KEEPS orbiting at that radius, so the field fills up with concentric
 * rings of cards. Good/Easy sail far, Again crashes into a tight relearn orbit, and a card turned
 * DORMANT escapes the system entirely (shoots off-screen). Playback speed is adjustable.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DueSession, DueCard } from '@/lib/dueNowLog'
import { displayText } from '@/lib/cardText'
import { langName, langFlag } from '@/lib/languages'

const RATING_COLOR: Record<string, string> = { again: '#F05068', hard: '#F0883E', good: '#4ADE80', easy: '#4C8DFF' }
const LEGEND = [
  { label: 'Again → relearn', color: '#F05068' },
  { label: 'Hard', color: '#F0883E' },
  { label: 'Good', color: '#4ADE80' },
  { label: 'Easy → far out', color: '#4C8DFF' },
]
const SPEEDS = [0.25, 0.5, 1, 2]

const W = 400, H = 360, CX = W / 2, CY = H / 2
const R_INNER = 26, R_MAX = 156, R_RELEARN = R_INNER + 14, ESCAPE = 360   // dormant cards fly past the edge
const MIN_I = 1 / 144, MAX_I = 730          // 10 minutes … 2 years
const GOLDEN = 2.399963236
const MAX_GAP_MS = 2500        // cap dead time between consecutive reviews → an "active-only" timeline
const MS_PER_REVIEW = 1700     // target real playback time per review (paces a big day to ~2 min at 1×)
const PLAY_MIN = 30_000, PLAY_MAX = 150_000

/** Remap reviews onto a compressed timeline that starts at 0 and caps the idle gaps between reviews, so
 *  the movie is all action and lasts a sensible length instead of spanning the whole (mostly-empty) day. */
function compressTimeline(cards: DueCard[]): { cards: DueCard[]; wall: number } {
  const times = [...new Set(cards.flatMap(c => c.reviews.map(r => r.at)))].sort((a, b) => a - b)
  if (times.length === 0) return { cards, wall: 1 }
  const vOf = new Map<number, number>()
  let v = 0
  for (let i = 0; i < times.length; i++) { if (i > 0) v += Math.min(MAX_GAP_MS, times[i]! - times[i - 1]!); vOf.set(times[i]!, v) }
  return {
    cards: cards.map(c => ({ ...c, reviews: c.reviews.map(r => ({ ...r, at: vOf.get(r.at)! })) })),
    wall: Math.max(1, v),
  }
}

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
function makeStars(n: number) {
  let s = 0x9e3779b9
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff)
  return Array.from({ length: n }, () => ({ x: rnd() * W, y: rnd() * H, r: 0.4 + rnd() * 1.1, o: 0.15 + rnd() * 0.45, tw: rnd() * 6.283 }))
}
const GUIDES = [{ d: 1, label: '1d' }, { d: 7, label: '1w' }, { d: 30, label: '1mo' }, { d: 365, label: '1yr' }]

/** The card's final resting radius: dormant → escape; lapsed → tight relearn; else its interval orbit. */
function finalRadius(c: DueCard): number { return c.dormant ? ESCAPE : c.lapsed ? R_RELEARN : orbitRadius(c.intervalDays) }
/** How many full orbits this card sweeps over the whole movie — inner orbits are faster (Kepler-ish). */
function orbitsOverMovie(rFinal: number): number { return Math.min(6, Math.max(0.7, 1.25 * Math.pow(R_MAX / Math.max(R_INNER, rFinal), 0.7))) }

function targetForReview(card: DueCard, idx: number): number {
  const rev = card.reviews[idx]!
  const isLast = idx === card.reviews.length - 1
  const rF = finalRadius(card)
  if (card.dormant && isLast) return ESCAPE
  if (rev.rating === 'again' && !card.dormant) return R_RELEARN
  if (isLast) return rF
  const progress = 0.45 + 0.55 * ((idx + 1) / card.reviews.length)
  return R_INNER + (rF - R_INNER) * (rev.rating === 'easy' ? Math.min(1.06, progress + 0.15) : progress)
}
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
  const { cards } = session
  const [frac, setFrac] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [langFilter, setLangFilter] = useState<string | null>(null)   // watch just one language
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)

  const langs = useMemo(() => [...new Set(cards.map(c => c.source).filter((x): x is string => !!x))], [cards])
  const filtered = useMemo(() => langFilter ? cards.filter(c => c.source === langFilter) : cards, [cards, langFilter])
  // Compress the day to its active timeline (idle gaps capped) → dense, ~2-min-scale movie.
  const { cards: shown, wall: wallMs } = useMemo(() => compressTimeline(filtered), [filtered])
  const start = 0

  const t = frac * Math.max(1, wallMs)
  const flingMs = Math.max(300, wallMs * 0.03)
  const stars = useMemo(() => makeStars(48), [])
  const angle0 = useMemo(() => { const m = new Map<string, number>(); shown.forEach((c, i) => m.set(c.cardId, i * GOLDEN)); return m }, [shown])
  // Per-card angular speed based on its FINAL orbit → smooth spiral-out (no angle jumps while flinging).
  const spin = useMemo(() => { const m = new Map<string, number>(); shown.forEach(c => m.set(c.cardId, orbitsOverMovie(finalRadius(c)) * 2 * Math.PI)); return m }, [shown])
  const big = shown.length > 120
  const TAIL = big ? 4 : 7
  const showLabels = shown.length <= 16
  // Length scales with how many reviews there are (a busy day ≈ 2 min at 1×), then the speed control.
  const reviewTotal = useMemo(() => shown.reduce((n, c) => n + c.reviews.length, 0), [shown])
  const playMs = Math.min(PLAY_MAX, Math.max(PLAY_MIN, reviewTotal * MS_PER_REVIEW)) / speed

  useEffect(() => {
    if (!playing) { if (rafRef.current) cancelAnimationFrame(rafRef.current); return }
    startRef.current = performance.now() - frac * playMs
    const tick = () => {
      const p = Math.min(1, (performance.now() - startRef.current) / playMs)
      setFrac(p)
      if (p >= 1) { setPlaying(false); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playMs])

  const posAt = (c: DueCard, tt: number) => {
    const r = radiusAt(c, tt, flingMs)
    const theta = (angle0.get(c.cardId) ?? 0) + ((tt - start) / Math.max(1, wallMs)) * (spin.get(c.cardId) ?? 0)
    return { x: CX + r * Math.cos(theta), y: CY + r * Math.sin(theta), r }
  }

  const reviewedCount = shown.filter(c => (c.reviews[0]?.at ?? Infinity) <= t).length
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

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-ink-faint">Speed</span>
        <div className="inline-flex rounded-md overflow-hidden border border-line/15 text-[11px]">
          {SPEEDS.map(s => (
            <button key={s} onClick={() => setSpeed(s)} className={`px-2 py-0.5 ${speed === s ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}>{s}×</button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-ink-muted tabular-nums">{reviewedCount}/{shown.length} launched</span>
      </div>

      {/* Language filter — watch just one language's cards */}
      {langs.length > 1 && (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <button onClick={() => setLangFilter(null)}
            className={`px-2 py-0.5 rounded-full border ${langFilter === null ? 'bg-accent/20 border-accent text-ink' : 'border-line/15 text-ink-muted hover:text-ink'}`}>All</button>
          {langs.map(l => (
            <button key={l} onClick={() => setLangFilter(l)}
              className={`px-2 py-0.5 rounded-full border inline-flex items-center gap-1 ${langFilter === l ? 'bg-accent/20 border-accent text-ink' : 'border-line/15 text-ink-muted hover:text-ink'}`}>
              {langFlag(l)} {langName(l)}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint">
        {LEGEND.map(l => (
          <span key={l.label} className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: l.color }} />{l.label}</span>
        ))}
        <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full border border-ink-faint" />Dormant → escapes</span>
      </div>

      <div className="rounded-lg border border-line/10 overflow-hidden" style={{ background: 'radial-gradient(120% 120% at 50% 45%, #14162A 0%, #0B0C16 70%)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 420 }}>
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

          {stars.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#CBD2F0" opacity={s.o * (0.7 + 0.3 * Math.sin(t / 900 + s.tw))} />
          ))}

          {GUIDES.map(g => {
            const r = orbitRadius(g.d)
            return (
              <g key={g.d}>
                <circle cx={CX} cy={CY} r={r} fill="none" stroke="#C9D2FF" strokeOpacity={0.12} strokeWidth={1} strokeDasharray="2 5" />
                <text x={CX} y={CY - r - 3} textAnchor="middle" fill="#8891B4" fontSize={9}>{g.label}</text>
              </g>
            )
          })}

          {(() => { const pulse = 1 + 0.06 * Math.sin(t / 650); return (
            <g>
              <circle cx={CX} cy={CY} r={46 * pulse} fill="url(#orbit-sun)" />
              <circle cx={CX} cy={CY} r={10} fill="#FFE39A" />
              <text x={CX} y={CY + 1} textAnchor="middle" dominantBaseline="middle" fontSize={7} fontWeight={700} fill="rgba(0,0,0,0.65)">TODAY</text>
            </g>
          )})()}

          {shown.map(c => {
            const reviewed = (c.reviews[0]?.at ?? Infinity) <= t
            const here = posAt(c, t)
            const seen = c.reviews.filter(r => r.at <= t)
            const lastEvt = seen[seen.length - 1]
            const color = lastEvt ? (RATING_COLOR[lastEvt.rating] ?? '#4ADE80') : '#5A6079'
            const justRated = !!lastEvt && (t - lastEvt.at) >= 0 && (t - lastEvt.at) < Math.max(400, wallMs * 0.03)
            const pulseR = justRated && lastEvt ? 6 + 16 * ((t - lastEvt.at) / Math.max(400, wallMs * 0.03)) : 0
            const offscreen = here.x < -20 || here.x > W + 20 || here.y < -20 || here.y > H + 20
            if (offscreen) return null
            return (
              <g key={c.cardId}>
                {reviewed && Array.from({ length: TAIL }, (_, k) => {
                  const p = posAt(c, t - (k + 1) * tailDt)
                  const f = 1 - (k + 1) / (TAIL + 1)
                  return <circle key={k} cx={p.x} cy={p.y} r={3.4 * f} fill={color} opacity={0.26 * f} />
                })}
                {pulseR > 0 && lastEvt && (
                  <circle cx={here.x} cy={here.y} r={pulseR} fill="none" stroke={RATING_COLOR[lastEvt.rating] ?? '#4ADE80'} strokeWidth={1.5} opacity={0.75 * (1 - pulseR / 22)} />
                )}
                {reviewed && !big && <circle cx={here.x} cy={here.y} r={9} fill="url(#orbit-halo)" opacity={0.32} />}
                <circle cx={here.x} cy={here.y} r={reviewed ? 4.4 : 2.8} fill={c.dormant ? 'none' : color} stroke={c.dormant ? '#9AA3C8' : 'none'} strokeWidth={c.dormant ? 1.4 : 0} opacity={reviewed ? 1 : 0.5}>
                  <title>{displayText(c.label)} · {c.dormant ? 'dormant' : fmtInterval(c.intervalDays)}{c.lapsed ? ' · relearning' : ''}</title>
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
        The whole day in one movie: every card starts at <span className="text-ink-muted">today</span> (the sun) and is flung to its review interval, then keeps orbiting — so the rings fill up as the day goes on (inner = days, outer = months &amp; years, log scale). Colour = your rating; a lapse settles near today; a card you sent dormant escapes off-screen. Use the speed control to slow it down.
      </p>
    </div>
  )
}
