/**
 * lib/dueNowLog.ts — pure grouping of Due Now review_events into sessions for the "orbit" replay.
 * Kept framework-free so it's unit-testable. Events are grouped by an inactivity gap (like the ladder
 * session rule); each session tallies its cards and their per-review ratings. `label` and `intervalDays`
 * are filled in by the loader (fronts + current schedule come from separate queries).
 */
export interface DueReview { rating: string; at: number; direction: 'forward' | 'reverse' }
export interface DueCard {
  cardId:       string
  label:        string
  source:       string | null
  target:       string | null
  reviews:      DueReview[]
  intervalDays: number   // orbit radius source — the card's current interval (filled by the loader)
  lapsed:       boolean  // last review was 'again' → it crashed back toward "today"
}
export interface DueSession {
  sessionId:   string
  start:       number
  end:         number
  wallMs:      number
  activeMs:    number
  cardCount:   number
  reviewCount: number
  againCount:  number
  cards:       DueCard[]
}
export interface RawDueEvent {
  cardId:    string
  rating:    string | null
  at:        number
  ms:        number
  direction: 'forward' | 'reverse'
  source:    string | null
  target:    string | null
}

const GAP_MS = 45 * 60_000

export function groupDueSessions(events: RawDueEvent[], gapMs = GAP_MS): DueSession[] {
  const sorted = [...events].sort((a, b) => a.at - b.at)
  const sessions: DueSession[] = []
  let cur: RawDueEvent[] = []

  const flush = () => {
    if (cur.length === 0) return
    const start = cur[0]!.at, end = cur[cur.length - 1]!.at
    const byCard = new Map<string, DueCard>()
    let again = 0, activeMs = 0
    for (const e of cur) {
      activeMs += Math.max(0, e.ms)
      if ((e.rating ?? '') === 'again') again++
      let c = byCard.get(e.cardId)
      if (!c) { c = { cardId: e.cardId, label: '', source: e.source, target: e.target, reviews: [], intervalDays: 0, lapsed: false }; byCard.set(e.cardId, c) }
      c.reviews.push({ rating: e.rating ?? 'good', at: e.at, direction: e.direction })
    }
    for (const c of byCard.values()) c.lapsed = c.reviews[c.reviews.length - 1]?.rating === 'again'
    sessions.push({
      sessionId: `due-${start}`, start, end, wallMs: Math.max(1, end - start), activeMs,
      cardCount: byCard.size, reviewCount: cur.length, againCount: again, cards: [...byCard.values()],
    })
    cur = []
  }

  for (const e of sorted) {
    if (cur.length && e.at - cur[cur.length - 1]!.at > gapMs) flush()
    cur.push(e)
  }
  flush()
  return sessions.sort((a, b) => b.start - a.start)
}
