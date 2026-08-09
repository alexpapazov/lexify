/**
 * lib/analyticsData.ts — shared, cached window queries for the Analytics tabs.
 *
 * The Present tab mounts three components (`PresentSnapshot`, `AccuracyTrend`, `LearningEfficiency`)
 * that each independently fetched the SAME 30-day windows of `review_events`, `ladder_events` and
 * graduations, and each fetched `profiles` separately. `fetchAllRows` pages sequentially, so a user
 * with ~14k reviews in the window paid ~14 serial round trips per component — ~42 in total, ~42k
 * rows, to draw charts with ~30 points.
 *
 * These helpers route every one of those through `cachedRead`, so identical requests collapse into a
 * single fetch (in-flight de-dupe covers the same-tick mount; the 60s TTL covers tab switches).
 * Each returns the UNION of the columns the three components need, so they can share one row set.
 *
 * TWO THINGS TO PRESERVE if you touch this:
 *  - `windowStartIso` floors to UTC midnight. The old per-component `Date.now() - N*DAY` produced a
 *    different ISO string in every component (milliseconds apart), so the cache keys would never
 *    match and nothing would be shared. Keep the boundary stable.
 *  - Keep the column lists a SUPERSET of every consumer's needs. Trimming one to suit a single
 *    component silently breaks the others, which read fields off the shared rows.
 */

import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabasePaged'
import { cachedRead } from '@/lib/readCache'

type AnalyticsRow = Record<string, unknown>

const DAY_MS = 86_400_000

/**
 * Start of the window as an ISO timestamp, floored to UTC midnight `days` ago — stable for the whole
 * day so every caller produces the same cache key. Widening the window by up to 24h is immaterial
 * for a 30-day trend and makes the day buckets whole.
 */
function windowStartIso(days: number): string {
  const midnightToday = Math.floor(Date.now() / DAY_MS) * DAY_MS
  return new Date(midnightToday - days * DAY_MS).toISOString()
}

/** Due-mode review events in the window. Union of the columns all three consumers read. */
export function fetchReviewEventsWindow(userId: string, days: number): Promise<AnalyticsRow[]> {
  const since = windowStartIso(days)
  return cachedRead(`an:rev:${userId}:${since}`, () => fetchAllRows<AnalyticsRow>((f, t) =>
    createClient().from('review_events')
      .select('reviewed_at, response_ms, source_language, target_language, review_direction, was_typed, was_correct, near_miss, near_miss_weight')
      .eq('user_id', userId).eq('review_mode', 'due').gte('reviewed_at', since)
      .order('reviewed_at', { ascending: false }).range(f, t)))
}

/** Ladder (learning-pipeline) events in the window. */
export function fetchLadderEventsWindow(userId: string, days: number): Promise<AnalyticsRow[]> {
  const since = windowStartIso(days)
  return cachedRead(`an:lad:${userId}:${since}`, () => fetchAllRows<AnalyticsRow>((f, t) =>
    createClient().from('ladder_events')
      .select('created_at, duration_ms, source_language, target_language')
      .eq('user_id', userId).gte('created_at', since)
      .order('created_at', { ascending: false }).range(f, t)))
}

/** Forward graduations in the window (the denominator of "time per new word"). */
export function fetchGraduationsWindow(userId: string, days: number): Promise<AnalyticsRow[]> {
  const since = windowStartIso(days)
  return cachedRead(`an:grad:${userId}:${since}`, () => fetchAllRows<AnalyticsRow>((f, t) =>
    createClient().from('card_states')
      .select('graduated_at, accelerated_mode, cards(source_language, target_language)')
      .eq('user_id', userId).eq('graduated', true).neq('review_direction', 'reverse')
      .not('graduated_at', 'is', null).gte('graduated_at', since)
      .order('graduated_at', { ascending: false }).range(f, t)))
}

/** Graduations since an arbitrary date (full-debt's unbounded cumulative scan). */
export function fetchGraduationsSince(userId: string, sinceIso: string): Promise<AnalyticsRow[]> {
  return cachedRead(`an:gradsince:${userId}:${sinceIso}`, () => fetchAllRows<AnalyticsRow>((f, t) =>
    createClient().from('card_states')
      .select('graduated_at, accelerated_mode, cards(source_language, target_language)')
      .eq('user_id', userId).eq('graduated', true).neq('review_direction', 'reverse')
      .not('graduated_at', 'is', null).gte('graduated_at', sinceIso)
      .order('graduated_at', { ascending: true }).range(f, t)))
}

const PROFILE_CORE = 'timezone, day_turnover_hour, language_colors'
const PROFILE_GOALS =
  'goal_carry_shortfall, goal_carry_surplus, goal_full_debt, goal_full_debt_since, goal_full_debt_resets, ' +
  'full_debt_skip_shortfall_days, full_debt_skip_surplus_days, goal_deferrals, daily_word_ceiling'

/**
 * The analytics profile row — the union of what all three Present components read, fetched once.
 *
 * Hardened against the recurring landmine: a `SELECT` naming a not-yet-migrated column errors the
 * WHOLE row, so `data` comes back null and timezone/turnover silently reset to defaults (see
 * CLAUDE.md). Falls back to the always-present core columns, matching the study dashboard.
 */
export function fetchAnalyticsProfile(userId: string): Promise<AnalyticsRow | null> {
  return cachedRead(`an:profile:${userId}`, async () => {
    const db = createClient()
    const full = await db.from('profiles').select(`${PROFILE_CORE}, ${PROFILE_GOALS}`).eq('user_id', userId).maybeSingle()
    if (full.data) return full.data as AnalyticsRow
    const core = await db.from('profiles').select(PROFILE_CORE).eq('user_id', userId).maybeSingle()
    return (core.data as AnalyticsRow | null) ?? null
  })
}
