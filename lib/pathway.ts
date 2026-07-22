/**
 * lib/pathway.ts — framework-free helpers for Learning Pathways: validation and ladder→pathway
 * conversion. Pure, unit-tested. The runtime state machine lives in `engine/pathwayEngine.ts`; this is
 * the pathway analogue of `lib/ladder.ts`.
 */

import type {
  Pathway, PathwayState, Transition, PathwayCondition, Ladder, Rung, DropBackRule, SkipAheadRule,
  GradingIssueType, ErrorType,
} from '@/domain'
import { canInitInterval } from '@/lib/ladder'

/** Map the grader's issue type to the pathway's error kinds (drives error-specific transitions). */
export function issueToErrorTypes(it: GradingIssueType): ErrorType[] {
  switch (it) {
    case 'accent':      return ['accent']
    case 'article':
    case 'gender':      return ['article']
    case 'typo':
    case 'punctuation': return ['spelling']
    case 'semantic':    return ['wrong_word']
    default:            return []   // 'none'
  }
}

const GRAD_STATE_ID = 'graduated'

/** The pathway governing a pair: its own if set, else the user's default. Null if neither exists (the
 *  caller then falls back to converting the ladder — pathways don't have a built-in default graph). */
export function resolveEffectivePathway(pairPathway: Pathway | null, defaultPathway: Pathway | null): Pathway | null {
  return pairPathway ?? defaultPathway ?? null
}

/** Set of state ids reachable from `startId` by following transitions. */
function reachableFrom(pathway: Pathway, startId: string): Set<string> {
  const seen = new Set<string>()
  const stack = [startId]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const t of pathway.transitions) if (t.from === id && !seen.has(t.to)) stack.push(t.to)
  }
  return seen
}

/**
 * Validates a pathway. Returns human-readable problems (empty = OK). Hard errors first, then warnings
 * (prefixed `Warning:`). Loops are allowed; the load-bearing check is that graduation stays reachable.
 */
export function validatePathway(pathway: Pathway): string[] {
  const errors: string[] = []
  const warnings: string[] = []
  const { states, transitions } = pathway
  if (states.length === 0) { return ['Add at least one state.'] }

  const byId = new Map(states.map(s => [s.id, s]))
  const terminals = states.filter(s => s.isTerminal)
  const nonTerminals = states.filter(s => !s.isTerminal)

  if (!byId.has(pathway.startStateId)) errors.push('The start state does not exist.')
  if (byId.get(pathway.startStateId)?.isTerminal) errors.push('The start state cannot be the graduation state.')
  if (terminals.length === 0) errors.push('Add a graduation (terminal) state.')

  // Transitions must reference real states.
  for (const t of transitions) {
    if (!byId.has(t.from)) errors.push(`A transition starts from a state that no longer exists.`)
    if (!byId.has(t.to))   errors.push(`A transition points to a state that no longer exists.`)
  }

  // Every non-terminal state needs a way out, and must be able to reach graduation.
  for (const s of nonTerminals) {
    const outs = transitions.filter(t => t.from === s.id)
    if (outs.length === 0) { errors.push(`"${s.name}" is a dead end — it has no outgoing transition.`); continue }
    const reach = reachableFrom(pathway, s.id)
    if (![...reach].some(id => byId.get(id)?.isTerminal)) {
      errors.push(`From "${s.name}" a card can never reach graduation.`)
    }
  }

  // Interval-setting rules mirror the ladder's: eligible rung type + ≤1 per direction.
  const initStates = states.filter(s => s.intervalInit)
  for (const s of initStates) {
    if (!canInitInterval(s.type, s.direction)) {
      errors.push(`"${s.name}" can't set the interval (only typing, self-graded, or native-producing dictation can).`)
    }
  }
  const targetInits = initStates.filter(s => s.direction === 'produce_target').length
  const nativeInits = initStates.filter(s => s.direction === 'produce_native').length
  if (targetInits > 1) errors.push('More than one state sets the target-direction interval — keep it to one.')
  if (nativeInits > 1) errors.push('More than one state sets the native-direction interval — keep it to one.')

  // Warnings (non-blocking) — you're hand-authoring and may want these.
  const reachedFromStart = reachableFrom(pathway, pathway.startStateId)
  for (const s of states) {
    if (s.id !== pathway.startStateId && !reachedFromStart.has(s.id)) {
      warnings.push(`Warning: "${s.name}" is unreachable from the start.`)
    }
  }
  if (targetInits === 0) warnings.push('Warning: no state sets the target-direction interval — it will graduate at 1 day.')
  if (nativeInits === 0) warnings.push('Warning: no state sets the native-direction interval — it will graduate at 1 day.')

  return [...errors, ...warnings]
}

// ─── Ladder → Pathway conversion (a *starting scaffold*, not a template) ─────────────────────────────
// Seeds the editor when a pair flips to pathway mode: a mechanical 1:1 of the ladder you already built.
// Approximate — OR advance rules become parallel transitions; the exact minRating nuance is dropped —
// but the happy path (pass everything → graduate through all states) is preserved. You then rework it.

const TERMINAL: PathwayState = {
  id: GRAD_STATE_ID, name: 'Graduated', type: 'self_graded', direction: 'produce_target',
  selfRated: false, intervalInit: false, isTerminal: true,
}

/** A blank pathway: one start state + the graduation terminal, and a single unconditional edge between
 *  them (so it's valid out of the box). The user builds from here. */
export function emptyPathway(): Pathway {
  const start: PathwayState = {
    id: 'start', name: 'Initial', type: 'typing', direction: 'produce_target',
    strictness: { spelling: 'penalize', accents: 'penalize', articles: 'penalize' },
    selfRated: false, intervalInit: false,
  }
  return {
    id: 'pathway',
    startStateId: start.id,
    states: [start, { ...TERMINAL }],
    transitions: [{ id: 'start-grad', from: start.id, to: GRAD_STATE_ID, when: [{ kind: 'correct', is: true }], priority: 100 }],
    betweenStateWaitSeconds: 180,
  }
}

/** Advance clause(s) → OR-ed transitions: any success-streak that met the rung's bar moves it on. */
function advanceTransitions(rung: Rung, from: string, to: string): Transition[] {
  const rules = rung.advanceRules && rung.advanceRules.length > 0
    ? rung.advanceRules
    : [{ times: rung.advanceTimes, inARow: rung.advanceInARow }]
  return rules.map((r, i) => ({
    id: `${rung.id}-adv-${i}`, from, to, priority: 100,
    when: [{ kind: 'counter', name: r.inARow ? 'consecutiveGood' : 'totalGood', gte: Math.max(1, r.times) }] as PathwayCondition,
  }))
}

function dropBackCondition(rule: DropBackRule): PathwayCondition {
  if (rule.on === 'good' || rule.on === 'easy') {
    return [{ kind: 'counter', name: rule.inARow ? 'consecutiveGood' : 'totalGood', gte: Math.max(1, rule.times) }]
  }
  if (rule.on === 'hard') return [{ kind: 'rating', is: 'hard' }]
  // miss / almost / again → failure streak
  return [{ kind: 'counter', name: rule.inARow ? 'consecutiveAgain' : 'totalAgain', gte: Math.max(1, rule.times) }]
}

function skipCondition(rule: SkipAheadRule): PathwayCondition {
  // pass / good / easy are all successes.
  return [{ kind: 'counter', name: rule.inARow ? 'consecutiveGood' : 'totalGood', gte: Math.max(1, rule.times) }]
}

export function ladderToPathway(ladder: Ladder): Pathway {
  const rungs = ladder.rungs
  const states: PathwayState[] = rungs.map((r, i) => ({
    id: r.id, name: `State ${i + 1}`,
    type: r.type, direction: r.direction, distractorSource: r.distractorSource,
    strictness: r.strictness, selfRated: r.selfRated, intervalInit: r.intervalInit,
  }))
  states.push(TERMINAL)

  const transitions: Transition[] = []
  rungs.forEach((rung, i) => {
    const next = i + 1 < rungs.length ? rungs[i + 1]!.id : GRAD_STATE_ID
    // drop-backs (priority 10) and skip-aheads (priority 20) outrank the advance (priority 100),
    // matching the ladder engine's evaluation order (drop-back, then skip, then advance).
    rung.dropBacks.forEach((rule, k) => transitions.push({
      id: `${rung.id}-db-${k}`, from: rung.id, to: rule.toRungId, priority: 10, when: dropBackCondition(rule),
    }))
    ;(rung.skipAheads ?? []).forEach((rule, k) => transitions.push({
      id: `${rung.id}-sk-${k}`, from: rung.id, to: rule.toRungId, priority: 20, when: skipCondition(rule),
    }))
    transitions.push(...advanceTransitions(rung, rung.id, next))
  })

  return {
    id: 'from-ladder',
    startStateId: rungs[0]?.id ?? GRAD_STATE_ID,
    states,
    transitions,
    betweenStateWaitSeconds: ladder.betweenRungWaitSeconds ?? 180,
  }
}
