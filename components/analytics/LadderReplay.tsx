'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { cardLevelAt, type SessionSummary } from '@/lib/ladderLog'

const LANE_H = 44
const CHIP_GAP = 6  // horizontal space between columns
const CHIP_H = 22   // chip height — kept skinny so the word isn't swimming in empty space
const GUTTER = 76   // left label gutter

/** Estimate a chip's width from its text (11px medium) so columns fit each word without truncating.
 *  CJK / Hangul / Kana glyphs are ~full-width; Latin/Cyrillic ~0.6em. Plus px-2 padding + border. */
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

// Flash colour when a card just moved, by the rating/outcome of that attempt.
const OUTCOME_COLOR: Record<string, string> = {
  again: '#F05068', miss: '#F05068',                      // wrong / mess-up → red
  almost: '#F0883E', hard: '#F0883E',                     // near-miss / hard → orange
  pass:  '#4ADE80', good: '#4ADE80',                      // correct / good → green
  easy:  '#4C8DFF',                                       // easy → blue
}
const LEGEND: { label: string; color: string }[] = [
  { label: 'Again / miss', color: '#F05068' },
  { label: 'Almost / Hard', color: '#F0883E' },
  { label: 'Correct / Good', color: '#4ADE80' },
  { label: 'Easy', color: '#4C8DFF' },
]

function fmtClock(msSpan: number): string {
  const s = Math.max(0, Math.round(msSpan / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * A scrubbable replay of one ladder session: each card owns a column and rises/falls between rung
 * "lanes" as you drag the time bar (or press Play). Top lane = graduated. Purely visual.
 */
export function LadderReplay({ session }: { session: SessionSummary }) {
  const { rungCount, cards, start, wallMs } = session
  const [frac, setFrac] = useState(1)          // 0..1 position along the session's timeline
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef<number | null>(null)
  const playStartRef = useRef(0)

  const t = start + frac * Math.max(1, wallMs)
  const laneCount = rungCount + 1              // rungs 0..n-1 + graduated
  const laneTop = (level: number) => (rungCount - level) * LANE_H + 6

  // Stable column X per card (first-seen order) so movement reads as vertical climbing. Each column is
  // sized to ITS word (estimated) — tight for short words, wide enough for long ones — so nothing is
  // truncated and short words don't leave big gaps.
  const { colX, colW, totalW } = useMemo(() => {
    const xm = new Map<string, number>(), wm = new Map<string, number>()
    let x = GUTTER
    for (const c of cards) {
      const w = estChipWidth(c.label)
      xm.set(c.cardId, x); wm.set(c.cardId, w)
      x += w + CHIP_GAP
    }
    return { colX: xm, colW: wm, totalW: x }
  }, [cards])

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

  const laneLabel = (level: number) => level === rungCount ? '✓ Grad' : `Rung ${level + 1}`
  const containerW = totalW + 16

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => { if (frac >= 1) setFrac(0); setPlaying(p => !p) }}
          className="btn-primary text-xs py-1.5 px-3 shrink-0">
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <input
          type="range" min={0} max={1000} value={Math.round(frac * 1000)}
          onChange={e => { setPlaying(false); setFrac(Number(e.target.value) / 1000) }}
          className="flex-1 accent-accent" />
        <span className="text-xs text-ink-muted tabular-nums w-16 text-right">
          {fmtClock(frac * wallMs)} / {fmtClock(wallMs)}
        </span>
      </div>

      {/* Rating colour legend */}
      <div className="flex flex-wrap gap-3 text-[11px] text-ink-faint">
        {LEGEND.map(l => (
          <span key={l.label} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: l.color }} />
            {l.label}
          </span>
        ))}
      </div>

      {/* Ladder */}
      <div className="overflow-x-auto rounded-lg border border-line/10 bg-surface-deep/40">
        <div className="relative" style={{ height: laneCount * LANE_H + 12, width: containerW, minWidth: '100%' }}>
          {/* Lane stripes + labels */}
          {Array.from({ length: laneCount }, (_, i) => {
            const level = rungCount - i               // top row = graduated
            return (
              <div key={i} className="absolute left-0 right-0 flex items-center" style={{ top: i * LANE_H + 6, height: LANE_H }}>
                <div className={`absolute inset-x-0 h-px ${level === rungCount ? 'bg-accent/30' : 'bg-line/10'}`} style={{ top: LANE_H - 6 }} />
                <span className={`sticky left-0 z-10 pl-2 pr-2 text-[10px] uppercase tracking-wider ${level === rungCount ? 'text-accent' : 'text-ink-faint'}`} style={{ width: GUTTER }}>
                  {laneLabel(level)}
                </span>
              </div>
            )
          })}
          {/* Cards */}
          {cards.map(c => {
            // Auto-graduated cards graduate in one jump (0 → GRAD) without occupying any intermediate
            // rung — so instead of popping to the top at some mid-movie event time (which reads as
            // "frozen"), spring them straight to GRAD at the very start of the movie.
            const climbed = c.events.some(e => e.toRung > 0 && e.toRung < rungCount)
            const level = (c.graduated && !climbed)
              ? (t <= start ? 0 : rungCount)
              : cardLevelAt(c.events, t)
            const grad = level >= rungCount
            // A card "pulses" briefly right after an attempt lands, coloured by that attempt's rating.
            const lastEvt = c.events.filter(e => new Date(e.createdAt).getTime() <= t).slice(-1)[0]
            const active = !!lastEvt && (t - new Date(lastEvt.createdAt).getTime()) < Math.max(1500, wallMs * 0.03)
            // An overridden attempt flashes as "correct" (the overridden result), not its natural grade.
            const flash = active
              ? (lastEvt?.overridden ? OUTCOME_COLOR.pass : lastEvt?.outcome ? OUTCOME_COLOR[lastEvt.outcome] : undefined)
              : undefined
            return (
              <div
                key={c.cardId}
                title={`${c.label} — ${c.attempts} attempt${c.attempts === 1 ? '' : 's'}, ${fmtClock(c.activeMs)}`}
                className={`absolute flex items-center rounded-md px-2 text-[11px] font-medium whitespace-nowrap transition-all duration-500 ease-out border ${
                  flash ? 'text-ink' : grad ? 'bg-accent/25 border-accent/50 text-ink' : 'bg-surface-raised border-line/15 text-ink-muted'
                }`}
                style={{
                  // Column X + width fit the word exactly (no truncation, tight columns). Skinny height.
                  top: laneTop(level) + (LANE_H - 12 - CHIP_H) / 2, left: colX.get(c.cardId) ?? GUTTER,
                  width: colW.get(c.cardId), height: CHIP_H,
                  ...(flash ? { backgroundColor: flash + '40', borderColor: flash } : {}),
                }}>
                {c.label}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
