/**
 * lib/data/mediaEntries.ts — the media log (migration 128): one row per logged reading session.
 *
 * ONLINE ONLY, like journal/practice: parsing needs the AI route anyway, so there is no offline
 * bundle path. Soft delete — the log is the learner's reading history. No read cache: the media
 * page is the single reader and always wants the live list.
 */

import { createClient } from '@/lib/supabase/client'
import type { MediaEntry, UserId } from '@/domain'

function rowToEntry(row: Record<string, unknown>): MediaEntry {
  return {
    id:             row.id as string,
    userId:         row.user_id as string,
    kind:           (row.kind as MediaEntry['kind']) ?? 'book',
    title:          row.title as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    pages:          Number(row.pages ?? 0),
    markers:        row.markers ?? null,
    candidates:     (row.candidates as unknown[] | null) ?? [],
    unmarkedLemmas: (row.unmarked_lemmas as string[] | null) ?? [],
    stats:          (row.stats as Record<string, unknown> | null) ?? {},
    createdAt:      row.created_at as string,
    updatedAt:      row.updated_at as string,
    deletedAt:      (row.deleted_at as string | null) ?? null,
  }
}

export class SupabaseMediaEntryRepository {
  private get db() { return createClient() }

  /** Every live entry, newest first. */
  async list(userId: UserId): Promise<MediaEntry[]> {
    const { data, error } = await this.db
      .from('media_entries')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map(rowToEntry)
  }

  async create(userId: UserId, input: {
    kind?: MediaEntry['kind']
    title: string
    sourceLanguage: string
    targetLanguage: string
    pages: number
    markers: unknown
    candidates: unknown[]
    unmarkedLemmas?: string[]
    stats?: Record<string, unknown>
  }): Promise<MediaEntry> {
    const { data, error } = await this.db
      .from('media_entries')
      .insert({
        user_id: userId, kind: input.kind ?? 'book', title: input.title,
        source_language: input.sourceLanguage, target_language: input.targetLanguage,
        pages: input.pages, markers: input.markers, candidates: input.candidates,
        unmarked_lemmas: input.unmarkedLemmas ?? [], stats: input.stats ?? {},
      })
      .select()
      .single()
    if (error) throw error
    return rowToEntry(data as Record<string, unknown>)
  }

  /** Stats/candidates updates after actions run on an entry (commit, Stage E credit/known). */
  async update(id: string, patch: Partial<Pick<MediaEntry, 'candidates' | 'unmarkedLemmas' | 'stats' | 'markers'>>): Promise<MediaEntry> {
    const dbPatch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.candidates     !== undefined) dbPatch.candidates      = patch.candidates
    if (patch.unmarkedLemmas !== undefined) dbPatch.unmarked_lemmas = patch.unmarkedLemmas
    if (patch.stats          !== undefined) dbPatch.stats           = patch.stats
    if (patch.markers        !== undefined) dbPatch.markers         = patch.markers
    const { data, error } = await this.db
      .from('media_entries')
      .update(dbPatch)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return rowToEntry(data as Record<string, unknown>)
  }

  async softDelete(id: string): Promise<void> {
    const { error } = await this.db
      .from('media_entries')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  }
}
