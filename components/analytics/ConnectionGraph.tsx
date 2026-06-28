'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { displayText } from '@/lib/cardText'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GNode {
  id: string
  label: string  // card front
  sub:   string  // card back
  x: number; y: number; vx: number; vy: number
}

interface GEdge {
  s: string; t: string
  type: 'synonym' | 'confusion'
}

// ─── Force layout ─────────────────────────────────────────────────────────────

function forceLayout(nodes: GNode[], edges: GEdge[], W: number, H: number) {
  const n = nodes.length
  if (n <= 1) { if (n === 1) { nodes[0]!.x = W / 2; nodes[0]!.y = H / 2 }; return }

  // Random init
  for (const nd of nodes) {
    nd.x = W * 0.15 + Math.random() * W * 0.7
    nd.y = H * 0.15 + Math.random() * H * 0.7
    nd.vx = 0; nd.vy = 0
  }

  const k = Math.sqrt((W * H) / n) * 0.85
  const nodeMap = new Map(nodes.map(nd => [nd.id, nd]))
  let temp = W / 4
  const ITERS = 260
  const cooling = temp / ITERS

  for (let iter = 0; iter < ITERS; iter++) {
    for (const nd of nodes) { nd.vx = 0; nd.vy = 0 }

    // Repulsion O(n²)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const u = nodes[i]!, v = nodes[j]!
        const dx = u.x - v.x || 0.1, dy = u.y - v.y || 0.1
        const d  = Math.sqrt(dx * dx + dy * dy) || 0.1
        const f  = (k * k) / d
        const fx = (dx / d) * f, fy = (dy / d) * f
        u.vx += fx; u.vy += fy
        v.vx -= fx; v.vy -= fy
      }
    }

    // Attraction along edges
    for (const e of edges) {
      const u = nodeMap.get(e.s), v = nodeMap.get(e.t)
      if (!u || !v) continue
      const dx = v.x - u.x, dy = v.y - u.y
      const d  = Math.sqrt(dx * dx + dy * dy) || 0.1
      const f  = (d * d) / k
      const fx = (dx / d) * f, fy = (dy / d) * f
      u.vx += fx; u.vy += fy
      v.vx -= fx; v.vy -= fy
    }

    // Gravity toward center
    for (const nd of nodes) {
      nd.vx += (W / 2 - nd.x) * 0.018
      nd.vy += (H / 2 - nd.y) * 0.018
    }

    // Apply with temperature clamping + boundary
    for (const nd of nodes) {
      const mag   = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy) || 0.01
      const scale = Math.min(mag, temp) / mag
      nd.x = Math.max(72, Math.min(W - 72, nd.x + nd.vx * scale))
      nd.y = Math.max(28, Math.min(H - 28, nd.y + nd.vy * scale))
    }

    temp -= cooling
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

const W = 740, H = 500
const SYN_COLOR = '#10b981'
const CON_COLOR = '#f59e0b'

export function ConnectionGraph({ userId }: { userId: string }) {
  const [nodes,   setNodes]   = useState<GNode[]>([])
  const [edges,   setEdges]   = useState<GEdge[]>([])
  const [loading, setLoading] = useState(true)
  const [showSyn, setShowSyn] = useState(true)
  const [showCon, setShowCon] = useState(true)
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const db = createClient()

      // Confusion links
      const { data: confLinks } = await db
        .from('card_confusion_links')
        .select('card_a_id, card_b_id')
        .eq('user_id', userId)

      // All user cards (with choices for synonym detection)
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

      // Synonym edges: A→B if B's back appears in A's backSynonyms
      const synEdges: GEdge[] = []
      const synNodeIds = new Set<string>()
      if (allCards) {
        const backToId = new Map<string, string>()
        for (const c of allCards) {
          backToId.set(displayText(c.back as string).toLowerCase(), c.id as string)
        }
        const seen = new Set<string>()
        for (const c of allCards) {
          const syns: string[] = (c.choices as { backSynonyms?: string[] } | null)?.backSynonyms ?? []
          for (const syn of syns) {
            const otherId = backToId.get(syn.toLowerCase())
            if (!otherId || otherId === c.id) continue
            const key = [c.id, otherId].sort().join('|')
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

      forceLayout(rawNodes, allEdges, W, H)
      setNodes(rawNodes)
      setEdges(allEdges)
      setLoading(false)
    }
    void load()
  }, [userId])

  if (loading) return (
    <div className="h-32 flex items-center justify-center text-ink-faint text-sm">Loading graph…</div>
  )
  if (nodes.length === 0) return (
    <div className="rounded-card border border-white/10 h-24 flex items-center justify-center text-ink-faint text-sm">
      No connections yet — synonym and confusion links will appear here.
    </div>
  )

  const visEdges = edges.filter(e =>
    (e.type === 'synonym' && showSyn) || (e.type === 'confusion' && showCon)
  )
  const connectedIds = new Set(visEdges.flatMap(e => [e.s, e.t]))
  const visNodes = nodes.filter(n => connectedIds.has(n.id))

  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  const synCount = edges.filter(e => e.type === 'synonym').length
  const conCount = edges.filter(e => e.type === 'confusion').length

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
        <span className="text-ink-faint ml-auto">{visNodes.length} card{visNodes.length !== 1 ? 's' : ''} · hover to inspect</span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded-card border border-white/10 bg-surface-deep/60"
        style={{ height: Math.min(H, 480) }}
        onMouseLeave={() => setHovered(null)}
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
          const dim = hovered && !isHov && !isNeigh
          const r   = isHov ? 24 : 18

          // Determine edge types for this node
          const nodeEdges = visEdges.filter(e => e.s === nd.id || e.t === nd.id)
          const hasSyn = nodeEdges.some(e => e.type === 'synonym')
          const hasCon = nodeEdges.some(e => e.type === 'confusion')
          const fill   = hasSyn && hasCon ? '#4f46e5' : hasSyn ? '#065f46' : '#78350f'
          const stroke = hasSyn && hasCon ? '#818cf8' : hasSyn ? SYN_COLOR : CON_COLOR

          return (
            <g
              key={nd.id}
              transform={`translate(${nd.x},${nd.y})`}
              onMouseEnter={() => setHovered(nd.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: 'default', opacity: dim ? 0.2 : 1, transition: 'opacity 0.12s' }}
            >
              <circle r={r} fill={fill} stroke={stroke} strokeWidth={isHov ? 2 : 1.5} />
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
