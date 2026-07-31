/**
 * lib/dueNowLog.ts — pure grouping of Due Now review_events into ONE session PER DAY for the orbit
 * replay (the whole day's reviews play as a single movie). Framework-free so it's unit-testable. The
 * caller tags each event with its local `day` (tz + turnover aware) and fills in `label`, `intervalDays`
 * and `dormant` from separate queries.
 */
interface DueReview { rating: string; at: number; direction: 'forward' | 'reverse' }
export interface DueCard {
  cardId:       string
  label:        string   // front (target word)
  back:         string   // native translation (filled by the loader)
  deckId:       string | null  // for the "open card" link (filled by the loader)
  source:       string | null
  target:       string | null
  reviews:      DueReview[]
  intervalDays: number   // orbit radius source — the card's current interval
  lapsed:       boolean  // last review was 'again' → crashed back toward "today"
  dormant:      boolean  // card is now dormant → it escapes the system (flies off screen)
}
export interface DueSession {
  sessionId:   string
  day:         string    // YYYY-MM-DD (local)
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
  day:       string
}

/** Group every Due Now review into one session per local day (all of that day's cards in one movie). */
export function groupDueDays(events: RawDueEvent[]): DueSession[] {
  const byDay = new Map<string, RawDueEvent[]>()
  for (const e of events) (byDay.get(e.day) ?? byDay.set(e.day, []).get(e.day)!).push(e)

  const out: DueSession[] = []
  for (const [day, evs] of byDay) {
    const sorted = [...evs].sort((a, b) => a.at - b.at)
    const start = sorted[0]!.at, end = sorted[sorted.length - 1]!.at
    const byCard = new Map<string, DueCard>()
    let again = 0, activeMs = 0
    for (const e of sorted) {
      activeMs += Math.max(0, e.ms)
      if ((e.rating ?? '') === 'again') again++
      let c = byCard.get(e.cardId)
      if (!c) { c = { cardId: e.cardId, label: '', back: '', deckId: null, source: e.source, target: e.target, reviews: [], intervalDays: 0, lapsed: false, dormant: false }; byCard.set(e.cardId, c) }
      c.reviews.push({ rating: e.rating ?? 'good', at: e.at, direction: e.direction })
    }
    for (const c of byCard.values()) c.lapsed = c.reviews[c.reviews.length - 1]?.rating === 'again'
    out.push({
      sessionId: `day-${day}`, day, start, end, wallMs: Math.max(1, end - start), activeMs,
      cardCount: byCard.size, reviewCount: sorted.length, againCount: again, cards: [...byCard.values()],
    })
  }
  return out.sort((a, b) => b.start - a.start)
}
