'use client'

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { displayText } from '@/lib/cardText'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GNode {
  id: string
  label: string
  sub:   string
  x: number; y: number; vx: number; vy: number
}

interface GEdge {
  s: string; t: string
  type: 'synonym' | 'confusion'
}

// ─── Force layout ─────────────────────────────────────────────────────────────

function forceLayout(nodes: GNode[], edges: GEdge[], W: number, H: number) {
  const n = nodes.length
  if (n === 0) return
  if (n === 1) { nodes[0]!.x = W / 2; nodes[0]!.y = H / 2; return }

  // Circular init — avoids ring formation from random starts
  const cx = W / 2, cy = H / 2
  const R  = Math.min(W, H) * 0.38
  nodes.forEach((nd, i) => {
    const a = (2 * Math.PI * i) / n
    nd.x = cx + R * Math.cos(a)
    nd.y = cy + R * Math.sin(a)
    nd.vx = 0; nd.vy = 0
  })

  const k       = Math.sqrt((W * H) / n) * 0.85
  const nodeMap = new Map(nodes.map(nd => [nd.id, nd]))
  let   temp    = W / 6
  const ITERS   = 450
  const cooling = temp / ITERS

  for (let iter = 0; iter < ITERS; iter++) {
    for (const nd of nodes) { nd.vx = 0; nd.vy = 0 }

    // Repulsion — push every pair apart
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const u = nodes[i]!, v = nodes[j]!
        const dx = u.x - v.x || 0.01
        const dy = u.y - v.y || 0.01
        const d  = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f  = (k * k) / d
        const fx = (dx / d) * f, fy = (dy / d) * f
        u.vx += fx; u.vy += fy
        v.vx -= fx; v.vy -= fy
      }
    }

    // Attraction along edges — pull connected nodes together
    for (const e of edges) {
      const u = nodeMap.get(e.s), v = nodeMap.get(e.t)
      if (!u || !v) continue
      const dx = v.x - u.x, dy = v.y - u.y
      const d  = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f  = (d * d) / k
      const fx = (dx / d) * f, fy = (dy / d) * f
      u.vx += fx; u.vy += fy
      v.vx -= fx; v.vy -= fy
    }

    // Gravity toward center — prevents components from drifting to edges
    const g = 0.05
    for (const nd of nodes) {
      nd.vx += (cx - nd.x) * g
      nd.vy += (cy - nd.y) * g
    }

    // Apply with temperature clamping — soft boundary (not hard clamp every iter)
    for (const nd of nodes) {
      const mag   = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy) || 0.01
      const scale = Math.min(mag, temp) / mag
      nd.x += nd.vx * scale
      nd.y += nd.vy * scale
    }

    temp -= cooling
  }

  // Final hard clamp — only once, after all iterations
  const pad = 68
  for (const nd of nodes) {
    nd.x = Math.max(pad, Math.min(W - pad, nd.x))
    nd.y = Math.max(24,  Math.min(H - 24,  nd.y))
  }
}

// ─── BFS to get a node's connected component ─────────────────────────────────

function getComponent(startId: string, edges: GEdge[], allIds: Set<string>): Set<string> {
  const visited = new Set<string>()
  const queue   = [startId]
  while (queue.length) {
    const id = queue.pop()!
    if (visited.has(id) || !allIds.has(id)) continue
    visited.add(id)
    for (const e of edges) {
      if (e.s === id && !visited.has(e.t)) queue.push(e.t)
      if (e.t === id && !visited.has(e.s)) queue.push(e.s)
    }
  }
  return visited
}

// ─── SVG coordinate conversion ───────────────────────────────────────────────

function toSvgCoords(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const pt  = svg.createSVGPoint()
  pt.x = clientX; pt.y = clientY
  const ctm = svg.getScreenCTM()
  if (!ctm) return { x: clientX, y: clientY }
  const p = pt.matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const W         = 740
const H         = 520
const SYN_COLOR = '#10b981'
const CON_COLOR = '#f59e0b'
const POS_KEY   = (uid: string) => `lexify_graph_pos_${uid}`

// ─── Component ────────────────────────────────────────────────────────────────

export function ConnectionGraph({ userId }: { userId: string }) {
  const [nodes,   setNodes]   = useState<GNode[]>([])
  const [edges,   setEdges]   = useState<GEdge[]>([])
  const [loading, setLoading] = useState(true)
  const [showSyn, setShowSyn] = useState(true)
  const [showCon, setShowCon] = useState(true)
  const [hovered, setHovered] = useState<string | null>(null)

  const svgRef    = useRef<SVGSVGElement>(null)
  const nodesRef  = useRef<GNode[]>([])   // mirrors state without triggering re-renders during drag
  const edgesRef  = useRef<GEdge[]>([])
  const dragRef   = useRef<{
    nodeId:    string
    movers:    Set<string>                              // ids being translated
    startSvg:  { x: number; y: number }               // SVG coords at drag start
    origins:   Map<string, { x: number; y: number }>  // each mover's position at drag start
  } | null>(null)

  function savedPositions(): Record<string, { x: number; y: number }> | null {
    try {
      const raw = localStorage.getItem(POS_KEY(userId))
      return raw ? (JSON.parse(raw) as Record<string, { x: number; y: number }>) : null
    } catch { return null }
  }

  function persistPositions(ns: GNode[]) {
    const out: Record<string, { x: number; y: number }> = {}
    for (const n of ns) out[n.id] = { x: n.x, y: n.y }
    localStorage.setItem(POS_KEY(userId), JSON.stringify(out))
  }

  function resetLayout() {
    localStorage.removeItem(POS_KEY(userId))
    const ns = nodesRef.current.map(n => ({ ...n, vx: 0, vy: 0 }))
    forceLayout(ns, edgesRef.current, W, H)
    nodesRef.current = ns
    setNodes([...ns])
    persistPositions(ns)
  }

  useEffect(() => {
    async function load() {
      const db = createClient()

      const { data: confLinks } = await db
        .from('card_confusion_links')
        .select('card_a_id, card_b_id')
        .eq('user_id', userId)

      const { data: allCards } = await db
        .from('cards')
        .select('id, front, back, choices')
        .eq('owner_id', userId)
        .is('deleted_at', null)

      const cardIndex = new Map(
        (allCards ?? []).map(c => [
          c.id as string,
          { id: c.id as string, front: displayText(c.front as string), back: displayText(c.back as string) },
        ])
      )

      // Synonym edges
      const synEdges: GEdge[] = []
      const synNodeIds = new Set<string>()
      if (allCards) {
        const backToId = new Map<string, string>()
        for (const c of allCards) backToId.set(displayText(c.back as string).toLowerCase(), c.id as string)
        const seen = new Set<string>()
        for (const c of allCards) {
          const syns: string[] = (c.choices as { backSynonyms?: string[] } | null)?.backSynonyms ?? []
          for (const syn of syns) {
            const otherId = backToId.get(syn.toLowerCase())
            if (!otherId || otherId === c.id) continue
            const key = [c.id as string, otherId].sort().join('|')
            if (seen.has(key)) continue
            seen.add(key)
            const [a, b] = [c.id as string, otherId].sort() as [string, string]
            synEdges.push({ s: a, t: b, type: 'synonym' })
            synNodeIds.add(c.id as string)
            synNodeIds.add(otherId)
          }
        }
      }

      // Confusion edges
      const confEdges: GEdge[] = (confLinks ?? []).map(l => ({
        s: l.card_a_id as string,
        t: l.card_b_id as string,
        type: 'confusion' as const,
      }))
      const confNodeIds = new Set(confEdges.flatMap(e => [e.s, e.t]))

      const allNodeIds = new Set([...synNodeIds, ...confNodeIds])
      if (allNodeIds.size === 0) { setLoading(false); return }

      const allEdges = [...synEdges, ...confEdges]
      const rawNodes: GNode[] = [...allNodeIds].map(id => {
        const c = cardIndex.get(id)
        return { id, label: c?.front ?? '?', sub: c?.back ?? '', x: 0, y: 0, vx: 0, vy: 0 }
      })

      // Apply saved positions if any; run layout for new nodes
      const saved = savedPositions()
      if (saved) {
        const missingInit: GNode[] = []
        for (const nd of rawNodes) {
          const p = saved[nd.id]
          if (p) { nd.x = p.x; nd.y = p.y }
          else   { nd.x = W / 2 + (Math.random() - 0.5) * 120; nd.y = H / 2 + (Math.random() - 0.5) * 120; missingInit.push(nd) }
        }
        // Mini layout pass just for any new nodes (50 iters with fixed anchors)
        if (missingInit.length > 0) {
          const tempEdges = allEdges.filter(e => missingInit.some(n => n.id === e.s || n.id === e.t))
          forceLayout(missingInit, tempEdges, W, H)
        }
      } else {
        forceLayout(rawNodes, allEdges, W, H)
      }

      nodesRef.current = rawNodes
      edgesRef.current = allEdges
      setNodes(rawNodes)
      setEdges(allEdges)
      setLoading(false)
    }
    void load()
  }, [userId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drag handlers ──────────────────────────────────────────────────────────

  function onNodeMouseDown(e: React.MouseEvent, nodeId: string) {
    e.preventDefault()
    e.stopPropagation()
    if (!svgRef.current) return

    const isCluster = e.shiftKey
    const allIds    = new Set(nodesRef.current.map(n => n.id))
    const movers    = isCluster ? getComponent(nodeId, edgesRef.current, allIds) : new Set([nodeId])
    const startSvg  = toSvgCoords(svgRef.current, e.clientX, e.clientY)
    const origins   = new Map<string, { x: number; y: number }>()

    for (const id of movers) {
      const nd = nodesRef.current.find(n => n.id === id)
      if (nd) origins.set(id, { x: nd.x, y: nd.y })
    }

    dragRef.current = { nodeId, movers, startSvg, origins }
    setHovered(nodeId)
  }

  function onSvgMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const d = dragRef.current
    if (!d || !svgRef.current) return

    const cur  = toSvgCoords(svgRef.current, e.clientX, e.clientY)
    const dx   = cur.x - d.startSvg.x
    const dy   = cur.y - d.startSvg.y
    const pad  = 68

    const next = nodesRef.current.map(nd => {
      if (!d.movers.has(nd.id)) return nd
      const o = d.origins.get(nd.id)!
      return {
        ...nd,
        x: Math.max(pad,     Math.min(W - pad,     o.x + dx)),
        y: Math.max(24,      Math.min(H - 24,       o.y + dy)),
      }
    })
    nodesRef.current = next
    setNodes([...next])
  }

  function onSvgMouseUp() {
    if (!dragRef.current) return
    dragRef.current = null
    persistPositions(nodesRef.current)
  }

  // ── Derived display data ───────────────────────────────────────────────────

  if (loading) return (
    <div className="h-32 flex items-center justify-center text-ink-faint text-sm">Loading graph…</div>
  )
  if (nodes.length === 0) return (
    <div className="rounded-card border border-white/10 h-24 flex items-center justify-center text-ink-faint text-sm">
      No connections yet — synonym and confusion links will appear here.
    </div>
  )

  const visEdges     = edges.filter(e => (e.type === 'synonym' && showSyn) || (e.type === 'confusion' && showCon))
  const connectedIds = new Set(visEdges.flatMap(e => [e.s, e.t]))
  const visNodes     = nodes.filter(n => connectedIds.has(n.id))
  const nodeMap      = new Map(nodes.map(n => [n.id, n]))
  const synCount     = edges.filter(e => e.type === 'synonym').length
  const conCount     = edges.filter(e => e.type === 'confusion').length

  return (
    <div className="space-y-3">
      {/* Legend / toggles */}
      <div className="flex items-center gap-5 text-xs text-ink-muted flex-wrap">
        <button
          onClick={() => setShowSyn(v => !v)}
          className={`flex items-center gap-1.5 transition-opacity ${!showSyn ? 'opacity-40' : ''}`}
        >
          <span className="w-3 h-3 rounded-sm inline-block" style={{ background: SYN_COLOR }} />
          Synonym links ({synCount})
        </button>
        <button
          onClick={() => setShowCon(v => !v)}
          className={`flex items-center gap-1.5 transition-opacity ${!showCon ? 'opacity-40' : ''}`}
        >
          <span className="w-3 h-3 rounded-sm inline-block" style={{ background: CON_COLOR }} />
          Confusion links ({conCount})
        </button>
        <span className="text-ink-faint">{visNodes.length} card{visNodes.length !== 1 ? 's' : ''}</span>
        <span className="text-ink-faint/60 text-[10px]">drag to move · shift+drag moves cluster</span>
        <button
          onClick={resetLayout}
          className="ml-auto text-ink-faint/60 hover:text-ink-faint text-[10px] transition-colors"
        >
          Reset layout
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded-card border border-white/10 bg-surface-deep/60 select-none"
        style={{ height: Math.min(H, 480), cursor: dragRef.current ? 'grabbing' : 'default' }}
        onMouseMove={onSvgMouseMove}
        onMouseUp={onSvgMouseUp}
        onMouseLeave={() => { onSvgMouseUp(); setHovered(null) }}
      >
        {/* Edges */}
        {visEdges.map((e, i) => {
          const u = nodeMap.get(e.s), v = nodeMap.get(e.t)
          if (!u || !v) return null
          const hot = hovered === e.s || hovered === e.t
          return (
            <line
              key={i}
              x1={u.x} y1={u.y} x2={v.x} y2={v.y}
              stroke={e.type === 'synonym' ? SYN_COLOR : CON_COLOR}
              strokeWidth={hot ? 2.5 : 1.2}
              strokeOpacity={hot ? 0.85 : 0.28}
              strokeLinecap="round"
            />
          )
        })}

        {/* Nodes */}
        {visNodes.map(nd => {
          const isHov   = hovered === nd.id
          const isNeigh = hovered
            ? visEdges.some(e => (e.s === hovered && e.t === nd.id) || (e.t === hovered && e.s === nd.id))
            : false
          const dim  = hovered && !isHov && !isNeigh
          const r    = isHov ? 24 : 18
          const isDragging = dragRef.current?.movers.has(nd.id) ?? false

          const nodeEdges = visEdges.filter(e => e.s === nd.id || e.t === nd.id)
          const hasSyn = nodeEdges.some(e => e.type === 'synonym')
          const hasCon = nodeEdges.some(e => e.type === 'confusion')
          const fill   = hasSyn && hasCon ? '#4f46e5' : hasSyn ? '#065f46' : '#78350f'
          const stroke = hasSyn && hasCon ? '#818cf8' : hasSyn ? SYN_COLOR : CON_COLOR

          return (
            <g
              key={nd.id}
              transform={`translate(${nd.x},${nd.y})`}
              onMouseEnter={() => { if (!dragRef.current) setHovered(nd.id) }}
              onMouseLeave={() => { if (!dragRef.current) setHovered(null) }}
              onMouseDown={e => onNodeMouseDown(e, nd.id)}
              style={{
                cursor:  isDragging ? 'grabbing' : 'grab',
                opacity: dim ? 0.2 : 1,
                transition: isDragging ? 'none' : 'opacity 0.12s',
              }}
            >
              <circle
                r={r}
                fill={fill}
                stroke={stroke}
                strokeWidth={isHov || isDragging ? 2.2 : 1.5}
              />
              <text
                textAnchor="middle" dy={isHov ? '-0.4em' : '0.35em'}
                fontSize={isHov ? 11 : 10} fill="white"
                fontWeight={isHov ? '600' : '400'}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {nd.label.length > 11 ? nd.label.slice(0, 10) + '…' : nd.label}
              </text>
              {isHov && (
                <text
                  textAnchor="middle" dy="1em"
                  fontSize={9} fill="#9ca3af"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {nd.sub.length > 16 ? nd.sub.slice(0, 15) + '…' : nd.sub}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
