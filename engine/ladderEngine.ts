/**
 * engine/ladderEngine.ts — the pure "climb" state machine for the configurable
 * learning ladder (Stage 2). No React, no Supabase — just the rules.
 *
 * A card climbs the ladder's rungs in order. Each attempt yields an OUTCOME; this
 * decides whether the card advances, retries the same rung, or drops back to an
 * earlier rung. Interval-setting rungs graduate their direction with a computed
 * starting interval. The whole climb must finish within 12 hours of clearing the
 * first rung, or it resets to the beginning.
 *
 * Timing of re-shows (under a minute / 5 min / 10 min) is returned as a hint; the
 * session layer (Stage 3) turns it into an actual schedule. Interval "ranges" are
 * returned as {min,max}; the session picks the least-busy day inside them.
 */

import type { Ladder, Rung, RungOutcome, Rating } from '@/domain'

export const CLIMB_WINDOW_MS = 12 * 60 * 60 * 1000  // 12 hours

/** Normalized result of one attempt, fed to the engine. */
export type RungAttemptOutcome = 'pass' | 'almost' | 'miss' | 'again' | 'hard' | 'good' | 'easy'

export interface IntervalRange { min: number; max: number }

export interface ClimbState {
  rungIndex:      number
  progress:       number                              // count toward the advance requirement
  messUps:        number                              // Again/Hard this sitting (for Easy interval)
  lastRating:     Rating | null                       // last self-rating on this rung
  ratingHistory?: Rating[]                            // ratings on the current rung (for OR advance rules)
  outcomeCounts:  Partial<Record<RungOutcome, number>> // per-rung tally, for total drop-back thresholds
  outcomeHistory?: RungAttemptOutcome[]                // per-rung outcome sequence, for in-a-row drop-backs
  startedAt:      number | null                       // ms when the first rung was cleared
  graduated:      boolean
  targetInterval: IntervalRange | null
  nativeInterval: IntervalRange | null
  /** Every rung index the card has occupied, in order (drop-backs included). 0-indexed;
   *  e.g. [0,1,2,3,2,3,4] = "1→2→3→4→3→4→5". For display/analytics only. */
  rungHistory?:   number[]
}

/** When to show the card again if it stays on the same rung. */
export type ReshowHint = 'soon' | 'short' | 'medium' | 'advanced'

export interface RungResult {
  state:         ClimbState
  reshow:        ReshowHint
  advanced:      boolean        // moved to a different rung (up or back)
  droppedBackTo: number | null  // rung index if this was a drop-back
}

export function initialClimbState(): ClimbState {
  return { rungIndex: 0, progress: 0, messUps: 0, lastRating: null, outcomeCounts: {}, startedAt: null, graduated: false, targetInterval: null, nativeInterval: null, rungHistory: [0] }
}

// ─── 12-hour window ──────────────────────────────────────────────────────────

export function isWindowExpired(state: ClimbState, now: number): boolean {
  return state.startedAt !== null && !state.graduated && (now - state.startedAt) > CLIMB_WINDOW_MS
}

/** Call before showing a card: if the window lapsed, reset to the first rung. */
export function applyWindow(state: ClimbState, now: number): ClimbState {
  return isWindowExpired(state, now) ? initialClimbState() : state
}

// ─── Easy interval table ─────────────────────────────────────────────────────

/** Starting interval (in days) for an Easy on an interval-setting rung. */
export function easyInterval(messUps: number, lastRating: Rating | null): IntervalRange {
  if (lastRating === 'good') return messUps === 0 ? { min: 3, max: 4 } : { min: 3, max: 3 }
  if (messUps === 0) return { min: 3, max: 4 }
  if (messUps === 1) return { min: 2, max: 3 }
  return { min: 2, max: 2 }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resetPerRung(s: ClimbState): ClimbState {
  return { ...s, progress: 0, messUps: 0, lastRating: null, ratingHistory: [], outcomeCounts: {}, outcomeHistory: [] }
}

const RATING_RANK: Record<Rating, number> = { again: 0, hard: 1, good: 2, easy: 3 }

/** A rung's effective advance rules (legacy single rule when none set). */
function advanceRulesFor(rung: Ladder['rungs'][number]): { times: number; inARow: boolean; minRating?: Rating }[] {
  if (rung.advanceRules && rung.advanceRules.length > 0) return rung.advanceRules
  return [{ times: rung.advanceTimes, inARow: rung.advanceInARow, minRating: rung.advanceRating }]
}

/**
 * Whether one OR-clause is satisfied by the rung's outcome history (most recent last).
 * Auto-checked rungs record pass → 'easy' / fail → 'again', so an omitted minRating
 * ('good') means "any clean pass qualifies".
 */
function ruleMet(history: Rating[], rule: { times: number; inARow: boolean; minRating?: Rating }): boolean {
  const min = RATING_RANK[rule.minRating ?? 'good']
  const qualifies = (r: Rating) => RATING_RANK[r] >= min
  if (rule.inARow) return history.length >= rule.times && history.slice(-rule.times).every(qualifies)
  return history.filter(qualifies).length >= rule.times
}

/** Move to an earlier/later rung by index (drop-back), clearing per-rung state. */
function toRung(s: ClimbState, index: number): ClimbState {
  return { ...resetPerRung(s), rungIndex: index }
}

/** Advance past `fromIndex`; may set the window start, record an interval, and graduate. */
function advance(s: ClimbState, ladder: Ladder, now: number, fromIndex: number, interval?: IntervalRange): ClimbState {
  let next = resetPerRung(s)
  if (fromIndex === 0 && next.startedAt === null) next.startedAt = now
  if (interval) {
    if (ladder.rungs[fromIndex]!.direction === 'produce_target') next.targetInterval = interval
    else next.nativeInterval = interval
  }
  next = { ...next, rungIndex: fromIndex + 1 }
  if (next.rungIndex >= ladder.rungs.length) {
    next.graduated = true
    if (!next.targetInterval) next.targetInterval = { min: 1, max: 1 }
    if (!next.nativeInterval) next.nativeInterval = { min: 1, max: 1 }
  }
  return next
}

const RESHOW_BY_RATING: Record<Rating, ReshowHint> = { again: 'soon', hard: 'short', good: 'medium', easy: 'medium' }

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * Records one review attempt, appending the resulting rung to `rungHistory` — so a card that
 * STAYS on a rung repeats it (e.g. 1 2 3 3 3 3 4 3 3 4 4 5 6). The past-the-end graduation index
 * is not appended (the last real rung is already the previous entry).
 */
export function reviewRung(ladder: Ladder, state: ClimbState, outcome: RungAttemptOutcome, now: number): RungResult {
  // Already graduated / out of range → no attempt to record.
  if (!ladder.rungs[state.rungIndex] || state.graduated) return reviewRungCore(ladder, state, outcome, now)
  const res = reviewRungCore(ladder, state, outcome, now)
  if (res.state.graduated) return res
  const rungHistory = [...(state.rungHistory ?? [state.rungIndex]), res.state.rungIndex]
  return { ...res, state: { ...res.state, rungHistory } }
}

function reviewRungCore(ladder: Ladder, state: ClimbState, outcome: RungAttemptOutcome, now: number): RungResult {
  const rung = ladder.rungs[state.rungIndex]
  if (!rung || state.graduated) return { state, reshow: 'advanced', advanced: false, droppedBackTo: null }

  // Record the outcome: a total tally + a bounded sequence (for in-a-row drop-backs).
  // 'pass' isn't a drop-back trigger but still enters the sequence (it breaks streaks).
  const outcomeKey: RungOutcome | null = outcome === 'pass' ? null : outcome
  const outcomeHistory = [...(state.outcomeHistory ?? []), outcome].slice(-10)
  const s: ClimbState = {
    ...state,
    outcomeHistory,
    ...(outcomeKey ? { outcomeCounts: { ...state.outcomeCounts, [outcomeKey]: (state.outcomeCounts[outcomeKey] ?? 0) + 1 } } : {}),
  }

  // Drop-back rules take priority. `times` counts N in a row (streak) or N total.
  if (outcomeKey) {
    const rule = rung.dropBacks.find(r => {
      if (r.on !== outcomeKey) return false
      if (r.inARow) return outcomeHistory.length >= r.times && outcomeHistory.slice(-r.times).every(o => o === r.on)
      return (s.outcomeCounts[outcomeKey] ?? 0) >= r.times
    })
    if (rule) {
      const idx = ladder.rungs.findIndex(r => r.id === rule.toRungId)
      if (idx >= 0) return { state: toRung(s, idx), reshow: 'soon', advanced: true, droppedBackTo: idx }
    }
  }

  const isRating = outcome === 'again' || outcome === 'hard' || outcome === 'good' || outcome === 'easy'

  // ── Interval-setting rung: Anki-style graduation of this direction ──
  if (rung.intervalInit) {
    if (outcome === 'again') return { state: { ...s, messUps: s.messUps + 1, lastRating: 'again' }, reshow: 'soon', advanced: false, droppedBackTo: null }
    if (outcome === 'hard')  return { state: { ...s, messUps: s.messUps + 1, lastRating: 'hard' }, reshow: 'short', advanced: false, droppedBackTo: null }
    if (outcome === 'good') {
      if (s.lastRating === 'good') return { state: advance(s, ladder, now, s.rungIndex, { min: 1, max: 1 }), reshow: 'advanced', advanced: true, droppedBackTo: null }
      return { state: { ...s, lastRating: 'good' }, reshow: 'medium', advanced: false, droppedBackTo: null }
    }
    if (outcome === 'easy') {
      const iv = easyInterval(s.messUps, s.lastRating)
      return { state: advance(s, ladder, now, s.rungIndex, iv), reshow: 'advanced', advanced: true, droppedBackTo: null }
    }
    // A wrong auto-check on a self-rated interval rung counts as Again.
    return { state: { ...s, messUps: s.messUps + 1, lastRating: 'again' }, reshow: 'soon', advanced: false, droppedBackTo: null }
  }

  // ── Self-rated (non-init) rung: advance when ANY advance rule is met (OR) ──
  if (rung.selfRated && isRating) {
    const rating = outcome as Rating
    const history = [...(s.ratingHistory ?? []), rating].slice(-10)  // bounded
    const messUps = (rating === 'again' || rating === 'hard') ? s.messUps + 1 : s.messUps
    if (advanceRulesFor(rung).some(rule => ruleMet(history, rule))) {
      return { state: advance({ ...s, ratingHistory: history }, ladder, now, s.rungIndex), reshow: 'advanced', advanced: true, droppedBackTo: null }
    }
    return { state: { ...s, ratingHistory: history, messUps, lastRating: rating }, reshow: RESHOW_BY_RATING[rating], advanced: false, droppedBackTo: null }
  }

  // ── Auto-checked rung (MCQ/typing/dictation): advance when ANY rule is met (OR) ──
  // A clean pass records as 'easy' (qualifies any clause); almost/miss records as 'again'.
  const passRating: Rating = outcome === 'pass' ? 'easy' : 'again'
  const history = [...(s.ratingHistory ?? []), passRating].slice(-10)
  if (advanceRulesFor(rung).some(rule => ruleMet(history, rule))) {
    return { state: advance({ ...s, ratingHistory: history }, ladder, now, s.rungIndex), reshow: 'advanced', advanced: true, droppedBackTo: null }
  }
  return { state: { ...s, ratingHistory: history }, reshow: outcome === 'pass' ? 'medium' : 'soon', advanced: false, droppedBackTo: null }
}
