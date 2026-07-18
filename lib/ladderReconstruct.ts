/**
 * lib/ladderReconstruct.ts — rebuild a (best-effort) replay for ladder sessions that predate event
 * logging, from each card's surviving `rungHistory` (the ordered rungs it occupied). Timestamps are
 * synthesized: a card climbs from its cluster's start up to its real graduation time. There are no
 * per-attempt durations or rating colours (that data only lived in the lost `ladder_events`).
 */
import type { LadderEvent } from '@/lib/data/ladderEvents'

export interface ClimbRecord {
  cardId:        string
  front:         string
  source:        string | null
  target:        string | null
  rungHistory:   number[]
  graduated:     boolean
  updatedAtMs:   number   // last climb save (≈ graduation time for graduated cards)
}

let synthSeq = 0
function synthEvent(
  sessionId: string, c: ClimbRecord, from: number, to: number, rungCount: number, atMs: number, graduated: boolean,
): LadderEvent {
  return {
    id: `syn-${synthSeq++}`, sessionId, cardId: c.cardId, deckId: null, label: c.front,
    sourceLanguage: c.source, targetLanguage: c.target,
    fromRung: from, toRung: to, rungCount, rungType: null,
    outcome: null, advanced: to > from, graduated, overridden: false, durationMs: null,
    createdAt: new Date(atMs).toISOString(),
  }
}

/**
 * Rebuild reconstructed sessions from surviving climbs. Sessions are anchored on GRADUATED climbs
 * (same pair, graduations within `gapMs`); UNFINISHED climbs (glitched / deleted-before-graduating)
 * that fall inside a cluster's time window are included too, climbing to whatever rung they reached
 * (no graduation event). Emits synthetic events — reuse groupSessions() to get SessionSummaries.
 */
export function reconstructEvents(climbs: ClimbRecord[], gapMs = 30 * 60_000): LadderEvent[] {
  const valid = climbs.filter(c => c.rungHistory.length > 1)
  if (valid.length === 0) return []
  const rungCount = Math.max(1, ...valid.map(c => Math.max(...c.rungHistory) + 1))
  const key = (c: ClimbRecord) => `${c.source}|${c.target}`

  // Anchor clusters on graduated cards.
  const grads = valid.filter(c => c.graduated).sort((a, b) => a.updatedAtMs - b.updatedAtMs)
  const clusters: { key: string; start: number; end: number; cards: ClimbRecord[] }[] = []
  for (const c of grads) {
    const last = clusters[clusters.length - 1]
    if (last && last.key === key(c) && c.updatedAtMs - last.end <= gapMs) { last.cards.push(c); last.end = c.updatedAtMs }
    else clusters.push({ key: key(c), start: c.updatedAtMs, end: c.updatedAtMs, cards: [c] })
  }
  // Attach unfinished cards to the cluster whose window (± gap) contains their last activity.
  for (const c of valid) {
    if (c.graduated) continue
    const cl = clusters.find(cl => cl.key === key(c) && c.updatedAtMs >= cl.start - gapMs && c.updatedAtMs <= cl.end + gapMs)
    if (cl) cl.cards.push(c)
  }

  const events: LadderEvent[] = []
  clusters.forEach((cl, idx) => {
    const sessionId = `recon-${idx + 1}`
    for (const c of cl.cards) {
      const n = c.rungHistory.length
      const endMs = Math.max(cl.start, c.updatedAtMs)
      const span = Math.max(1000, endMs - cl.start) // ≥1s so even the first card climbs
      for (let i = 0; i < n; i++) {
        const from = i === 0 ? c.rungHistory[0]! : c.rungHistory[i - 1]!
        events.push(synthEvent(sessionId, c, from, c.rungHistory[i]!, rungCount, cl.start + (span * i) / n, false))
      }
      if (c.graduated) events.push(synthEvent(sessionId, c, c.rungHistory[n - 1]!, rungCount, rungCount, c.updatedAtMs, true))
    }
  })
  return events
}
