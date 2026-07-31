'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Pathway, PathwayState, PathwayCondition, PathwayPredicate } from '@/domain'

/**
 * The visual map of a pathway. Big nodes on a snap grid: circles = states, squares = graduation-interval
 * setters, a green node = graduation. Drag a node to reposition it (snaps to the grid; the position is
 * saved on the state). Click a node to edit it; click an edge to jump to its source. Nodes without a saved
 * position are auto-laid-out: the main forward path runs left→right (wrapping to a new band when long) and
 * everything else branches downward.
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
function conditionText(when: PathwayCondition): string {
  return when.length === 0 ? 'always' : when.map(predText).join(' & ')
}

// Grid geometry.
const CELL_X = 110, CELL_Y = 100, R = 18, MARGIN = 55, WRAP = 8, BAND_GAP = 3

type GridPos = { col: number; row: number }

/** BFS depth of each state from the start; unreachable states get the max depth + 1. */
function layersOf(pathway: Pathway): Map<string, number> {
  const layer = new Map<string, number>([[pathway.startStateId, 0]])
  const q = [pathway.startStateId]
  while (q.length) {
    const u = q.shift()!
    const d = layer.get(u)!
    for (const t of pathway.transitions) {
      if (t.from === u || layer.has(t.to)) continue
      layer.set(t.to, d + 1); q.push(t.to)
    }
  }
  const maxD = Math.max(0, ...[...layer.values()])
  for (const s of pathway.states) if (!layer.has(s.id)) layer.set(s.id, maxD + 1)
  return layer
}

/** Auto grid position for any state without a saved `pos`: main line horizontal (wrapping), branches below. */
function autoLayout(pathway: Pathway): Map<string, GridPos> {
  const layer = layersOf(pathway)
  const lvl = (id: string) => layer.get(id) ?? 0

  // Trace the "spine": follow forward edges (closest layer, then lowest priority) from the start.
  const spine: string[] = []
  const onSpine = new Set<string>()
  let cur: string | null = pathway.startStateId
  while (cur && !onSpine.has(cur)) {
    spine.push(cur); onSpine.add(cur)
    const fwd = pathway.transitions
      .filter(t => t.from === cur && !onSpine.has(t.to) && lvl(t.to) > lvl(cur!))
      .sort((a, b) => (lvl(a.to) - lvl(b.to)) || (a.priority - b.priority))
    cur = fwd[0]?.to ?? null
  }

  const pos = new Map<string, GridPos>()
  const occ = new Set<string>()
  const claim = (col: number, row: number): GridPos => {
    let r = row
    while (occ.has(`${col},${r}`)) r++
    occ.add(`${col},${r}`); return { col, row: r }
  }

  // Spine laid left→right, snaking onto a new band every WRAP nodes.
  spine.forEach((id, i) => {
    const band = Math.floor(i / WRAP)
    const within = i % WRAP
    const col = band % 2 === 1 ? WRAP - 1 - within : within
    pos.set(id, claim(col, band * BAND_GAP))
  })

  // Everything else hangs one row below an already-placed source (in layer order).
  pathway.states
    .filter(s => !onSpine.has(s.id))
    .sort((a, b) => lvl(a.id) - lvl(b.id))
    .forEach(s => {
      const inc = pathway.transitions.find(t => t.to === s.id && pos.has(t.from))
      const base = inc ? pos.get(inc.from)! : { col: 0, row: 0 }
      pos.set(s.id, claim(base.col, base.row + 1))
    })

  for (const s of pathway.states) if (!pos.has(s.id)) pos.set(s.id, claim(0, 0))
  return pos
}

export function PathwayCanvas({ pathway, selectedStateId, onSelectState, onMoveState, onAddTransition }: {
  pathway: Pathway
  selectedStateId: string | null
  onSelectState: (id: string) => void
  onMoveState: (id: string, pos: GridPos) => void
  onAddTransition: (from: string, to: string) => void
}) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const auto = useMemo(() => autoLayout(pathway), [pathway])
  const [drag, setDrag] = useState<{ id: string; col: number; row: number; startCol: number; startRow: number } | null>(null)
  // Double-click-drag from a node draws a new transition; the arrow tracks the cursor until it's dropped.
  const [link, setLink] = useState<{ fromId: string; x: number; y: number; overId: string | null } | null>(null)
  const lastDown = useRef<{ id: string; t: number } | null>(null)

  const gridOf = (id: string): GridPos => {
    if (drag && drag.id === id) return { col: drag.col, row: drag.row }
    const s = pathway.states.find(x => x.id === id)
    return s?.pos ?? auto.get(id) ?? { col: 0, row: 0 }
  }
  const px = (g: GridPos) => ({ x: MARGIN + g.col * CELL_X, y: MARGIN + g.row * CELL_Y })
  const posOf = (id: string) => px(gridOf(id))
  const toSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!svg || !ctm) return null
    const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY
    return pt.matrixTransform(ctm.inverse())
  }
  const nodeUnder = (x: number, y: number): string | null => {
    for (const s of pathway.states) { const q = posOf(s.id); if (Math.hypot(q.x - x, q.y - y) <= R) return s.id }
    return null
  }

  const maxCol = Math.max(0, ...pathway.states.map(s => gridOf(s.id).col))
  const maxRow = Math.max(0, ...pathway.states.map(s => gridOf(s.id).row))
  // Always at least a full band wide so a sparse map isn't upscaled to fill the container.
  const width = MARGIN * 2 + Math.max(maxCol, WRAP - 1) * CELL_X
  const height = MARGIN * 2 + maxRow * CELL_Y

  // Pre-place each edge label, then push overlapping ones apart so pills don't stack.
  const edgeLabels = new Map<string, { cx: number; cy: number; w: number; h: number; text: string }>()
  {
    const arr: { id: string; cx: number; cy: number; w: number; h: number; text: string }[] = []
    for (const t of pathway.transitions) {
      if (t.from === t.to) continue
      const a = posOf(t.from), b = posOf(t.to)
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
      const ax = a.x + (dx / len) * R, ay = a.y + (dy / len) * R
      const bx = b.x - (dx / len) * (R + 6), by = b.y - (dy / len) * (R + 6)
      const nx = -dy / len, ny = dx / len
      const text = conditionText(t.when)
      arr.push({ id: t.id, cx: ax + (bx - ax) * 0.42 + nx * 12, cy: ay + (by - ay) * 0.42 + ny * 12, w: text.length * 4.6 + 8, h: 13, text })
    }
    for (let it = 0; it < 60; it++) {
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const A = arr[i]!, B = arr[j]!
        const dcx = B.cx - A.cx, dcy = B.cy - A.cy
        const ox = (A.w + B.w) / 2 - Math.abs(dcx), oy = (A.h + B.h) / 2 - Math.abs(dcy)
        if (ox > 0 && oy > 0) {
          if (oy <= ox) { const p = (oy / 2 + 0.5) * (dcy >= 0 ? 1 : -1); A.cy -= p; B.cy += p }
          else { const p = (ox / 2 + 0.5) * (dcx >= 0 ? 1 : -1); A.cx -= p; B.cx += p }
        }
      }
    }
    for (const l of arr) edgeLabels.set(l.id, l)
  }

  // Drag handling — snap to grid on pointer move; commit (or select if it never moved) on release.
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const p = toSvg(e.clientX, e.clientY)
      if (!p) return
      const col = Math.max(0, Math.round((p.x - MARGIN) / CELL_X))
      const row = Math.max(0, Math.round((p.y - MARGIN) / CELL_Y))
      setDrag(d => (d && (d.col !== col || d.row !== row)) ? { ...d, col, row } : d)
    }
    const up = () => {
      setDrag(d => {
        if (d) {
          if (d.col !== d.startCol || d.row !== d.startRow) onMoveState(d.id, { col: d.col, row: d.row })
          else onSelectState(d.id)
        }
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [drag, onMoveState, onSelectState]) // eslint-disable-line react-hooks/exhaustive-deps

  // Linking — the arrow follows the cursor; dropping on another state creates a transition to it.
  useEffect(() => {
    if (!link) return
    const move = (e: PointerEvent) => {
      const p = toSvg(e.clientX, e.clientY)
      if (!p) return
      const over = nodeUnder(p.x, p.y)
      setLink(l => l ? { ...l, x: p.x, y: p.y, overId: over } : l)
    }
    const up = () => {
      setLink(l => {
        if (l && l.overId && l.overId !== l.fromId) onAddTransition(l.fromId, l.overId)
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [link, onAddTransition]) // eslint-disable-line react-hooks/exhaustive-deps

  const specOf = (s: PathwayState): string => s.isTerminal
    ? 'Graduation — hands the card to spaced review.'
    : [`${s.type}`, s.direction === 'produce_target' ? 'produce target' : 'produce native',
       s.selfRated ? 'rating buttons' : 'auto-checked',
       s.intervalInit ? 'sets graduation interval' : '',
      ].filter(Boolean).join(' · ')

  const startId = pathway.startStateId

  return (
    <div className="overflow-y-auto overflow-x-hidden rounded-card border border-line/10 bg-surface-sunken/40" style={{ maxHeight: 620 }}>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMin meet" style={{ display: 'block', width: '100%', height: 'auto', touchAction: 'none' }}>
        <defs>
          <marker id="pw-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
            <path d="M0,0 L9,4.5 L0,9 z" className="fill-ink-faint" />
          </marker>
          <marker id="pw-arrow-accent" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
            <path d="M0,0 L9,4.5 L0,9 z" className="fill-accent" />
          </marker>
        </defs>

        {/* Snap-grid dots */}
        {Array.from({ length: maxRow + 1 }).map((_, r) =>
          Array.from({ length: maxCol + 1 }).map((_, c) => {
            const { x, y } = px({ col: c, row: r })
            return <circle key={`g${c}-${r}`} cx={x} cy={y} r={2} className="fill-line/15" />
          }),
        )}

        {/* Edges */}
        {pathway.transitions.map(t => {
          const a = posOf(t.from), b = posOf(t.to)
          if (t.from === t.to) {
            return (
              <g key={t.id} onClick={() => onSelectState(t.from)} className="cursor-pointer">
                <title>{conditionText(t.when)}</title>
                <path d={`M ${a.x + R} ${a.y - 6} a 13 13 0 1 1 -6 -${R - 5}`} fill="none" className="stroke-ink-faint" strokeWidth={1.5} markerEnd="url(#pw-arrow)" opacity={0.6} />
              </g>
            )
          }
          const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
          const ax = a.x + (dx / len) * R, ay = a.y + (dy / len) * R
          const bx = b.x - (dx / len) * (R + 6), by = b.y - (dy / len) * (R + 6)
          const lp = edgeLabels.get(t.id)!
          const label = lp.text
          return (
            <g key={t.id} onClick={() => onSelectState(t.from)} className="cursor-pointer">
              <title>{`${label} → ${pathway.states.find(s => s.id === t.to)?.name ?? '?'}`}</title>
              <line x1={ax} y1={ay} x2={bx} y2={by} className="stroke-ink-faint" strokeWidth={1.5} markerEnd="url(#pw-arrow)" opacity={0.55} />
              <g transform={`translate(${lp.cx}, ${lp.cy})`}>
                <rect x={-lp.w / 2} y={-7} width={lp.w} height={12} rx={3} className="fill-surface-sunken" opacity={0.92} />
                <text textAnchor="middle" y={1.5} className="fill-ink-muted" fontSize={8}>{label}</text>
              </g>
            </g>
          )
        })}

        {/* Nodes */}
        {pathway.states.map(s => {
          const p = posOf(s.id)
          const sel = s.id === selectedStateId
          const linkTarget = link != null && link.overId === s.id && link.fromId !== s.id
          const linkSource = link?.fromId === s.id
          const stroke = (sel || linkTarget || linkSource) ? 'stroke-accent' : s.isTerminal ? 'stroke-success' : s.intervalInit ? 'stroke-warning' : 'stroke-line/40'
          const fill = linkTarget ? 'fill-accent/30' : sel ? 'fill-accent/20' : s.isTerminal ? 'fill-success/10' : 'fill-surface-raised'
          const sw = (sel || linkTarget) ? 3 : 1.75
          const label = s.name.length > 9 ? s.name.slice(0, 8) + '…' : s.name
          const dragging = drag?.id === s.id
          return (
            <g key={s.id}
              className={dragging ? 'cursor-grabbing' : 'cursor-grab'}
              onPointerDown={(e) => {
                e.preventDefault()
                const isDouble = lastDown.current?.id === s.id && (e.timeStamp - lastDown.current.t) < 400
                lastDown.current = { id: s.id, t: e.timeStamp }
                if (isDouble) {
                  const c = posOf(s.id)
                  setLink({ fromId: s.id, x: c.x, y: c.y, overId: null })
                } else {
                  const g = gridOf(s.id)
                  setDrag({ id: s.id, col: g.col, row: g.row, startCol: g.col, startRow: g.row })
                }
              }}>
              <title>{specOf(s)}</title>
              {s.intervalInit && !s.isTerminal
                ? <rect x={p.x - R} y={p.y - R} width={R * 2} height={R * 2} rx={12} className={`${fill} ${stroke}`} strokeWidth={sw} />
                : <circle cx={p.x} cy={p.y} r={R} className={`${fill} ${stroke}`} strokeWidth={sw} />}
              {s.id === startId && <circle cx={p.x} cy={p.y - R - 5} r={2.75} className="fill-accent" />}
              <text x={p.x} y={s.isTerminal ? p.y - 1 : p.y + 3} textAnchor="middle" className="fill-ink font-medium" fontSize={9} style={{ pointerEvents: 'none' }}>
                {s.isTerminal ? '🎓' : label}
              </text>
              {s.isTerminal && <text x={p.x} y={p.y + 9} textAnchor="middle" className="fill-ink-muted" fontSize={7} style={{ pointerEvents: 'none' }}>{label}</text>}
            </g>
          )
        })}

        {/* Live arrow while linking (double-click-drag) */}
        {link && (() => {
          const from = posOf(link.fromId)
          return <line x1={from.x} y1={from.y} x2={link.x} y2={link.y}
            className="stroke-accent" strokeWidth={2} strokeDasharray="5 3" markerEnd="url(#pw-arrow-accent)" style={{ pointerEvents: 'none' }} />
        })()}
      </svg>
    </div>
  )
}
