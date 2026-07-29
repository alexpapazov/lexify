/**
 * engine/pathwayEngine.ts — the pure state-machine for Learning Pathways.
 *
 * A pathway is a directed graph of States; a card holds a `RouteState` and each answer runs `stepPathway`,
 * which bumps the per-state counters, (optionally) records a graduation interval, then fires the
 * first-matching outgoing transition by priority. Framework-free and fully deterministic — no timing
 * inputs, no randomness, no I/O. The linear ladder engine (`ladderEngine.ts`) is untouched; this is its
 * branched sibling and shares only the `IntervalRange` / `easyInterval` helpers.
 *
 * See features/Learning Pathways (proposal).md for the design.
 */

import type {
  Pathway, PathwayState, Transition, PathwayCondition, PathwayCounter, ErrorType, RungOutcome, Rating,
} from '@/domain'
import { easyInterval, type IntervalRange } from '@/engine/ladderEngine'

/** Per-card runtime position + accumulated history through a pathway. Stored in the climb row's JSON. */
export interface RouteState {
  stateId:          string
  stateEnteredAt:   number | null
  attemptsInState:  number
  consecutiveGood:  number
  consecutiveAgain: number
  totalGood:        number
  totalAgain:       number
  /**
   * LIFETIME error count for this route — unlike `totalAgain` (which `enterState` resets per state,
   * despite the name) this survives state transitions. Drives the Easy graduation interval, which is
   * about how hard the card was to learn OVERALL. Optional for routes saved before it existed.
   */
  lifetimeErrors?:  number
  lastRating:       Rating | null
  lastErrorTypes:   ErrorType[]
  history:          string[]                 // stateIds visited, in order
  targetInterval:   IntervalRange | null     // set by an intervalInit produce_target state on the route
  nativeInterval:   IntervalRange | null     // set by an intervalInit produce_native state on the route
  graduated:        boolean
}

/** Everything a predicate can read about the attempt just made. Deliberately has NO timing. */
export interface PathwayEvent {
  /** Raw outcome — auto-checked states emit pass/almost/miss; self-rated states emit again/hard/good/easy. */
  outcome:    RungOutcome | 'pass'
  errorTypes: ErrorType[]
}

export interface PathwayStep {
  route:         RouteState
  moved:         boolean       // did a transition fire (state changed OR a self-loop reset)?
  graduated:     boolean
  reshowSeconds: number        // gap before this card may reappear
}

const DAY: IntervalRange = { min: 1, max: 1 }

/** Clean success = advanced/correct. pass/good/easy count; almost/miss/again/hard do not. */
export function isSuccess(outcome: PathwayEvent['outcome']): boolean {
  return outcome === 'pass' || outcome === 'good' || outcome === 'easy'
}

export function initialRouteState(pathway: Pathway): RouteState {
  return {
    stateId: pathway.startStateId, stateEnteredAt: null, attemptsInState: 0,
    consecutiveGood: 0, consecutiveAgain: 0, totalGood: 0, totalAgain: 0, lifetimeErrors: 0,
    lastRating: null, lastErrorTypes: [], history: [pathway.startStateId],
    targetInterval: null, nativeInterval: null, graduated: false,
  }
}

const stateById = (p: Pathway, id: string): PathwayState | undefined => p.states.find(s => s.id === id)

/** Bump the per-state counters from the outcome. Success streak vs. again streak; hard breaks both. */
function bumpCounters(route: RouteState, ev: PathwayEvent): RouteState {
  const r = { ...route, attemptsInState: route.attemptsInState + 1, lastErrorTypes: ev.errorTypes }
  const isRating = ev.outcome === 'again' || ev.outcome === 'hard' || ev.outcome === 'good' || ev.outcome === 'easy'
  if (isRating) r.lastRating = ev.outcome as Rating
  if (isSuccess(ev.outcome)) {                       // pass / good / easy
    r.consecutiveGood += 1; r.consecutiveAgain = 0; r.totalGood += 1
  } else if (ev.outcome === 'again' || ev.outcome === 'almost' || ev.outcome === 'miss') {
    r.consecutiveAgain += 1; r.consecutiveGood = 0; r.totalAgain += 1
    r.lifetimeErrors = (route.lifetimeErrors ?? 0) + 1
  } else {                                           // hard — neutral, breaks both streaks
    r.consecutiveGood = 0; r.consecutiveAgain = 0
  }
  return r
}

function counterValue(route: RouteState, name: PathwayCounter): number {
  return route[name]
}

/** A condition matches when EVERY predicate holds (AND). Empty condition ⇒ always matches. */
function conditionMatches(cond: PathwayCondition, route: RouteState, ev: PathwayEvent): boolean {
  return cond.every(p => {
    switch (p.kind) {
      case 'rating':          return ev.outcome === p.is
      case 'correct':         return isSuccess(ev.outcome) === p.is
      case 'errorType':       return ev.errorTypes.includes(p.is)
      case 'counter':         return counterValue(route, p.name) >= p.gte
      case 'attemptsInState': return route.attemptsInState >= p.gte
    }
  })
}

/** Outgoing transitions for a state, most-important-first (lower priority number wins; stable tiebreak). */
function outgoing(pathway: Pathway, stateId: string): Transition[] {
  return pathway.transitions
    .filter(t => t.from === stateId)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.priority - b.t.priority) || (a.i - b.i))
    .map(x => x.t)
}

/** Reset the per-state counters on entering a state (mirrors the ladder's resetPerRung). */
function enterState(route: RouteState, stateId: string, now: number): RouteState {
  // NOTE: `lifetimeErrors` is deliberately NOT reset — it rides along in the spread.
  return {
    ...route, stateId, stateEnteredAt: now, attemptsInState: 0,
    consecutiveGood: 0, consecutiveAgain: 0, totalGood: 0, totalAgain: 0,
    history: [...route.history, stateId],
  }
}

/**
 * Advance a card one step. Order: bump counters → (if leaving an intervalInit state on a success) record
 * that direction's interval → fire the first matching transition → if the destination is terminal,
 * graduate (filling any unset direction with the flat 1-day default).
 */
export function stepPathway(pathway: Pathway, route: RouteState, ev: PathwayEvent, now: number): PathwayStep {
  const cur = stateById(pathway, route.stateId)
  const global = pathway.betweenStateWaitSeconds
  if (!cur || cur.isTerminal || route.graduated) {
    return { route, moved: false, graduated: route.graduated, reshowSeconds: global }
  }

  let bumped = bumpCounters(route, ev)

  const match = outgoing(pathway, route.stateId).find(t => conditionMatches(t.when, bumped, ev))
  if (!match) {
    // No transition fired — stay on this state; retry after its floor (or the global gap).
    return { route: bumped, moved: false, graduated: false, reshowSeconds: cur.minReshowSeconds ?? global }
  }

  // Leaving an interval-setting state on a SUCCESS records this direction's starting interval.
  if (cur.intervalInit && isSuccess(ev.outcome)) {
    const iv = ev.outcome === 'easy' ? easyInterval(bumped.lifetimeErrors ?? bumped.totalAgain) : DAY
    if (cur.direction === 'produce_target') bumped = { ...bumped, targetInterval: iv }
    else                                    bumped = { ...bumped, nativeInterval: iv }
  }

  let next = enterState(bumped, match.to, now)
  if (match.resetCounters?.length) {
    for (const c of match.resetCounters) next = { ...next, [c]: 0 }
  }

  const dest = stateById(pathway, match.to)
  const graduated = !!dest?.isTerminal
  if (graduated) {
    next = {
      ...next, graduated: true,
      targetInterval: next.targetInterval ?? DAY,
      nativeInterval: next.nativeInterval ?? DAY,
    }
  }

  const reshowSeconds = match.waitSecondsOverride ?? global
  return { route: next, moved: true, graduated, reshowSeconds }
}
