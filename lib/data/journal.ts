/**
 * lib/data/journal.ts — journal entries (migration 125): free-writing practice, v1 = data only.
 *
 * ONLINE ONLY, like practice: entries aren't in the offline bundle. Soft delete, like cards — a
 * learner's own writing must survive a mis-tap. No read cache: the journal page is the single
 * reader and always wants the live list.
 */

import { createClient } from '@/lib/supabase/client'
import type { JournalEntry, UserId } from '@/domain'

function rowToEntry(row: Record<string, unknown>): JournalEntry {
  return {
    id:        row.id as string,
    userId:    row.user_id as string,
    content:   row.content as string,
    languages: (row.languages as string[] | null) ?? [],
    prompt:    (row.prompt as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  }
}

export class SupabaseJournalRepository {
  private get db() { return createClient() }

  /** Every live entry, newest first. */
  async list(userId: UserId): Promise<JournalEntry[]> {
    const { data, error } = await this.db
      .from('journal_entries')
      .select('*')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map(rowToEntry)
  }

  async create(userId: UserId, input: { content: string; languages: string[]; prompt?: string | null }): Promise<JournalEntry> {
    const { data, error } = await this.db
      .from('journal_entries')
      .insert({ user_id: userId, content: input.content, languages: input.languages, prompt: input.prompt ?? null })
      .select()
      .single()
    if (error) throw error
    return rowToEntry(data as Record<string, unknown>)
  }

  async update(id: string, patch: { content?: string; languages?: string[] }): Promise<JournalEntry> {
    const { data, error } = await this.db
      .from('journal_entries')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return rowToEntry(data as Record<string, unknown>)
  }

  async softDelete(id: string): Promise<void> {
    const { error } = await this.db
      .from('journal_entries')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  }
}
