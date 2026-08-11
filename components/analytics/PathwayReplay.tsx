'use client'

/**
 * components/analytics/PathwayReplay.tsx — scrubbable replay of one PATHWAY session, in the
 * learner's choice of three animations (persisted in localStorage):
 *
 *   'map'    — the pathway as a row of state nodes; cards are dots that hop node-to-node along a
 *              curved track, clustering around the state they currently occupy.
 *   'climb'  — the ladder-replay metaphor with one lane PER STATE (named lanes), cards rise and
 *              fall between them. Familiar, reads well for near-linear pathways.
 *   'trails' — one horizontal timeline row per card; a step-trail draws the card's state index over
 *              session time with outcome-coloured ticks, and a playhead sweeps across.
 *
 * All three share the same playback clock and the same data: events whose from/to are STATE INDICES
 * (migration 118). Sessions logged before 118 have every event at 0→0 — the replay still renders,
 * it just has no movement, which the caller warns about.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { cardLevelAt, type SessionSummary } from '@/lib/ladderLog'

const OUTCOME_COLOR: Record<string, string> = {
  again: '#F05068', miss: '#F05068',
  almost: '#F0883E', hard: '#F0883E',
  pass:  '#4ADE80', good: '#4ADE80',
  easy:  '#4C8DFF',
}
const LEGEND: { label: string; color: string }[] = [
  { label: 'Again / miss', color: '#F05068' },
  { label: 'Almost / Hard', color: '#F0883E' },
  { label: 'Correct / Good', color: '#4ADE80' },
  { label: 'Easy', color: '#4C8DFF' },
]

export type PathwayReplayStyle = 'map' | 'climb' | 'trails'
const STYLE_KEY = 'pathway_replay_style'
const STYLES: { key: PathwayReplayStyle; label: string; hint: string }[] = [
  { key: 'map',    label: 'Map',    hint: 'cards travel between state nodes' },
  { key: 'climb',  label: 'Climb',  hint: 'cards rise through named lanes' },
  { key: 'trails', label: 'Trails', hint: 'one timeline per card' },
]

function fmtClock(msSpan: number): string {
  const s = Math.max(0, Math.round(msSpan / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** Estimate a chip's width from its text (11px medium) — same heuristic as the ladder replay. */
function estChipWidth(label: string): number {
  let w = 0
  for (const ch of label) {
    const cp = ch.codePointAt(0) ?? 0
    if (ch === ' ') w += 3.4
    else if ((cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x3000 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF)) w += 11.6
    else w += 6.7
  }
  return Math.ceil(w) + 18
}

export function PathwayReplay({ session }: { session: SessionSummary }) {
  const [style, setStyle] = useState<PathwayReplayStyle>(() => {
    if (typeof window === 'undefined') return 'map'
    const saved = localStorage.getItem(STYLE_KEY)
    return saved === 'map' || saved === 'climb' || saved === 'trails' ? saved : 'map'
  })
  const pickStyle = (k: PathwayReplayStyle) => { setStyle(k); try { localStorage.setItem(STYLE_KEY, k) } catch { /* ignore */ } }

  const { start, wallMs } = session
  const [frac, setFrac] = useState(1)
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef<number | null>(null)
  const playStartRef = useRef(0)
  const t = start + frac * Math.max(1, wallMs)

  const PLAY_MS = 9000
  useEffect(() => {
    if (!playing) { if (rafRef.current) cancelAnimationFrame(rafRef.current); return }
    playStartRef.current = performance.now() - frac * PLAY_MS
    const tick = () => {
      const p = Math.min(1, (performance.now() - playStartRef.current) / PLAY_MS)
      setFrac(p)
      if (p >= 1) { setPlaying(false); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  return (
    <div className="space-y-3">
      {/* Controls + style switcher */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => { if (frac >= 1) setFrac(0); setPlaying(p => !p) }}
          className="btn-primary text-xs py-1.5 px-3 shrink-0">
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <input
          type="range" min={0} max={1000} value={Math.round(frac * 1000)}
          onChange={e => { setPlaying(false); setFrac(Number(e.target.value) / 1000) }}
          className="flex-1 min-w-[8rem] accent-accent" />
        <span className="text-xs text-ink-muted tabular-nums w-16 text-right">
          {fmtClock(frac * wallMs)} / {fmtClock(wallMs)}
        </span>
        <div className="flex gap-1">
          {STYLES.map(s => (
            <button key={s.key} title={s.hint} onClick={() => pickStyle(s.key)}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                style === s.key ? 'border-accent text-ink bg-accent/10' : 'border-line/10 text-ink-faint hover:text-ink'
              }`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-ink-faint">
        {LEGEND.map(l => (
          <span key={l.label} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: l.color }} />
            {l.label}
          </span>
        ))}
      </div>

      {style === 'map'    && <MapView session={session} t={t} />}
      {style === 'climb'  && <ClimbView session={session} t={t} />}
      {style === 'trails' && <TrailsView session={session} t={t} frac={frac} />}
    </div>
  )
}

/** Lane label for state index `i` (stateCount = graduated). */
function laneName(session: SessionSummary, i: number): string {
  const n = Math.max(1, ...session.events.map(e => e.rungCount))
  if (i >= n) return '✓ Grad'
  return session.stateNames[i] ?? `State ${i + 1}`
}

/** The most recent attempt at or before `t` for a card — drives the outcome flash. */
function lastEventAt(session: SessionSummary, cardEvents: SessionSummary['cards'][number]['events'], t: number) {
  return cardEvents.filter(e => new Date(e.createdAt).getTime() <= t).slice(-1)[0]
}
const flashColor = (e: { overridden: boolean; outcome: string | null } | undefined) =>
  e ? (e.overridden ? OUTCOME_COLOR.pass : e.outcome ? OUTCOME_COLOR[e.outcome] : undefined) : undefined

// ─── 'map': state nodes on a track, cards as travelling dots ──────────────────

function MapView({ session, t }: { session: SessionSummary; t: number }) {
  const stateCount = Math.max(1, ...session.events.map(e => e.rungCount))
  const NODE_W = 120, NODE_GAP = 46, TRACK_Y = 66, H = 190
  const nodeX = (i: number) => 16 + i * (NODE_W + NODE_GAP)
  const totalW = nodeX(stateCount) + NODE_W + 16

  // Cards clustered per current state, stacked below their node.
  const clusters = useMemo(() => {
    const byLevel = new Map<number, typeof session.cards>()
    for (const c of session.cards) {
      const level = Math.min(stateCount, cardLevelAt(c.events, t))
      const arr = byLevel.get(level) ?? []
      arr.push(c); byLevel.set(level, arr)
    }
    return byLevel
  }, [session.cards, t, stateCount])

  return (
    <div className="overflow-x-auto rounded-lg border border-line/10 bg-surface-deep/40">
      <div className="relative" style={{ width: totalW, height: H, minWidth: '100%' }}>
        {/* Track */}
        <div className="absolute h-px bg-line/20" style={{ top: TRACK_Y, left: nodeX(0) + NODE_W / 2, width: nodeX(stateCount) - nodeX(0) }} />
        {/* Nodes (states + Grad) */}
        {Array.from({ length: stateCount + 1 }, (_, i) => (
          <div key={i}
            className={`absolute flex items-center justify-center rounded-full border text-[11px] px-2 text-center ${
              i === stateCount ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line/20 bg-surface-raised text-ink-muted'
            }`}
            style={{ left: nodeX(i), top: TRACK_Y - 16, width: NODE_W, height: 32 }}>
            <span className="truncate">{laneName(session, i)}</span>
          </div>
        ))}
        {/* Cards: dots gliding along the track, stacking under their node */}
        {session.cards.map(c => {
          const level = Math.min(stateCount, cardLevelAt(c.events, t))
          const idxInCluster = (clusters.get(level) ?? []).indexOf(c)
          const col = idxInCluster % 4, row = Math.floor(idxInCluster / 4)
          const last = lastEventAt(session, c.events, t)
          const active = !!last && (t - new Date(last.createdAt).getTime()) < Math.max(1500, session.wallMs * 0.03)
          const flash = active ? flashColor(last) : undefined
          const grad = level >= stateCount
          return (
            <div key={c.cardId}
              title={c.label}
              className={`absolute rounded-full border text-[10px] px-1.5 py-0.5 whitespace-nowrap max-w-[7.5rem] truncate transition-all duration-500 ease-out ${
                grad ? 'bg-accent/25 border-accent/50 text-ink' : 'bg-surface-raised border-line/15 text-ink-muted'
              }`}
              style={{
                left: nodeX(level) + 4 + col * 28, top: TRACK_Y + 26 + row * 22,
                ...(flash ? { backgroundColor: flash + '40', borderColor: flash, color: 'var(--ink, #fff)' } : {}),
              }}>
              {c.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── 'climb': named lanes, cards rise/fall (the ladder metaphor, per state) ───

function ClimbView({ session, t }: { session: SessionSummary; t: number }) {
  const stateCount = Math.max(1, ...session.events.map(e => e.rungCount))
  const LANE_H = 44, CHIP_H = 22, CHIP_GAP = 6, GUTTER = 104
  const laneCount = stateCount + 1
  const laneTop = (level: number) => (stateCount - level) * LANE_H + 6

  const { colX, colW, totalW } = useMemo(() => {
    const xm = new Map<string, number>(), wm = new Map<string, number>()
    let x = GUTTER
    for (const c of session.cards) {
      const w = estChipWidth(c.label)
      xm.set(c.cardId, x); wm.set(c.cardId, w)
      x += w + CHIP_GAP
    }
    return { colX: xm, colW: wm, totalW: x }
  }, [session.cards])

  return (
    <div className="overflow-x-auto rounded-lg border border-line/10 bg-surface-deep/40">
      <div className="relative" style={{ height: laneCount * LANE_H + 12, width: totalW + 16, minWidth: '100%' }}>
        {Array.from({ length: laneCount }, (_, i) => {
          const level = stateCount - i
          return (
            <div key={i} className="absolute left-0 right-0 flex items-center" style={{ top: i * LANE_H + 6, height: LANE_H }}>
              <div className={`absolute inset-x-0 h-px ${level === stateCount ? 'bg-accent/30' : 'bg-line/10'}`} style={{ top: LANE_H - 6 }} />
              <span className={`sticky left-0 z-10 pl-2 pr-2 text-[10px] uppercase tracking-wider truncate ${level === stateCount ? 'text-accent' : 'text-ink-faint'}`} style={{ width: GUTTER }}>
                {laneName(session, level)}
              </span>
            </div>
          )
        })}
        {session.cards.map(c => {
          const level = Math.min(stateCount, cardLevelAt(c.events, t))
          const grad = level >= stateCount
          const last = lastEventAt(session, c.events, t)
          const active = !!last && (t - new Date(last.createdAt).getTime()) < Math.max(1500, session.wallMs * 0.03)
          const flash = active ? flashColor(last) : undefined
          return (
            <div key={c.cardId}
              title={c.label}
              className={`absolute flex items-center rounded-md px-2 text-[11px] font-medium whitespace-nowrap transition-all duration-500 ease-out border ${
                flash ? 'text-ink' : grad ? 'bg-accent/25 border-accent/50 text-ink' : 'bg-surface-raised border-line/15 text-ink-muted'
              }`}
              style={{
                top: laneTop(level) + (LANE_H - 12 - CHIP_H) / 2, left: colX.get(c.cardId), width: colW.get(c.cardId), height: CHIP_H,
                ...(flash ? { backgroundColor: flash + '40', borderColor: flash } : {}),
              }}>
              {c.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── 'trails': one step-trail per card over session time ──────────────────────

function TrailsView({ session, t, frac }: { session: SessionSummary; t: number; frac: number }) {
  const stateCount = Math.max(1, ...session.events.map(e => e.rungCount))
  const ROW_H = 34, LABEL_W = 118, PLOT_W = 560, PAD = 8
  const { start, wallMs } = session
  const xOf = (epoch: number) => LABEL_W + Math.max(0, Math.min(1, (epoch - start) / Math.max(1, wallMs))) * (PLOT_W - PAD)
  // Higher state = higher trail position within the row.
  const yOf = (rowIdx: number, level: number) => rowIdx * ROW_H + 6 + (ROW_H - 14) * (1 - Math.min(level, stateCount) / stateCount)

  return (
    <div className="overflow-x-auto rounded-lg border border-line/10 bg-surface-deep/40">
      <div className="relative" style={{ width: LABEL_W + PLOT_W, height: session.cards.length * ROW_H + 10, minWidth: '100%' }}>
        <svg className="absolute inset-0" width={LABEL_W + PLOT_W} height={session.cards.length * ROW_H + 10}>
          {session.cards.map((c, rowIdx) => {
            // Step path: level changes at each event time; drawn up to the playhead.
            const pts: { x: number; y: number }[] = []
            let level = c.events[0]?.fromRung ?? 0
            pts.push({ x: xOf(start), y: yOf(rowIdx, level) })
            for (const e of c.events) {
              const em = new Date(e.createdAt).getTime()
              if (em > t) break
              pts.push({ x: xOf(em), y: yOf(rowIdx, level) })   // horizontal to the event…
              level = e.toRung
              pts.push({ x: xOf(em), y: yOf(rowIdx, level) })   // …then the vertical hop
            }
            pts.push({ x: xOf(t), y: yOf(rowIdx, level) })
            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
            const graduatedNow = level >= stateCount
            return (
              <g key={c.cardId}>
                <line x1={LABEL_W} y1={rowIdx * ROW_H + ROW_H - 6} x2={LABEL_W + PLOT_W} y2={rowIdx * ROW_H + ROW_H - 6}
                  stroke="currentColor" className="text-line/10" strokeWidth={1} />
                <path d={d} fill="none" strokeWidth={2}
                  stroke={graduatedNow ? '#7C8CF8' : '#5A6478'} strokeLinejoin="round" opacity={0.9} />
                {/* Outcome ticks at each attempt */}
                {c.events.map(e => {
                  const em = new Date(e.createdAt).getTime()
                  if (em > t) return null
                  const color = e.overridden ? OUTCOME_COLOR.pass : e.outcome ? OUTCOME_COLOR[e.outcome] : '#5A6478'
                  return <circle key={e.id} cx={xOf(em)} cy={yOf(rowIdx, e.toRung)} r={3} fill={color} />
                })}
              </g>
            )
          })}
          {/* Playhead */}
          <line x1={LABEL_W + frac * (PLOT_W - PAD)} y1={0} x2={LABEL_W + frac * (PLOT_W - PAD)} y2={session.cards.length * ROW_H + 10}
            stroke="#7C8CF8" strokeWidth={1} opacity={0.6} />
        </svg>
        {/* Card labels (HTML for truncation) */}
        {session.cards.map((c, rowIdx) => {
          const level = Math.min(stateCount, cardLevelAt(c.events, t))
          const grad = level >= stateCount
          return (
            <div key={c.cardId}
              className={`absolute pl-2 pr-1 text-[11px] truncate ${grad ? 'text-accent' : 'text-ink-muted'}`}
              style={{ top: rowIdx * ROW_H + (ROW_H - 16) / 2, width: LABEL_W, height: 16 }}
              title={`${c.label} — ${grad ? 'graduated' : laneName(session, level)}`}>
              {grad ? '✓ ' : ''}{c.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}
