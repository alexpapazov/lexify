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

/**
 * Collapses duplicate due-review entries for the same card and direction.
 *
 * A graduated card can be due on several tracks at once — the typed-production
 * track (`typedDueAt`), the self-graded recall track (`recallDueAt`), and the
 * legacy `dueAt` — all in the SAME forward direction, plus a separate reverse
 * row. Enqueuing all of them shows the learner the identical prompt two or
 * three times in one session ("the same card twice, even though I didn't miss
 * it"). This keeps at most one review per (cardId, direction): forward tracks
 * collapse into a single forward review, while forward and reverse stay
 * separate (they're genuinely different exercises — produce target vs. produce
 * native, the standard Anki bidirectional model).
 *
 * When several tracks are due for the same direction, the most "primary" one
 * wins: typed > legacy > recall. The deferred track keeps its past-due date
 * and simply surfaces in a later session. Order is otherwise preserved.
 */
export function dedupeDueReviews<
  T extends { card: { id: string }; reviewTrack?: string; isReverse?: boolean },
>(items: T[]): T[] {
  const rank = (t?: string) => (t === 'typed' ? 0 : t === 'smart' ? 1 : t === 'legacy' ? 2 : t === 'recall' ? 3 : 4)
  const best = new Map<string, T>()
  for (const it of items) {
    const key = `${it.card.id}:${it.isReverse ? 'reverse' : 'forward'}`
    const cur = best.get(key)
    if (!cur || rank(it.reviewTrack) < rank(cur.reviewTrack)) best.set(key, it)
  }
  const keep = new Set(best.values())
  return items.filter(it => keep.has(it))
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

// ─── Enabled review tracks (Due Now filtering) ─────────────────────────────────
//
// A language pair can disable any of its three review tracks (Typed production,
// Recall self-grade, Reverse recall) in the pair settings. A disabled track's
// due cards are "ghosted" — filtered out of Due Now — but their scheduling data
// is untouched, so re-enabling the track brings them straight back.

export interface EnabledTracks { typed: boolean; recall: boolean; reverse: boolean; smart: boolean }

/**
 * Smart-typing presentation: the track requires typing while its interval is below
 * the pair's threshold (still building the memory), then flips to self-graded once
 * it's comfortably past it. Dropping back below the threshold (a lapse) resumes typing.
 */
export function smartProductionMode(smartIntervalDays: number | null, thresholdDays: number): 'typed' | 'self-graded' {
  return smartIntervalDays != null && smartIntervalDays < thresholdDays ? 'typed' : 'self-graded'
}

/**
 * How a forward production review is presented.
 *
 * Smart lane: a lapsed card — currently relearning, or whose interval has fallen back below the
 * threshold — is presented as TYPED again, and stays typed until it climbs back past the threshold.
 * This revert takes precedence over the accelerated self-grade shortcut (getting it wrong means you
 * type it, even for an import-known card). Above the threshold (and not relearning) it self-grades.
 *
 * Typed (always-type) lane: known (accelerated, import-known + confirmed) cards may skip typing.
 */
export function forwardProductionMode(
  state: { acceleratedMode: string; acceleratedTypedConfirmed: boolean; smartIntervalDays: number | null; typedIntervalDays?: number | null; intervalDays?: number | null; relearning?: boolean },
  reviewTrack: 'typed' | 'smart',
  thresholdDays: number,
): 'typed' | 'self-graded' {
  if (reviewTrack === 'smart') {
    // Recovering a lapse → type it. (During relearn the interval hasn't dropped yet, so gate on the
    // relearning flag too, not just the interval.)
    if (state.relearning) return 'typed'
    // A ladder-graduated or legacy card put on the smart lane may not have a smart_interval_days yet —
    // fall back to its actual production interval so the typed/self-graded split is stable everywhere.
    const iv = state.smartIntervalDays ?? state.typedIntervalDays ?? state.intervalDays ?? null
    return smartProductionMode(iv, thresholdDays)
  }
  if (state.acceleratedMode === 'import_known' && state.acceleratedTypedConfirmed) return 'self-graded'
  return 'typed'
}

// Smart typing is a new track, off by default (typed production stays the default
// forward track for brand-new pairs); migration 078 flips existing pairs to smart.
const DEFAULT_ENABLED_TRACKS: EnabledTracks = { typed: true, recall: true, reverse: true, smart: false }

interface TrackFlagRow {
  sourceLanguage:       string
  targetLanguage:       string
  answerField:          string
  forwardTypedEnabled:  boolean
  forwardRecallEnabled: boolean
  reverseRecallEnabled: boolean
  forwardSmartEnabled:  boolean
}

/**
 * Builds a `${source}|${target}` → EnabledTracks map from all of a user's
 * scheduler-param rows. Each track's flag lives on its own answer_field row
 * (typed on forward_typed, recall on forward_recall, reverse on reverse_recall).
 */
export function buildEnabledTracksMap(rows: TrackFlagRow[]): Map<string, EnabledTracks> {
  const map = new Map<string, EnabledTracks>()
  for (const r of rows) {
    const key = `${r.sourceLanguage}|${r.targetLanguage}`
    const cur = map.get(key) ?? { ...DEFAULT_ENABLED_TRACKS }
    if (r.answerField === 'forward_typed')  cur.typed   = r.forwardTypedEnabled  ?? true
    if (r.answerField === 'forward_recall') cur.recall  = r.forwardRecallEnabled ?? true
    if (r.answerField === 'reverse_recall') cur.reverse = r.reverseRecallEnabled ?? true
    if (r.answerField === 'forward_smart')  cur.smart   = r.forwardSmartEnabled  ?? false
    map.set(key, cur)
  }
  return map
}

/**
 * The single enabled forward-production lane. Typed and smart are mutually exclusive per pair, but a
 * card's production due date can live in either the `typed_due_at` or `smart_due_at` column depending
 * on when/how it graduated (e.g. the ladder writes typed_due_at). Either way it must be reviewable on
 * whichever lane is currently enabled — otherwise the dashboard counts it as due while the session
 * silently drops it ("ghost" cards). Returns null when neither production track is enabled.
 */
export function activeProductionTrack(tracks: EnabledTracks | undefined): 'smart' | 'typed' | null {
  const t = tracks ?? DEFAULT_ENABLED_TRACKS
  if (t.smart) return 'smart'
  if (t.typed) return 'typed'
  return null
}

/**
 * Whether a specific due review should surface, given the pair's enabled tracks.
 * Legacy (pre-dual-track) reviews count as typed production.
 */
export function trackEnabled(
  tracks:      EnabledTracks | undefined,
  reviewTrack: 'typed' | 'recall' | 'legacy' | 'smart' | undefined,
  isReverse:   boolean,
): boolean {
  const t = tracks ?? DEFAULT_ENABLED_TRACKS
  if (isReverse) return t.reverse
  if (reviewTrack === 'recall') return t.recall
  if (reviewTrack === 'smart')  return t.smart
  // 'typed', 'legacy', or undefined → typed production track
  return t.typed
}
