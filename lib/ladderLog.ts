/**
 * lib/ladderLog.ts — pure aggregation of raw ladder events into sessions + per-card stats, and the
 * "where is this card at time t" lookup that powers the replay. No React / Supabase here.
 */
import type { LadderEvent } from '@/lib/data/ladderEvents'

export interface CardStat {
  cardId:    string
  label:     string
  attempts:  number
  activeMs:  number        // total time spent on this card (sum of per-attempt durations)
  graduated: boolean
  maxRung:   number
  events:    LadderEvent[] // this card's events, oldest-first
}

export interface SessionSummary {
  sessionId:      string
  start:          number   // epoch ms of the first event
  end:            number   // epoch ms of the last event
  events:         LadderEvent[]  // all events, oldest-first
  cards:          CardStat[]
  rungCount:      number
  cardCount:      number
  graduatedCount: number
  attempts:       number
  activeMs:       number   // total active study time
  wallMs:         number   // wall-clock span (end - start)
  source:         string | null
  target:         string | null
}

const ms = (iso: string) => new Date(iso).getTime()

/** Group raw events into sessions (most-recent first), each with per-card stats. */
export function groupSessions(events: LadderEvent[]): SessionSummary[] {
  const bySession = new Map<string, LadderEvent[]>()
  for (const e of events) {
    const arr = bySession.get(e.sessionId) ?? []
    arr.push(e); bySession.set(e.sessionId, arr)
  }
  const summaries: SessionSummary[] = []
  for (const [sessionId, evs] of bySession) {
    const sorted = [...evs].sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
    const byCard = new Map<string, LadderEvent[]>()
    for (const e of sorted) { const a = byCard.get(e.cardId) ?? []; a.push(e); byCard.set(e.cardId, a) }
    const cards: CardStat[] = [...byCard.entries()].map(([cardId, ce]) => ({
      cardId,
      label:     ce.find(e => e.label)?.label ?? '—',
      attempts:  ce.length,
      activeMs:  ce.reduce((s, e) => s + (e.durationMs ?? 0), 0),
      graduated: ce.some(e => e.graduated),
      maxRung:   Math.max(...ce.map(e => e.toRung)),
      events:    ce,
    })).sort((a, b) => b.activeMs - a.activeMs)
    summaries.push({
      sessionId,
      start:          ms(sorted[0]!.createdAt),
      end:            ms(sorted[sorted.length - 1]!.createdAt),
      events:         sorted,
      cards,
      rungCount:      Math.max(1, ...sorted.map(e => e.rungCount)),
      cardCount:      byCard.size,
      graduatedCount: cards.filter(c => c.graduated).length,
      attempts:       sorted.length,
      activeMs:       sorted.reduce((s, e) => s + (e.durationMs ?? 0), 0),
      wallMs:         ms(sorted[sorted.length - 1]!.createdAt) - ms(sorted[0]!.createdAt),
      source:         sorted.find(e => e.sourceLanguage)?.sourceLanguage ?? null,
      target:         sorted.find(e => e.targetLanguage)?.targetLanguage ?? null,
    })
  }
  return summaries.sort((a, b) => b.start - a.start)
}

/**
 * The rung level a card occupies at epoch-time `t`: its first event's `fromRung` before any attempt,
 * then the `toRung` of the most recent attempt at or before `t`. (rungCount = graduated / top lane.)
 */
export function cardLevelAt(cardEvents: LadderEvent[], t: number): number {
  if (cardEvents.length === 0) return 0
  let level = cardEvents[0]!.fromRung
  for (const e of cardEvents) {
    if (ms(e.createdAt) <= t) level = e.toRung
    else break
  }
  return level
}
