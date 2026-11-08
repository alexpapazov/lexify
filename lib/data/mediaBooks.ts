/**
 * lib/data/mediaBooks.ts — books in the media log (migration 130): one record per book,
 * created once; reading entries file under it. ONLINE ONLY, like media entries.
 */

import { createClient } from '@/lib/supabase/client'
import type { MediaBook, UserId } from '@/domain'

function rowToBook(row: Record<string, unknown>): MediaBook {
  return {
    id:             row.id as string,
    userId:         row.user_id as string,
    title:          row.title as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    markers:        row.markers ?? null,
    deckId:         (row.deck_id as string | null) ?? null,
    createdAt:      row.created_at as string,
    updatedAt:      row.updated_at as string,
    deletedAt:      (row.deleted_at as string | null) ?? null,
  }
}

export class SupabaseMediaBookRepository {
  private get db() { return createClient() }

  async list(userId: UserId): Promise<MediaBook[]> {
    const { data, error } = await this.db
      .from('media_books')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map(rowToBook)
  }

  async create(userId: UserId, input: { title: string; sourceLanguage: string; targetLanguage: string; markers: unknown }): Promise<MediaBook> {
    const { data, error } = await this.db
      .from('media_books')
      .insert({
        user_id: userId, title: input.title,
        source_language: input.sourceLanguage, target_language: input.targetLanguage,
        markers: input.markers,
      })
      .select()
      .single()
    if (error) throw error
    return rowToBook(data as Record<string, unknown>)
  }

  async update(id: string, patch: Partial<Pick<MediaBook, 'title' | 'markers' | 'deckId'>>): Promise<MediaBook> {
    const dbPatch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.title   !== undefined) dbPatch.title   = patch.title
    if (patch.markers !== undefined) dbPatch.markers = patch.markers
    if (patch.deckId  !== undefined) dbPatch.deck_id = patch.deckId
    const { data, error } = await this.db
      .from('media_books')
      .update(dbPatch)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return rowToBook(data as Record<string, unknown>)
  }
}
