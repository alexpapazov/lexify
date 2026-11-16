/**
 * lib/data/studySessions.ts — the external-study session log (migration 133): one row per
 * study session that happened outside Lexify.
 *
 * ONLINE ONLY, like media/journal: matching + glossing need the network anyway. Soft delete —
 * the log is the learner's study history. No read cache: the sessions page is the single
 * reader and always wants the live list.
 */

import { createClient } from '@/lib/supabase/client'
import type { StudySession, UserId } from '@/domain'

function rowToSession(row: Record<string, unknown>): StudySession {
  return {
    id:             row.id as string,
    userId:         row.user_id as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    studiedOn:      row.studied_on as string,
    items:          (row.items as unknown[] | null) ?? [],
    stats:          (row.stats as Record<string, unknown> | null) ?? {},
    createdAt:      row.created_at as string,
    updatedAt:      row.updated_at as string,
    deletedAt:      (row.deleted_at as string | null) ?? null,
  }
}

export class SupabaseStudySessionRepository {
  private get db() { return createClient() }

  /** Every live session, most recent study day first. */
  async list(userId: UserId): Promise<StudySession[]> {
    const { data, error } = await this.db
      .from('study_sessions')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('studied_on', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map(rowToSession)
  }

  async create(userId: UserId, input: {
    sourceLanguage: string
    targetLanguage: string
    /** YYYY-MM-DD; the form clamps it to today or earlier. */
    studiedOn:      string
    items:          unknown[]
    stats?:         Record<string, unknown>
  }): Promise<StudySession> {
    const { data, error } = await this.db
      .from('study_sessions')
      .insert({
        user_id: userId,
        source_language: input.sourceLanguage, target_language: input.targetLanguage,
        studied_on: input.studiedOn, items: input.items, stats: input.stats ?? {},
      })
      .select()
      .single()
    if (error) throw error
    return rowToSession(data as Record<string, unknown>)
  }

  async softDelete(id: string): Promise<void> {
    const { error } = await this.db
      .from('study_sessions')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  }
}
