/**
 * lib/data/reviewPrograms.ts — the program builder's per-day state rows (migration 134).
 * ONLINE ONLY: programs are a Due Now feature and Due Now scheduling writes need the live DB
 * anyway. No read cache — a program row is hot mutable state during a run.
 */

import { createClient } from '@/lib/supabase/client'
import type { UserId } from '@/domain'
import type { StageKind, WordProgress } from '@/engine/program'

export interface ReviewProgram {
  id:             string
  userId:         UserId
  sourceLanguage: string
  targetLanguage: string
  direction:      'production' | 'recognition'
  /** Turnover-aware local day (YYYY-MM-DD) the client computed at creation. */
  day:            string
  stages:         StageKind[]
  progress:       Record<string, WordProgress>
  finalizedAt:    string | null
}

function rowToProgram(row: Record<string, unknown>): ReviewProgram {
  return {
    id:             row.id as string,
    userId:         row.user_id as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    direction:      (row.direction as ReviewProgram['direction']) ?? 'production',
    day:            row.day as string,
    stages:         (row.stages as StageKind[] | null) ?? [],
    progress:       (row.progress as Record<string, WordProgress> | null) ?? {},
    finalizedAt:    (row.finalized_at as string | null) ?? null,
  }
}

export class SupabaseReviewProgramRepository {
  private get db() { return createClient() }

  /** Every un-finalized row — today's live programs plus any stale ones owing their boosts. */
  async listOpen(userId: UserId): Promise<ReviewProgram[]> {
    const { data, error } = await this.db
      .from('review_programs')
      .select('*')
      .eq('user_id', userId)
      .is('finalized_at', null)
      .order('day', { ascending: true })
    if (error) throw error
    return (data ?? []).map(rowToProgram)
  }

  /** Gets-or-creates the day's row for a batch; a re-open with different stages REPLACES the
   *  chain but keeps progress (words keep their cleared counts — strengths are max-over-prefix
   *  so a weaker new chain never revokes earned credit). */
  async open(userId: UserId, input: {
    sourceLanguage: string
    targetLanguage: string
    direction: 'production' | 'recognition'
    day: string
    stages: StageKind[]
  }): Promise<ReviewProgram> {
    const { data, error } = await this.db
      .from('review_programs')
      .upsert({
        user_id: userId,
        source_language: input.sourceLanguage, target_language: input.targetLanguage,
        direction: input.direction, day: input.day, stages: input.stages,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,source_language,target_language,direction,day', ignoreDuplicates: false })
      .select()
      .single()
    if (error) throw error
    return rowToProgram(data as Record<string, unknown>)
  }

  async saveProgress(id: string, progress: Record<string, WordProgress>): Promise<void> {
    const { error } = await this.db
      .from('review_programs')
      .update({ progress, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  }

  async markFinalized(id: string): Promise<void> {
    const { error } = await this.db
      .from('review_programs')
      .update({ finalized_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  }
}
