/**
 * lib/data/goalSchedules.ts — deadline-driven goal schedules (migration 114).
 *
 * The row is only the CONFIG. Every number a learner sees — today's goal, whether the schedule is
 * still possible, how far ahead or behind they are — is derived from it by `lib/goalSchedule.ts`,
 * which is why nothing here stores a running total. `baselineCount` is a snapshot, not a counter.
 *
 * ONLINE ONLY, like the goals settings it sits beside: schedules aren't in the offline bundle, and
 * the graduation scan `scheduleProgress` needs the server anyway.
 */

import { createClient } from '@/lib/supabase/client'
import { cachedRead, invalidateReads } from '@/lib/readCache'
import { fetchAllRows } from '@/lib/supabasePaged'
import { localDateWithTurnover } from '@/lib/dates'
import { isAutoGraduated } from '@/lib/goalCarryover'
import type { GoalSchedule, GoalScheduleCheckpoint, GoalTargetKind, UserId } from '@/domain'

function rowToSchedule(row: Record<string, unknown>): GoalSchedule {
  return {
    id:             row.id as string,
    userId:         row.user_id as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    name:           (row.name as string | null) ?? null,
    targetKind:     (row.target_kind as GoalTargetKind) ?? 'new_words',
    targetCount:    (row.target_count as number) ?? 0,
    startDate:      row.start_date as string,
    deadline:       row.deadline as string,
    baselineCount:  (row.baseline_count as number) ?? 0,
    dailyCeiling:   (row.daily_ceiling as number | null) ?? null,
    weekdayLimits:  (row.weekday_limits as Record<string, number | null> | null) ?? null,
    dateExceptions: (row.date_exceptions as Record<string, number> | null) ?? null,
    checkpoints:    (row.checkpoints as GoalScheduleCheckpoint[] | null) ?? [],
    archivedAt:     (row.archived_at as string | null) ?? null,
    createdAt:      row.created_at as string,
    updatedAt:      row.updated_at as string,
  }
}

/** The editable half of a schedule — everything except identity and timestamps. */
export type GoalScheduleInput = Pick<
  GoalSchedule,
  'sourceLanguage' | 'targetLanguage' | 'name' | 'targetKind' | 'targetCount' |
  'startDate' | 'deadline' | 'baselineCount' | 'dailyCeiling' | 'weekdayLimits' |
  'dateExceptions' | 'checkpoints'
>

export class SupabaseGoalScheduleRepository {
  private get db() { return createClient() }

  /** Every live (non-archived) schedule, one per pair at most. */
  async listActive(userId: UserId): Promise<GoalSchedule[]> {
    return cachedRead(`goalsched:${userId}:active`, async () => {
      const { data, error } = await this.db.from('goal_schedules')
        .select('*').eq('user_id', userId).is('archived_at', null)
        .order('deadline', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []).map(rowToSchedule)
    })
  }

  /** Retired schedules, most recently finished first — the record of what was attempted. */
  async listArchived(userId: UserId): Promise<GoalSchedule[]> {
    return cachedRead(`goalsched:${userId}:archived`, async () => {
      const { data, error } = await this.db.from('goal_schedules')
        .select('*').eq('user_id', userId).not('archived_at', 'is', null)
        .order('archived_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []).map(rowToSchedule)
    })
  }

  async getForPair(userId: UserId, sourceLanguage: string, targetLanguage: string): Promise<GoalSchedule | null> {
    const active = await this.listActive(userId)
    return active.find(s => s.sourceLanguage === sourceLanguage && s.targetLanguage === targetLanguage) ?? null
  }

  /**
   * Creates or replaces the pair's active schedule. The partial unique index allows exactly one, so
   * this upserts on the pair rather than quietly creating a second live schedule that the goal
   * surfaces would then have to choose between.
   */
  async save(userId: UserId, input: GoalScheduleInput): Promise<GoalSchedule> {
    invalidateReads('goalsched:')
    const existing = await this.getForPair(userId, input.sourceLanguage, input.targetLanguage)
    const payload = {
      user_id:         userId,
      source_language: input.sourceLanguage,
      target_language: input.targetLanguage,
      name:            input.name?.trim() || null,
      target_kind:     input.targetKind,
      target_count:    input.targetCount,
      start_date:      input.startDate,
      deadline:        input.deadline,
      baseline_count:  input.baselineCount,
      daily_ceiling:   input.dailyCeiling,
      weekday_limits:  input.weekdayLimits,
      date_exceptions: input.dateExceptions,
      checkpoints:     input.checkpoints,
      updated_at:      new Date().toISOString(),
    }
    const query = existing
      ? this.db.from('goal_schedules').update(payload).eq('id', existing.id)
      : this.db.from('goal_schedules').insert(payload)
    const { data, error } = await query.select().single()
    invalidateReads('goalsched:')
    if (error) throw new Error(error.message)
    return rowToSchedule(data)
  }

  /**
   * Retires a schedule without deleting it — the pair falls straight back to its weekday goals, and
   * the attempt stays on record. Archiving frees the pair for a new schedule (the unique index only
   * covers live rows).
   */
  async archive(id: string): Promise<void> {
    invalidateReads('goalsched:')
    const { error } = await this.db.from('goal_schedules')
      .update({ archived_at: new Date().toISOString() }).eq('id', id)
    if (error) throw new Error(error.message)
  }

  async remove(id: string): Promise<void> {
    invalidateReads('goalsched:')
    const { error } = await this.db.from('goal_schedules').delete().eq('id', id)
    if (error) throw new Error(error.message)
  }
}

// ─── Progress ─────────────────────────────────────────────────────────────────

export interface ScheduleProgressArgs {
  userId: UserId
  schedule: Pick<GoalSchedule, 'sourceLanguage' | 'targetLanguage' | 'targetKind' | 'startDate'>
  timezone: string
  turnoverHour: number
}

/**
 * How far along a schedule is, in its own target units — the `doneSoFar` that `scheduleStatus` takes.
 *
 *   'new_words'   → ladder graduations for the pair since `startDate` (auto-graduated EXCLUDED)
 *   'total_words' → the pair's whole graduated vocabulary right now (auto-graduated INCLUDED)
 *
 * Only forward rows count: a reverse `card_states` row is the same word's recognition track, not a
 * second word.
 */
export async function scheduleProgress({ userId, schedule, timezone, turnoverHour }: ScheduleProgressArgs): Promise<number> {
  const db = createClient()

  if (schedule.targetKind === 'total_words') {
    // A plain count — no rows shipped, and it can't hit the 1000-row cap.
    const { count, error } = await db.from('card_states')
      .select('id, cards!inner(source_language, target_language)', { count: 'exact', head: true })
      .eq('user_id', userId).eq('graduated', true).neq('review_direction', 'reverse')
      .eq('cards.source_language', schedule.sourceLanguage)
      .eq('cards.target_language', schedule.targetLanguage)
    if (error) throw new Error(error.message)
    return count ?? 0
  }

  // 'new_words': the day bucket is turnover-aware, so widen the fetch by 48h either side of the
  // start date and filter by local study-day — the same shape the dashboard's full-debt scan uses.
  const rows = await fetchAllRows<Record<string, unknown>>(
    (from, to) => db.from('card_states')
      .select('graduated_at, accelerated_mode, cards!inner(source_language, target_language)')
      .eq('user_id', userId).eq('graduated', true).neq('review_direction', 'reverse')
      .not('graduated_at', 'is', null)
      .eq('cards.source_language', schedule.sourceLanguage)
      .eq('cards.target_language', schedule.targetLanguage)
      .gte('graduated_at', new Date(new Date(schedule.startDate + 'T00:00:00Z').getTime() - 48 * 3600 * 1000).toISOString())
      .order('graduated_at', { ascending: true }).range(from, to),
  )

  let total = 0
  for (const row of rows) {
    const r = row as { graduated_at: string; accelerated_mode: string | null }
    if (!r.graduated_at) continue
    if (isAutoGraduated(r.accelerated_mode)) continue
    if (localDateWithTurnover(r.graduated_at, timezone, turnoverHour) >= schedule.startDate) total++
  }
  return total
}

/**
 * `doneSoFar` for EVERY active schedule at once, keyed `${src}|${tgt}` — what the goal surfaces feed
 * into `scheduleStatus`.
 *
 * One paged read covers all the `new_words` schedules (a single window from the earliest start date,
 * bucketed per pair) plus one cheap head-count per `total_words` schedule. Doing it per pair instead
 * would be an N+1 on the study dashboard's critical path.
 *
 * Deliberately NOT memoised through `readCache`: the answer changes the moment you graduate a card,
 * and the whole point of the number is to move as you study.
 */
export async function progressForSchedules({ userId, schedules, timezone, turnoverHour }: {
  userId: UserId
  schedules: GoalSchedule[]
  timezone: string
  turnoverHour: number
}): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (schedules.length === 0) return out

  const db = createClient()
  const newWord = schedules.filter(s => s.targetKind === 'new_words')
  const totals  = schedules.filter(s => s.targetKind === 'total_words')

  const totalsP = Promise.all(totals.map(async s => {
    const n = await currentVocabularySize(userId, s.sourceLanguage, s.targetLanguage).catch(() => 0)
    return [`${s.sourceLanguage}|${s.targetLanguage}`, n] as const
  }))

  if (newWord.length > 0) {
    const earliest = newWord.reduce((min, s) => (s.startDate < min ? s.startDate : min), newWord[0]!.startDate)
    const rows = await fetchAllRows<Record<string, unknown>>(
      (from, to) => db.from('card_states')
        .select('graduated_at, accelerated_mode, cards(source_language, target_language)')
        .eq('user_id', userId).eq('graduated', true).neq('review_direction', 'reverse')
        .not('graduated_at', 'is', null)
        // 48h of slack so a turnover-shifted study-day at the boundary isn't cut off.
        .gte('graduated_at', new Date(new Date(earliest + 'T00:00:00Z').getTime() - 48 * 3600 * 1000).toISOString())
        .order('graduated_at', { ascending: true }).range(from, to),
    ).catch(() => [] as Record<string, unknown>[])

    const startByPair = new Map(newWord.map(s => [`${s.sourceLanguage}|${s.targetLanguage}`, s.startDate]))
    for (const key of startByPair.keys()) out.set(key, 0)

    for (const row of rows) {
      const r = row as { graduated_at: string; accelerated_mode: string | null; cards: { source_language: string; target_language: string } | null }
      if (!r.graduated_at || !r.cards) continue
      if (isAutoGraduated(r.accelerated_mode)) continue
      const key = `${r.cards.source_language}|${r.cards.target_language}`
      const start = startByPair.get(key)
      // Each schedule counts from ITS OWN start; the shared window is wider than any single one.
      if (start && localDateWithTurnover(r.graduated_at, timezone, turnoverHour) >= start) {
        out.set(key, (out.get(key) ?? 0) + 1)
      }
    }
  }

  for (const [key, n] of await totalsP) out.set(key, n)
  return out
}

/**
 * The pair's current graduated vocabulary — what a new `total_words` schedule records as its
 * baseline, so "reach 2000 words" can show how far along it already is.
 */
export async function currentVocabularySize(userId: UserId, sourceLanguage: string, targetLanguage: string): Promise<number> {
  const db = createClient()
  const { count, error } = await db.from('card_states')
    .select('id, cards!inner(source_language, target_language)', { count: 'exact', head: true })
    .eq('user_id', userId).eq('graduated', true).neq('review_direction', 'reverse')
    .eq('cards.source_language', sourceLanguage).eq('cards.target_language', targetLanguage)
  if (error) throw new Error(error.message)
  return count ?? 0
}
