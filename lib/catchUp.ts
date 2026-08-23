/**
 * lib/catchUp.ts — draining a review backlog by a date you choose.
 *
 * When you fall behind, "Study all due (1693)" is not a plan, it's a wall. A catch-up plan turns it
 * into a daily number: pick the date you want to be level again, and every day this computes how many
 * reviews that costs and which ones to serve.
 *
 * ── Only the target date is stored ────────────────────────────────────────────
 * Everything else is DERIVED and recomputed each day, exactly like full-debt goal carryover
 * (`lib/goalCarryover.ts`). A stored "cards remaining" counter goes stale the moment you overshoot,
 * fall short, or a relearn lands, and then the plan quietly lies. Recomputing from the live backlog
 * self-corrects: overshoot today and tomorrow's number drops on its own.
 *
 * ── The quota splits in two, and the split is meaningful ──────────────────────
 *   quota = dueToday + ceil(overdue / daysRemaining)
 *
 * `dueToday` is non-negotiable — skip it and the backlog grows. `overdue` is the actual debt, spread
 * evenly over the days you have left. Note this trends DOWNWARD day to day, which a naive
 * `backlog / days` does not: that one climbs as new cards arrive and feels like the target is running
 * away from you.
 *
 * ── Ordering: deferral damage, not "most overdue" ─────────────────────────────
 * The cost of delaying a card is NOT monotonic in how forgotten it is. A card at R=0.95 is safe and
 * loses little by waiting; a card at R=0.05 is already gone and loses little more. The damage peaks in
 * the middle — the about-to-slip band. So the primary sort is projected recall LOST over the remaining
 * window, which peaks mid-band on its own and leaves both extremes alone.
 *
 * Deeply lapsed cards (below `LAPSED_R`) are drained as a separate stratum at their own steady rate,
 * capped so no session is more than `MAX_LAPSED_SHARE` relearning, then sprinkled evenly through the
 * queue. Without that cap and that sprinkle you either front-load a wall of relearning or push it all
 * to the final days.
 */

import { retrievability } from '@/engine/fsrs'

/** Below this recall probability a review is really a relearn — slow, and it lands as a lapse. */
export const LAPSED_R = 0.30

/** No session is ever more than this fraction relearning, however far behind you are. */
export const MAX_LAPSED_SHARE = 0.25

/** The three buckets the "Study all due" popover already splits each language into. */
export type CatchUpType = 'typing' | 'sgForward' | 'sgReverse'

/** All a plan stores. Everything else is derived from the live backlog. */
export interface CatchUpPlan {
  /** YYYY-MM-DD you want to be level again by. */
  targetDate: string
}

/** Keyed by `scopeKey()`: `"bg|en"` for a whole language, `"bg|en:typing"` for one card type. */
export type CatchUpPlans = Record<string, CatchUpPlan>

// ─── Scope ────────────────────────────────────────────────────────────────────

/** `"bg|en"` or `"bg|en:typing"`. `pairKey` is the existing `${source}|${target}`. */
export function scopeKey(pairKey: string, type?: CatchUpType | null): string {
  return type ? `${pairKey}:${type}` : pairKey
}

/**
 * The plan governing one (language, card type), most-specific-wins: a type-level plan beats the
 * language-level one, which covers whichever types have no plan of their own.
 */
export function resolvePlan(
  plans: CatchUpPlans,
  pairKey: string,
  type: CatchUpType,
): { key: string; plan: CatchUpPlan } | null {
  const typed = scopeKey(pairKey, type)
  if (plans[typed]) return { key: typed, plan: plans[typed]! }
  if (plans[pairKey]) return { key: pairKey, plan: plans[pairKey]! }
  return null
}

// ─── Dates ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

/** Whole days from `from` to `to` (both YYYY-MM-DD). Negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`)
  const b = Date.parse(`${to}T00:00:00.000Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / DAY_MS)
}

/** `today` plus `days`, as YYYY-MM-DD. */
export function addDays(today: string, days: number): string {
  const t = Date.parse(`${today}T00:00:00.000Z`)
  if (Number.isNaN(t)) return today
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10)
}

// ─── The quota ────────────────────────────────────────────────────────────────

export interface QuotaBreakdown {
  /** Total reviews to serve today. */
  quota: number
  /** Of that, cards that came due today — non-negotiable. */
  fromToday: number
  /** Of that, this day's slice of the backlog. */
  fromBacklog: number
  /** Days left including today; floored at 1 so the last day clears everything. */
  daysRemaining: number
  /** The date has passed and there is still a backlog — hold at the final quota. */
  pastTarget: boolean
}

/**
 * Today's number for one scope. On and after the target date `daysRemaining` floors at 1, so the
 * quota becomes "everything still owed" and simply holds there until the backlog actually clears —
 * nothing stops serving on its own.
 */
export function catchUpQuota(args: {
  overdue:    number
  dueToday:   number
  targetDate: string
  today:      string
}): QuotaBreakdown {
  const overdue  = Math.max(0, Math.floor(args.overdue))
  const dueToday = Math.max(0, Math.floor(args.dueToday))
  const daysRemaining = Math.max(1, daysBetween(args.today, args.targetDate))
  const fromBacklog = Math.ceil(overdue / daysRemaining)
  return {
    quota: dueToday + fromBacklog,
    fromToday: dueToday,
    fromBacklog,
    daysRemaining,
    pastTarget: daysBetween(args.today, args.targetDate) < 0,
  }
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

/**
 * A due review, as data. Deliberately NOT pre-ranked: deferral damage depends on how many days the
 * plan has left, which is the planner's business, not the pool's.
 */
export interface CatchUpCandidate {
  /** Stable identity for the queue item (card id + track), opaque here. */
  key: string
  /** Days of memory decay accumulated — see `elapsedDaysFor`. */
  elapsedDays: number
  /** FSRS stability in days, already seeded for rows that have none stored. */
  stability: number
}

/** A candidate with its ranking numbers for one particular window. */
export interface RankedCandidate extends CatchUpCandidate {
  /** Recall probability right now, 0–1. */
  retrievability: number
  /** Recall that would be lost by putting this off to the end of the window, 0–1. */
  deferralLoss: number
}

/**
 * Whether a card is deep enough in the forgotten band that reviewing it is really relearning.
 * Window-independent — recall right now doesn't depend on how long you plan to take.
 */
export function isLapsed(c: CatchUpCandidate): boolean {
  return retrievability(Math.max(0, c.elapsedDays), c.stability) < LAPSED_R
}

function rank(c: CatchUpCandidate, daysRemaining: number): RankedCandidate {
  return { ...c, ...candidateMetrics(c.elapsedDays, c.stability, daysRemaining) }
}

/**
 * The two ranking numbers for one card. `stability` must already be seeded (the caller has the
 * pair's retention; `engine/fsrs.ts: stabilityForInterval` is the seed for a row with none stored).
 */
export function candidateMetrics(
  elapsedDays:   number,
  stability:     number,
  daysRemaining: number,
): { retrievability: number; deferralLoss: number } {
  const r     = retrievability(Math.max(0, elapsedDays), stability)
  const later = retrievability(Math.max(0, elapsedDays) + Math.max(0, daysRemaining), stability)
  return { retrievability: r, deferralLoss: r - later }
}

/**
 * Days of memory decay a card has accumulated. Prefers the real gap since the last review; falls back
 * to `interval + days overdue` for rows that have never been reviewed (bulk-onboarded cards carry a
 * due date but a null `lastReviewedAt` by design).
 */
export function elapsedDaysFor(args: {
  lastReviewedAt: string | null
  intervalDays:   number | null
  daysOverdue:    number
  now:            number
}): number {
  if (args.lastReviewedAt) {
    const t = Date.parse(args.lastReviewedAt)
    if (!Number.isNaN(t)) return Math.max(0, (args.now - t) / DAY_MS)
  }
  return Math.max(0, (args.intervalDays ?? 0) + args.daysOverdue)
}

// ─── Building the day's queue ─────────────────────────────────────────────────

export interface CatchUpSession extends QuotaBreakdown {
  /** The cards to serve, already ordered and interleaved. */
  queue: RankedCandidate[]
  /** How many of the queue are deeply lapsed (relearning work). */
  lapsedServed: number
  /** Deeply lapsed cards still in the backlog after this session. */
  lapsedRemaining: number
  /**
   * The comfort cap bound: the lapsed pool cannot drain by the target date without sessions becoming
   * more than `MAX_LAPSED_SHARE` relearning. The cap wins; surface the later finish date instead of
   * silently breaking the promise.
   */
  lapsedCapped: boolean
}

/** Spreads `sprinkle` evenly through `main` rather than clumping it at either end. */
export function interleaveEvenly<T>(main: T[], sprinkle: T[]): T[] {
  if (sprinkle.length === 0) return [...main]
  if (main.length === 0) return [...sprinkle]
  const total = main.length + sprinkle.length
  const slots = new Set<number>()
  for (let i = 0; i < sprinkle.length; i++) {
    slots.add(Math.min(total - 1, Math.floor(((i + 0.5) * total) / sprinkle.length)))
  }
  const out: T[] = []
  let mi = 0
  let si = 0
  for (let p = 0; p < total; p++) {
    if (slots.has(p) && si < sprinkle.length) out.push(sprinkle[si++]!)
    else if (mi < main.length) out.push(main[mi++]!)
    else if (si < sprinkle.length) out.push(sprinkle[si++]!)
  }
  return out
}

/**
 * One day of a catch-up plan: how many, which ones, in what order.
 *
 * `dueToday` is served in full. The backlog slice is filled from two strata — deeply lapsed cards at
 * their own steady drain rate (capped), the rest by deferral damage — and the lapsed ones are then
 * spread through the result so the relearning is paced rather than piled up.
 */
export function planCatchUpSession(args: {
  dueToday:   CatchUpCandidate[]
  overdue:    CatchUpCandidate[]
  targetDate: string
  today:      string
}): CatchUpSession {
  const breakdown = catchUpQuota({
    overdue:  args.overdue.length,
    dueToday: args.dueToday.length,
    targetDate: args.targetDate,
    today:      args.today,
  })
  const { fromBacklog, daysRemaining, quota } = breakdown

  const ranked  = args.overdue.map(c => rank(c, daysRemaining))
  const lapsed  = ranked.filter(c => c.retrievability <  LAPSED_R)
  const salvage = ranked.filter(c => c.retrievability >= LAPSED_R)

  // The lapsed pool drains on the same derived formula, one level down — which is what keeps the mix
  // steady day to day instead of leaving a wall of relearning for the final days.
  const lapsedIdeal = Math.ceil(lapsed.length / daysRemaining)
  const lapsedCap   = Math.floor(quota * MAX_LAPSED_SHARE)
  const lapsedTake  = Math.min(lapsedIdeal, lapsedCap, lapsed.length, fromBacklog)

  // Among lost causes, the least-far-gone first; among the rest, whoever loses most by waiting.
  const lapsedPicked = [...lapsed]
    .sort((a, b) => b.retrievability - a.retrievability)
    .slice(0, lapsedTake)
  const salvagePicked = [...salvage]
    .sort((a, b) => b.deferralLoss - a.deferralLoss)
    .slice(0, Math.max(0, fromBacklog - lapsedPicked.length))

  const main = [...args.dueToday.map(c => rank(c, daysRemaining)), ...salvagePicked]
    .sort((a, b) => b.deferralLoss - a.deferralLoss)

  return {
    ...breakdown,
    queue: interleaveEvenly(main, lapsedPicked),
    lapsedServed:    lapsedPicked.length,
    lapsedRemaining: lapsed.length - lapsedPicked.length,
    lapsedCapped:    lapsed.length > 0 && lapsedIdeal > lapsedCap,
  }
}

// ─── Preview, for the date picker ─────────────────────────────────────────────

export interface CatchUpPreview {
  /** Reviews per day this target implies. */
  perDay: number
  /** Of that, the daily backlog slice. */
  fromBacklog: number
  /** Of that, the estimated daily arrivals. */
  fromInflow: number
  /** Estimated minutes per day, when a measured pace is available. */
  minutesPerDay: number | null
  /**
   * Days until the deeply lapsed cards clear. Exceeds `days` when the comfort cap binds — tell the
   * user this at the moment they pick the date, not after the target slips.
   */
  lapsedFinishesInDays: number
}

/**
 * What a candidate target date would cost, for the picker. An estimate by construction — the plan
 * re-derives every day from the real backlog — but it has to be honest about the lapsed tail.
 */
export function previewCatchUp(args: {
  overdue:     number
  lapsed:      number
  inflowPerDay: number
  days:        number
  msPerAnswer?: number | null
}): CatchUpPreview {
  const days        = Math.max(1, Math.floor(args.days))
  const overdue     = Math.max(0, args.overdue)
  const lapsed      = Math.min(Math.max(0, args.lapsed), overdue)
  const fromInflow  = Math.max(0, Math.round(args.inflowPerDay))
  const fromBacklog = Math.ceil(overdue / days)
  const perDay      = fromInflow + fromBacklog

  const lapsedPerDay = Math.min(Math.ceil(lapsed / days), Math.floor(perDay * MAX_LAPSED_SHARE))
  const lapsedFinishesInDays =
    lapsed === 0 ? 0 : lapsedPerDay > 0 ? Math.ceil(lapsed / lapsedPerDay) : Infinity

  return {
    perDay,
    fromBacklog,
    fromInflow,
    minutesPerDay: args.msPerAnswer ? (perDay * args.msPerAnswer) / 60_000 : null,
    lapsedFinishesInDays,
  }
}
