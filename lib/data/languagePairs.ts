import { createClient } from '@/lib/supabase/client'
import type { LanguagePair, UserId } from '@/domain'

function rowToPair(row: Record<string, unknown>): LanguagePair {
  return {
    id:             row.id as string,
    ownerId:        row.owner_id as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    position:       (row.position as number) ?? 0,
    createdAt:      row.created_at as string,
  }
}

export class SupabaseLanguagePairRepository {
  private get db() { return createClient() }

  /** All language pairings for the user, ordered for display. */
  async list(userId: UserId): Promise<LanguagePair[]> {
    const { data, error } = await this.db
      .from('language_pairs')
      .select('*')
      .eq('owner_id', userId)
      .order('position')
      .order('created_at')
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToPair)
  }

  /**
   * Create a new pairing ("+ New language"). If the pairing already exists
   * (e.g. it was backfilled from existing decks), returns the existing row
   * instead of erroring.
   */
  async create(userId: UserId, sourceLanguage: string, targetLanguage: string): Promise<LanguagePair> {
    const { data, error } = await this.db
      .from('language_pairs')
      .upsert(
        { owner_id: userId, source_language: sourceLanguage, target_language: targetLanguage },
        { onConflict: 'owner_id,source_language,target_language' },
      )
      .select().single()
    if (error) throw new Error(error.message)
    return rowToPair(data)
  }
}
