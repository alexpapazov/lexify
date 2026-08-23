/**
 * lib/catchUp.ts — spreading an overdue backlog across the days up to a date you choose.
 *
 * When you fall behind, "Study all due (1693)" is not a plan, it's a wall. Catch-up deals the
 * overdue cards out across real due dates (`assignBacklogDays`), so every surface — the forecast
 * chart, the deck counts, the session queues — sees the same schedule with no extra logic.
 *
 * This module is the pure math only. Turning rows into candidates and writing the moved dates lives
 * in `lib/catchUpPools.ts`; tracking a spread as a followable plan lives in `lib/catchUpPlan.ts`.
 *
 * ── Ordering: deferral damage, not "most overdue" ─────────────────────────────
 * The cost of delaying a card is NOT monotonic in how forgotten it is. A card at R=0.95 is safe and
 * loses little by waiting; a card at R=0.05 is already gone and loses little more. The damage peaks in
 * the middle — the about-to-slip band. So the primary sort is projected recall LOST over the remaining
 * window, which peaks mid-band on its own and leaves both extremes alone.
 *
 * Deeply lapsed cards (below `LAPSED_R`) are drained as a separate stratum at their own steady rate,
 * capped so no day is more than `MAX_LAPSED_SHARE` relearning, then spread evenly across the window.
 * Without that cap and that spread you either front-load a wall of relearning or push it all to the
 * final days.
 */

import { retrievability } from '@/engine/fsrs'

/** Below this recall probability a review is really a relearn — slow, and it lands as a lapse. */
export const LAPSED_R = 0.30

/** No session is ever more than this fraction relearning, however far behind you are. */
export const MAX_LAPSED_SHARE = 0.25

/** The three buckets the "Study all due" popover already splits each language into. */
export type CatchUpType = 'typing' | 'sgForward' | 'sgReverse'

// ─── Scope ────────────────────────────────────────────────────────────────────

/** `"bg|en"` or `"bg|en:typing"`. `pairKey` is the existing `${source}|${target}`. */
export function scopeKey(pairKey: string, type?: CatchUpType | null): string {
  return type ? `${pairKey}:${type}` : pairKey
}

/**
 * The languages a scope's reviews actually run between, PROMPT FIRST.
 *
 * A pair key is `${sourceLanguage}|${targetLanguage}` where `source` is the language being learned
 * and `target` is the learner's native language (see the domain conventions in CLAUDE.md — this is
 * easy to get backwards). Which way a review runs then depends on the card type, NOT on the pair:
 *
 *  - **typing** and **sgForward** are forward PRODUCTION: prompted in the native language, you
 *    produce the language you're learning. English → Bulgarian.
 *  - **sgReverse** is recognition: prompted in the language you're learning. Bulgarian → English.
 *
 * A whole-language scope covers both, so it has no single direction — `bidirectional` says to render
 * it with a two-headed arrow rather than implying one.
 *
 * Mirrors the `n2t` flag in the study dashboard's "Study all due" popover; keep the two in step.
 */
export function scopeDirection(
  source: string,
  target: string,
  type: CatchUpType | null,
): { from: string; to: string; bidirectional: boolean } {
  if (type === null)        return { from: source, to: target, bidirectional: true }
  if (type === 'sgReverse') return { from: source, to: target, bidirectional: false }
  return { from: target, to: source, bidirectional: false }
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

/** A candidate with its ranking numbers for one particular window. Internal to the spreader. */
interface RankedCandidate extends CatchUpCandidate {
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

// ─── Spreading a backlog across the window ────────────────────────────────────

export interface SpreadResult {
  /** Candidate key → the YYYY-MM-DD it should now be due on. */
  assignments: Map<string, string>
  /** The days used, earliest first. */
  days: string[]
  /** How many backlog cards landed on each day. */
  perDay: Map<string, number>
  /** How many of the assignments are deeply lapsed cards. */
  lapsedCount: number
  /**
   * The comfort cap bound on at least one day: the lapsed pool is too large to spread at
   * `MAX_LAPSED_SHARE` without overflowing, so some days carry more relearning than the cap intends.
   */
  lapsedCapped: boolean
}

/**
 * Assigns every overdue card a new due date inside the window.
 *
 * Three things decide the layout:
 *
 *  1. **Existing load is levelled against.** The days ahead already carry their own arrivals (the
 *     "Coming up" bars), so the backlog is poured into the gaps rather than spread flat on top —
 *     otherwise a day that already had 249 due gets the same share as one that had 114.
 *  2. **Highest deferral damage lands earliest.** Cards that lose the most recall by waiting are
 *     assigned to the nearest days; rock-solid and long-gone cards drift later, since neither loses
 *     much by waiting (see the header note on why this is not "most overdue first").
 *  3. **Deeply lapsed cards are spread evenly across ALL days**, not sorted into a block. Relearning
 *     is the slow, punishing work; concentrating it would make some days far harder than their card
 *     count suggests.
 */
export function assignBacklogDays(args: {
  overdue:  CatchUpCandidate[]
  today:    string
  /** Number of days to spread across, starting today. */
  days:     number
  /** Cards already scheduled on each YYYY-MM-DD in the window, so the fill can level against them. */
  existingLoad?: Map<string, number>
}): SpreadResult {
  const nDays = Math.max(1, Math.floor(args.days))
  const days  = Array.from({ length: nDays }, (_, i) => addDays(args.today, i))
  const perDay = new Map(days.map(d => [d, 0]))
  const assignments = new Map<string, string>()

  if (args.overdue.length === 0) {
    return { assignments, days, perDay, lapsedCount: 0, lapsedCapped: false }
  }

  const ranked  = args.overdue.map(c => rank(c, nDays))
  const lapsed  = ranked.filter(c => c.retrievability <  LAPSED_R)
  const salvage = ranked.filter(c => c.retrievability >= LAPSED_R)
    .sort((a, b) => b.deferralLoss - a.deferralLoss)

  // ── Capacity per day ───────────────────────────────────────────────────────
  // Level the TOTAL (existing arrivals + backlog) across the window, then each day's capacity is
  // whatever that leaves after its own arrivals. A day already busier than the level target takes no
  // backlog at all.
  const existing = args.existingLoad ?? new Map<string, number>()
  const existingTotal = days.reduce((t, d) => t + (existing.get(d) ?? 0), 0)
  const level = (existingTotal + ranked.length) / nDays
  const capacity = new Map(days.map(d => [d, Math.max(0, level - (existing.get(d) ?? 0))]))

  // Rounding and already-overloaded days can leave the capacities short of what must be placed;
  // top every day up evenly so nothing is left unassigned.
  let slack = [...capacity.values()].reduce((t, c) => t + c, 0)
  if (slack < ranked.length) {
    const topUp = (ranked.length - slack) / nDays
    for (const d of days) capacity.set(d, (capacity.get(d) ?? 0) + topUp)
  }

  // ── Lapsed first, spread evenly across every day ───────────────────────────
  const lapsedPerDay = lapsed.length / nDays
  let lapsedCapped = false
  let li = 0
  const lapsedOnDay = new Map<string, number>()
  for (let i = 0; i < nDays && li < lapsed.length; i++) {
    const day = days[i]!
    // Fractional accumulation, so a pool smaller than the window still lands one per day rather than
    // rounding to zero and dumping the remainder at the end.
    const want = Math.round(lapsedPerDay * (i + 1)) - li
    const cap  = Math.max(1, Math.floor((capacity.get(day) ?? 0) * MAX_LAPSED_SHARE))
    const take = Math.min(want, lapsed.length - li)
    if (take > cap) lapsedCapped = true
    for (let k = 0; k < take; k++) assignments.set(lapsed[li++]!.key, day)
    lapsedOnDay.set(day, take)
    perDay.set(day, (perDay.get(day) ?? 0) + take)
  }
  // Anything left over (window shorter than the rounding assumed) goes on the last day.
  while (li < lapsed.length) {
    const day = days[nDays - 1]!
    assignments.set(lapsed[li++]!.key, day)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }

  // ── Salvage, highest damage into the earliest day with room ────────────────
  let si = 0
  for (const day of days) {
    if (si >= salvage.length) break
    const room = Math.max(0, Math.round((capacity.get(day) ?? 0) - (lapsedOnDay.get(day) ?? 0)))
    for (let k = 0; k < room && si < salvage.length; k++) {
      assignments.set(salvage[si++]!.key, day)
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
    }
  }
  // Rounding can leave a tail; distribute it over the lightest days so nothing bunches up.
  while (si < salvage.length) {
    const lightest = days.reduce((a, b) => ((perDay.get(a) ?? 0) <= (perDay.get(b) ?? 0) ? a : b))
    assignments.set(salvage[si++]!.key, lightest)
    perDay.set(lightest, (perDay.get(lightest) ?? 0) + 1)
  }

  return { assignments, days, perDay, lapsedCount: lapsed.length, lapsedCapped }
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
