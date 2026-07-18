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
  graduatedAtMs: number
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
 * Cluster graduated climbs (same pair, graduations within `gapMs`) into reconstructed sessions and
 * emit synthetic events for each. Reuse groupSessions() on the result to get SessionSummaries.
 */
export function reconstructEvents(climbs: ClimbRecord[], gapMs = 30 * 60_000): LadderEvent[] {
  const valid = climbs.filter(c => c.rungHistory.length > 0).sort((a, b) => a.graduatedAtMs - b.graduatedAtMs)
  if (valid.length === 0) return []
  const rungCount = Math.max(1, ...valid.map(c => Math.max(...c.rungHistory) + 1))
  const events: LadderEvent[] = []
  let clusterIdx = 0, prevKey = '', prevTime = -Infinity, clusterStart = 0
  for (const c of valid) {
    const key = `${c.source}|${c.target}`
    if (key !== prevKey || c.graduatedAtMs - prevTime > gapMs) {
      clusterIdx++; clusterStart = c.graduatedAtMs; prevKey = key
    }
    prevTime = c.graduatedAtMs
    const sessionId = `recon-${clusterIdx}`
    const n = c.rungHistory.length
    const span = Math.max(1000, c.graduatedAtMs - clusterStart) // ≥1s so even the first card climbs
    for (let i = 0; i < n; i++) {
      const from = i === 0 ? c.rungHistory[0]! : c.rungHistory[i - 1]!
      events.push(synthEvent(sessionId, c, from, c.rungHistory[i]!, rungCount, clusterStart + (span * i) / n, false))
    }
    events.push(synthEvent(sessionId, c, c.rungHistory[n - 1]!, rungCount, rungCount, c.graduatedAtMs, true))
  }
  return events
}
