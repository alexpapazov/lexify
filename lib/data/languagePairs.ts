import { createClient } from '@/lib/supabase/client'
import type { LanguagePair, UserId } from '@/domain'

function rowToPair(row: Record<string, unknown>): LanguagePair {
  return {
    id:             row.id as string,
    ownerId:        row.owner_id as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    position:       (row.position as number) ?? 0,
    flag:           (row.flag as string | null) ?? null,
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
  async create(userId: UserId, sourceLanguage: string, targetLanguage: string, flag?: string): Promise<LanguagePair> {
    const { data, error } = await this.db
      .from('language_pairs')
      .upsert(
        { owner_id: userId, source_language: sourceLanguage, target_language: targetLanguage, ...(flag ? { flag } : {}) },
        { onConflict: 'owner_id,source_language,target_language' },
      )
      .select().single()
    if (error) throw new Error(error.message)
    return rowToPair(data)
  }

  /** Update the flag emoji for an existing pairing. */
  async updateFlag(sourceLanguage: string, targetLanguage: string, flag: string): Promise<void> {
    const { error } = await this.db.from('language_pairs').update({ flag })
      .match({ source_language: sourceLanguage, target_language: targetLanguage })
    if (error) throw new Error(error.message)
  }

  /** Bulk-update positions for reordering the library grid. */
  async updatePositions(updates: Array<{ sourceLanguage: string; targetLanguage: string; position: number }>): Promise<void> {
    await Promise.all(
      updates.map(({ sourceLanguage, targetLanguage, position }) =>
        this.db.from('language_pairs').update({ position })
          .match({ source_language: sourceLanguage, target_language: targetLanguage })
      )
    )
  }

  /**
   * Permanently delete a language pairing: hard-deletes all cards in this
   * direction (cascading to deck_cards/card_states/review_events/duplicate
   * pairs), soft-deletes its decks, and removes the language_pairs row.
   */
  async deletePair(sourceLanguage: string, targetLanguage: string): Promise<void> {
    const { error } = await this.db.rpc('delete_language_pair', {
      p_source: sourceLanguage,
      p_target: targetLanguage,
    })
    if (error) throw new Error(error.message)
  }
}
