/**
 * lib/catchUpSession.ts — applying catch-up plans to a session queue that has already been built.
 *
 * The session assembles its due queue as it always has; this decides how much of it to actually serve
 * and in what order. Deliberately a late, separate step rather than a change to the queue builders:
 * an ungoverned scope must come out byte-identical to before, so turning catch-up on can never alter
 * how a language you have not planned behaves.
 *
 * A session can span several languages, and plans are per scope, so the queue is grouped by governing
 * plan, each group is planned independently, and ungoverned cards pass straight through. Groups are
 * then merged round-robin so a mixed session doesn't do all of one language before touching the next.
 */

import {
  planCatchUpSession, resolvePlan,
  type CatchUpCandidate, type CatchUpPlans, type CatchUpType,
} from '@/lib/catchUp'

/** What the caller must be able to say about one queue item for it to be plannable. */
export interface QueueItemFacts {
  pairKey:   string
  type:      CatchUpType
  bucket:    'overdue' | 'today'
  candidate: CatchUpCandidate
}

export interface CatchUpApplication<T> {
  /** The queue to serve. Identical to the input (order included) when nothing is governed. */
  queue: T[]
  /** True when at least one plan applied — i.e. the queue was capped rather than served whole. */
  governed: boolean
  /** How many items a plan held back for later days. */
  heldBack: number
  /** Of what was served, how many are deeply lapsed. */
  lapsedServed: number
}

/** Round-robin merge, preserving each group's internal order. */
function mergeRoundRobin<T>(groups: T[][]): T[] {
  const out: T[] = []
  const longest = Math.max(0, ...groups.map(g => g.length))
  for (let i = 0; i < longest; i++) {
    for (const g of groups) if (i < g.length) out.push(g[i]!)
  }
  return out
}

export function applyCatchUpPlans<T>(args: {
  items:    T[]
  describe: (item: T) => QueueItemFacts | null
  plans:    CatchUpPlans
  today:    string
}): CatchUpApplication<T> {
  const { items, describe, plans, today } = args
  if (Object.keys(plans).length === 0) {
    return { queue: items, governed: false, heldBack: 0, lapsedServed: 0 }
  }

  const ungoverned: T[] = []
  /** planKey → the items it governs, indexed so the planner's output can be mapped back. */
  const groups = new Map<string, {
    targetDate: string
    byKey: Map<string, T>
    dueToday: CatchUpCandidate[]
    overdue:  CatchUpCandidate[]
  }>()

  for (const item of items) {
    const facts = describe(item)
    const found = facts ? resolvePlan(plans, facts.pairKey, facts.type) : null
    if (!facts || !found) { ungoverned.push(item); continue }

    let g = groups.get(found.key)
    if (!g) {
      g = { targetDate: found.plan.targetDate, byKey: new Map(), dueToday: [], overdue: [] }
      groups.set(found.key, g)
    }
    // A duplicate key would silently drop one of the two reviews, so keep the first and let the
    // second pass through ungoverned rather than vanish.
    if (g.byKey.has(facts.candidate.key)) { ungoverned.push(item); continue }
    g.byKey.set(facts.candidate.key, item)
    ;(facts.bucket === 'overdue' ? g.overdue : g.dueToday).push(facts.candidate)
  }

  if (groups.size === 0) return { queue: items, governed: false, heldBack: 0, lapsedServed: 0 }

  let heldBack = 0
  let lapsedServed = 0
  const planned: T[][] = []
  for (const g of groups.values()) {
    const session = planCatchUpSession({
      dueToday: g.dueToday, overdue: g.overdue, targetDate: g.targetDate, today,
    })
    const served = session.queue
      .map(c => g.byKey.get(c.key))
      .filter((t): t is T => t !== undefined)
    heldBack += g.byKey.size - served.length
    lapsedServed += session.lapsedServed
    planned.push(served)
  }
  if (ungoverned.length > 0) planned.push(ungoverned)

  return { queue: mergeRoundRobin(planned), governed: true, heldBack, lapsedServed }
}
