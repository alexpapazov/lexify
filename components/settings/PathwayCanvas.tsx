'use client'

import type { Pathway, PathwayState, PathwayCondition, PathwayPredicate } from '@/domain'

/**
 * A read-only visual map of a pathway: circles = states, squares = graduation-interval-setting states,
 * a distinct node = the graduation terminal, arrows = transitions. Click a node to edit that state; click
 * an edge to jump to its source state. Hover a node/edge for the full spec (native tooltip). Auto-laid-out
 * in BFS layers from the start state — good enough to see the structure without a full graph editor.
 */

const RATING_LABEL: Record<string, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' }
const COUNTER_LABEL: Record<string, string> = { consecutiveGood: 'correct in a row', consecutiveAgain: 'wrong in a row', totalGood: 'correct', totalAgain: 'wrong' }

function predText(p: PathwayPredicate): string {
  switch (p.kind) {
    case 'rating':          return RATING_LABEL[p.is] ?? p.is
    case 'correct':         return p.is ? 'correct' : 'wrong'
    case 'errorType':       return `${p.is.replace('_', ' ')} error`
    case 'counter':         return `${p.gte} ${COUNTER_LABEL[p.name] ?? p.name}`
    case 'attemptsInState': return `≥${p.gte} tries`
  }
}
export function conditionText(when: PathwayCondition): string {
  return when.length === 0 ? 'always' : when.map(predText).join(' & ')
}

// Layout constants.
const COL = 150, ROW = 130, R = 30, PAD = 40

/** BFS depth of each state from the start; unreachable states land in a trailing layer. */
function layerOf(pathway: Pathway): Map<string, number> {
  const layer = new Map<string, number>([[pathway.startStateId, 0]])
  const q = [pathway.startStateId]
  while (q.length) {
    const u = q.shift()!
    const d = layer.get(u)!
    for (const t of pathway.transitions) {
      if (t.from !== u) continue
      if (!layer.has(t.to)) { layer.set(t.to, d + 1); q.push(t.to) }
    }
  }
  const maxD = Math.max(0, ...[...layer.values()])
  for (const s of pathway.states) if (!layer.has(s.id)) layer.set(s.id, maxD + 1)   // orphans
  return layer
}

export function PathwayCanvas({ pathway, selectedStateId, onSelectState }: {
  pathway: Pathway
  selectedStateId: string | null
  onSelectState: (id: string) => void
}) {
  const layer = layerOf(pathway)
  // Group states by layer, terminals pushed to the last layer.
  const byLayer = new Map<number, PathwayState[]>()
  const maxLayer = Math.max(0, ...[...layer.values()])
  for (const s of pathway.states) {
    const l = s.isTerminal ? maxLayer : (layer.get(s.id) ?? 0)
    const arr = byLayer.get(l) ?? []; arr.push(s); byLayer.set(l, arr)
  }
  const pos = new Map<string, { x: number; y: number }>()
  const widest = Math.max(1, ...[...byLayer.values()].map(a => a.length))
  for (const [l, arr] of byLayer) {
    arr.forEach((s, i) => {
      // centre each layer's row within the widest row
      const offset = (widest - arr.length) / 2
      pos.set(s.id, { x: PAD + (i + offset) * COL + R, y: PAD + l * ROW + R })
    })
  }
  const width = PAD * 2 + widest * COL
  const height = PAD * 2 + (maxLayer + 1) * ROW

  const specOf = (s: PathwayState): string => s.isTerminal
    ? 'Graduation — hands the card to spaced review.'
    : [`${s.type}`, s.direction === 'produce_target' ? 'produce target' : 'produce native',
       s.selfRated ? 'rating buttons' : 'auto-checked',
       s.intervalInit ? 'sets graduation interval' : '',
       s.strictness ? `strictness: ${s.strictness.spelling}/${s.strictness.accents}/${s.strictness.articles}` : ''
      ].filter(Boolean).join(' · ')

  return (
    <div className="panel overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ minWidth: width, maxHeight: 460 }}>
        <defs>
          <marker id="pw-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="fill-ink-faint" />
          </marker>
        </defs>

        {/* Edges */}
        {pathway.transitions.map(t => {
          const a = pos.get(t.from), b = pos.get(t.to)
          if (!a || !b) return null
          if (t.from === t.to) {
            // self-loop: a little arc to the right of the node
            return (
              <g key={t.id} onClick={() => onSelectState(t.from)} className="cursor-pointer">
                <title>{conditionText(t.when)}</title>
                <path d={`M ${a.x + R} ${a.y - 8} a 18 18 0 1 1 -6 -${R - 8}`} fill="none" className="stroke-ink-faint" strokeWidth={1.5} markerEnd="url(#pw-arrow)" opacity={0.6} />
              </g>
            )
          }
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
          // shorten the line so the arrowhead sits at the node edge
          const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
          const bx = b.x - (dx / len) * (R + 4), by = b.y - (dy / len) * (R + 4)
          return (
            <g key={t.id} onClick={() => onSelectState(t.from)} className="cursor-pointer">
              <title>{`${conditionText(t.when)} → ${pathway.states.find(s => s.id === t.to)?.name ?? '?'}`}</title>
              <line x1={a.x} y1={a.y} x2={bx} y2={by} className="stroke-ink-faint" strokeWidth={1.5} markerEnd="url(#pw-arrow)" opacity={0.6} />
              <text x={mx} y={my - 3} textAnchor="middle" className="fill-ink-faint" fontSize={9}>{conditionText(t.when)}</text>
            </g>
          )
        })}

        {/* Nodes */}
        {pathway.states.map(s => {
          const p = pos.get(s.id); if (!p) return null
          const sel = s.id === selectedStateId
          const stroke = sel ? 'stroke-accent' : s.isTerminal ? 'stroke-success' : s.intervalInit ? 'stroke-warning' : 'stroke-line/40'
          const fill = sel ? 'fill-accent/20' : 'fill-surface-raised'
          return (
            <g key={s.id} onClick={() => onSelectState(s.id)} className="cursor-pointer">
              <title>{specOf(s)}</title>
              {s.intervalInit && !s.isTerminal
                ? <rect x={p.x - R} y={p.y - R} width={R * 2} height={R * 2} rx={6} className={`${fill} ${stroke}`} strokeWidth={sel ? 2.5 : 1.5} />
                : <circle cx={p.x} cy={p.y} r={R} className={`${fill} ${stroke}`} strokeWidth={sel ? 2.5 : 1.5} />}
              {s.id === pathway.startStateId && <circle cx={p.x} cy={p.y - R - 6} r={3} className="fill-accent" />}
              <text x={p.x} y={p.y + 3} textAnchor="middle" className="fill-ink" fontSize={10} style={{ pointerEvents: 'none' }}>
                {(s.isTerminal ? '🎓 ' : '') + (s.name.length > 12 ? s.name.slice(0, 11) + '…' : s.name)}
              </text>
            </g>
          )
        })}
      </svg>
      <p className="text-[10px] text-ink-faint mt-1">
        ● state&nbsp;&nbsp;▢ sets interval&nbsp;&nbsp;🎓 graduation&nbsp;&nbsp;· dot marks the start · click a node to edit it, an arrow to edit its source
      </p>
    </div>
  )
}
