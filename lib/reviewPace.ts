/**
 * lib/reviewPace.ts — how long a Due Now review actually takes this learner.
 *
 * Extracted from `components/analytics/PresentSnapshot.tsx`, which measured it first and still uses
 * it, so the "~N min" the catch-up picker quotes and the "~N min" on the Present tab can never come
 * from two different implementations of the same weighted median.
 *
 * Two properties worth preserving if you touch this:
 *  - **Bucketed, not global.** A typed Spanish production review and a reverse Korean recognition are
 *    not the same task. Pace is measured per language × direction × typed-or-not, widening to broader
 *    buckets only when a narrow one is too thin to trust.
 *  - **Recency-weighted MEDIAN, not mean.** One "walked away mid-review" sample would wreck a mean.
 *    Weighting by recency lets the estimate re-tune itself within about a week as you get faster,
 *    which is why a long history window is safe — old data decays rather than anchoring.
 */

const DAY_MS = 86_400_000

/** Fallback per-review time when there is no timing history at all. */
export const DEFAULT_DUE_MS = 8_000

/** A review 7 days old counts half as much as one from today. */
export const HALF_LIFE_DAYS = 7

/** Minimum *weighted* samples before a bucket is trusted on its own. */
export const MIN_EFF_SAMPLES = 3

/** Exponential recency weight: 1.0 today → 0.5 at one half-life → 0.25 at two. */
export function recencyWeight(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS)
}

export interface WSample { v: number; w: number }

export const totalWeight = (xs: WSample[]) => xs.reduce((t, p) => t + p.w, 0)

/**
 * Weighted median — robust to outliers the way a plain median is, while letting recent reviews
 * dominate. Returns the value at the 50% mark of accumulated weight.
 */
export function weightedMedian(xs: WSample[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a.v - b.v)
  const total = totalWeight(s)
  if (total <= 0) return null
  let acc = 0
  for (const p of s) { acc += p.w; if (acc >= total / 2) return p.v }
  return s[s.length - 1]!.v
}

export function paceKey(src: string, tgt: string, dir: 'forward' | 'reverse', typed: boolean): string {
  return `${src}|${tgt}|${dir}|${typed ? 't' : 's'}`
}

export type PaceSamples = Map<string, WSample[]>

/** One review_events row, as far as pace measurement is concerned. */
export interface PaceRow {
  response_ms?:      number | null
  reviewed_at?:      string | null
  source_language?:  string | null
  target_language?:  string | null
  review_direction?: string | null
  was_typed?:        boolean | null
}

/** Buckets a set of review rows into weighted samples. Rows with no recorded duration are skipped. */
export function buildPaceSamples(rows: PaceRow[], now: number): PaceSamples {
  const samples: PaceSamples = new Map()
  const push = (k: string, s: WSample) => {
    const a = samples.get(k)
    if (a) a.push(s); else samples.set(k, [s])
  }
  for (const e of rows) {
    const ms = e.response_ms ?? 0
    if (ms <= 0 || !e.reviewed_at) continue
    const s: WSample = { v: ms, w: recencyWeight((now - new Date(e.reviewed_at).getTime()) / DAY_MS) }
    const src = e.source_language ?? ''
    const tgt = e.target_language ?? ''
    const dir: 'forward' | 'reverse' = e.review_direction === 'reverse' ? 'reverse' : 'forward'
    const typed = !!e.was_typed
    push('all', s)
    push(`${dir}|${typed ? 't' : 's'}`, s)
    if (src && tgt) { push(`${src}|${tgt}|${dir}`, s); push(paceKey(src, tgt, dir, typed), s) }
  }
  return samples
}

/**
 * Recency-weighted median response time for a bucket, widening when a bucket is too thin to trust:
 * exact (language × direction × typed) → same language + direction → same direction + presentation
 * across languages → global → fixed fallback. Thinness is judged on *weighted* samples, so three
 * reviews from last week count for less than three from today.
 */
export function pace(
  samples: PaceSamples, src: string, tgt: string, dir: 'forward' | 'reverse', typed: boolean,
): number {
  const tryKeys = [
    paceKey(src, tgt, dir, typed),
    `${src}|${tgt}|${dir}`,
    `${dir}|${typed ? 't' : 's'}`,
    'all',
  ]
  for (const k of tryKeys) {
    const xs = samples.get(k)
    if (xs && totalWeight(xs) >= MIN_EFF_SAMPLES) {
      const m = weightedMedian(xs)
      if (m != null && m > 0) return m
    }
  }
  const any = weightedMedian(samples.get('all') ?? [])
  return any && any > 0 ? any : DEFAULT_DUE_MS
}
