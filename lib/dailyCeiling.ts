/**
 * lib/dailyCeiling.ts — the cap across ALL languages, and where the overflow goes.
 *
 * `profiles.daily_word_ceiling` is the most new words the learner will do in a day, counting every
 * language together. No per-schedule setting can express it: three languages each capped at 10 still
 * add up to 30, and only something that sees all of them at once can catch that.
 *
 * ── The cap DEFERS, it never discards ──
 * Words that don't fit today move to tomorrow, and are capped again there. That is the same contract
 * `capGoal` in `lib/goalCarryover.ts` already has ("the overflow is deferred, not forgiven"), and it
 * matters for the same reason: a cap that silently dropped work would quietly make every deadline
 * unreachable while showing you a comfortable daily number.
 *
 * ── Sharing one day between languages ──
 * When the day is oversubscribed the ceiling is WATER-FILLED across the languages wanting it, exactly
 * as `lib/goalSchedule.ts` water-fills words across days. So a language asking for 3 gets 3, and two
 * languages asking for 20 each split what's left evenly — a small demand is never trimmed to make
 * room for a large one. Proportional sharing would do the opposite, shaving the language that barely
 * wanted anything.
 *
 * ── Where the spill eventually runs out ──
 * `applyDailyCeiling` reports what still hasn't fit when the horizon ends. THAT is the real
 * infeasibility — not "some days are over the limit", which is only a statement about a plan that
 * hasn't been capped yet.
 */

import { waterFill, distributeIntegers } from './goalSchedule'

/** One language's ask for a single day. */
export interface DayDemand {
  key: string
  words: number
}

/**
 * How one day's ceiling is shared out. Returns the words each language actually gets; anything below
 * its demand is what the caller must carry forward.
 *
 * A null or non-positive ceiling means no limit — every language gets exactly what it asked for.
 */
export function shareDayAcrossLanguages(ceiling: number | null, demands: DayDemand[]): Map<string, number> {
  const out = new Map<string, number>()
  const total = demands.reduce((sum, d) => sum + Math.max(0, d.words), 0)

  if (ceiling == null || ceiling <= 0 || total <= ceiling) {
    for (const d of demands) out.set(d.key, Math.max(0, d.words))
    return out
  }

  // Cap each language at what it actually wants, then split the ceiling evenly among the rest.
  const caps = demands.map(d => Math.max(0, d.words))
  const { values } = waterFill(ceiling, caps)
  const whole = distributeIntegers(values, caps)
  demands.forEach((d, i) => out.set(d.key, whole[i] ?? 0))
  return out
}

export interface DailyCeilingResult {
  /** langKey → date → words actually planned once the cap has been applied. */
  planned: Map<string, Map<string, number>>
  /** langKey → words that never fit before the horizon ran out. */
  overflow: Map<string, number>
  /** Dates where the raw demand exceeded the ceiling and something had to move on. */
  deferredDays: string[]
  /** True when nothing had to move at all. */
  fits: boolean
}

/**
 * Walks the calendar in order applying the ceiling, carrying whatever doesn't fit into the next day.
 *
 * `demand` is each language's UNCAPPED plan (what `schedulePlan` produced). Dates must be ordered and
 * cover every date any language plans on; a date missing from a language's map counts as 0 for it.
 *
 * Carry-in is a projection device only. It never applies to TODAY, because a schedule re-derives its
 * daily number from what's left rather than from a backlog — see `lib/goalSchedule.ts`. So for
 * "what do I owe right now", call `shareDayAcrossLanguages` on today's demands instead of running
 * this and reading day zero.
 */
export function applyDailyCeiling({ dates, demand, ceiling }: {
  dates: string[]
  demand: Map<string, Map<string, number>>
  ceiling: number | null
}): DailyCeilingResult {
  const keys = [...demand.keys()]
  const planned = new Map(keys.map(k => [k, new Map<string, number>()]))
  const carry = new Map(keys.map(k => [k, 0]))
  const deferredDays: string[] = []

  for (const date of dates) {
    const demands: DayDemand[] = keys.map(key => ({
      key,
      words: (demand.get(key)?.get(date) ?? 0) + (carry.get(key) ?? 0),
    }))
    const wanted = demands.reduce((sum, d) => sum + d.words, 0)
    if (wanted <= 0) continue

    const share = shareDayAcrossLanguages(ceiling, demands)
    let moved = false
    for (const d of demands) {
      const got = share.get(d.key) ?? 0
      if (got > 0) planned.get(d.key)!.set(date, got)
      const left = d.words - got
      carry.set(d.key, left)
      if (left > 0) moved = true
    }
    if (moved) deferredDays.push(date)
  }

  const overflow = new Map<string, number>()
  for (const [key, left] of carry) if (left > 0) overflow.set(key, left)

  return { planned, overflow, deferredDays, fits: deferredDays.length === 0 }
}
