/**
 * Computes the set of non-graduated card IDs a session may study when a
 * per-session pipeline limit ("Limit cards in learning") is active.
 *
 * The returned set caps BOTH new-card introduction and the existing
 * in-pipeline backlog, so the learner only ever works ~N cards at a time.
 *
 * - Batch mode: cards are grouped by deck position into fixed groups of N.
 *   The active batch is the first group that isn't fully graduated; only that
 *   group's not-yet-graduated cards are eligible. All N must graduate before
 *   the next group unlocks.
 * - Rolling mode: keep at most N non-graduated cards active. Cards already in
 *   learning are kept first (oldest introduced first), then unlearned cards are
 *   pulled in deck order to top up to N. As cards graduate, the next session
 *   refills the freed slots — learning first, then unlearned — until the deck
 *   is exhausted.
 */
export interface LimitCard {
  id:       string
  position: number
}

export interface LimitState {
  graduated:      boolean
  introducedDate: string | null
}

export function computeActiveLearningSet(
  cards:           LimitCard[],
  getState:        (id: string) => LimitState | undefined,
  cardsPerSession: number,
  learningBatchMode: boolean,
): Set<string> {
  const sortedCards = [...cards].sort((a, b) => a.position - b.position)
  const isInPipeline = (id: string) => { const s = getState(id); return !!s && !s.graduated }

  if (learningBatchMode) {
    let batchStart = 0
    while (batchStart < sortedCards.length) {
      const batchEnd = Math.min(batchStart + cardsPerSession, sortedCards.length)
      const allGraduated = sortedCards.slice(batchStart, batchEnd)
        .every(c => getState(c.id)?.graduated === true)
      if (!allGraduated) break
      batchStart += cardsPerSession
    }
    return new Set(
      sortedCards.slice(batchStart, batchStart + cardsPerSession)
        .filter(c => getState(c.id)?.graduated !== true)
        .map(c => c.id)
    )
  }

  // Rolling mode
  const learningIds = sortedCards
    .filter(c => isInPipeline(c.id))
    .sort((a, b) => {
      const da = getState(a.id)?.introducedDate ?? ''
      const db = getState(b.id)?.introducedDate ?? ''
      return da === db ? a.position - b.position : da.localeCompare(db)
    })
    .map(c => c.id)
  const set = new Set(learningIds.slice(0, cardsPerSession))
  for (const c of sortedCards) {
    if (set.size >= cardsPerSession) break
    if (getState(c.id)) continue   // skip cards already started or graduated
    set.add(c.id)                   // pull in an unlearned card
  }
  return set
}
