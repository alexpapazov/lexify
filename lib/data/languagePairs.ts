import { createClient } from '@/lib/supabase/client'
import type { LanguagePair, UserId } from '@/domain'
import { isOfflineActive } from '@/lib/offline/mode'
import { localLanguagePairs } from '@/lib/offline/localRepos'

function rowToPair(row: Record<string, unknown>): LanguagePair {
  return {
    id:             row.id as string,
    ownerId:        row.owner_id as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    position:       (row.position as number) ?? 0,
    flag:           (row.flag as string | null) ?? null,
    instructions:   (row.instructions as string | null) ?? null,
    createdAt:      row.created_at as string,
    goals:          (row.goals as Record<string, number | null> | null) ?? null,
    learningMode:   (row.learning_mode as 'ladder' | 'pathway' | null) ?? 'ladder',
  }
}

export class SupabaseLanguagePairRepository {
  private get db() { return createClient() }

  /** All language pairings for the user, ordered for display. */
  async list(userId: UserId): Promise<LanguagePair[]> {
    if (isOfflineActive()) return localLanguagePairs(userId)
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
    // Return the existing pair unchanged if it's already there (never reset its learning mode on re-add).
    const { data: existing } = await this.db.from('language_pairs').select('*')
      .match({ owner_id: userId, source_language: sourceLanguage, target_language: targetLanguage }).maybeSingle()
    if (existing) return rowToPair(existing)
    // New pair: inherit the user's default learning mode (ladder vs pathway).
    const { data: prof } = await this.db.from('profiles').select('default_learning_mode').eq('user_id', userId).maybeSingle()
    const learning_mode = (prof?.default_learning_mode as string | null) ?? 'ladder'
    const { data, error } = await this.db.from('language_pairs')
      .insert({ owner_id: userId, source_language: sourceLanguage, target_language: targetLanguage, learning_mode, ...(flag ? { flag } : {}) })
      .select().single()
    if (error) {
      // Lost a create race → the row now exists; return it.
      const { data: raced } = await this.db.from('language_pairs').select('*')
        .match({ owner_id: userId, source_language: sourceLanguage, target_language: targetLanguage }).maybeSingle()
      if (raced) return rowToPair(raced)
      throw new Error(error.message)
    }
    return rowToPair(data)
  }

  /** Update the flag emoji for an existing pairing. */
  async updateFlag(sourceLanguage: string, targetLanguage: string, flag: string): Promise<void> {
    const { error } = await this.db.from('language_pairs').update({ flag })
      .match({ source_language: sourceLanguage, target_language: targetLanguage })
    if (error) throw new Error(error.message)
  }

  /** Update weekly goals for an existing pairing (null clears all goals). */
  async updateGoals(sourceLanguage: string, targetLanguage: string, goals: Record<string, number | null> | null): Promise<void> {
    const { error } = await this.db.from('language_pairs').update({ goals })
      .match({ source_language: sourceLanguage, target_language: targetLanguage })
    if (error) throw new Error(error.message)
  }

  /** Switch a pairing between the linear ladder and a branched pathway. */
  async updateLearningMode(sourceLanguage: string, targetLanguage: string, mode: 'ladder' | 'pathway'): Promise<void> {
    const { error } = await this.db.from('language_pairs').update({ learning_mode: mode })
      .match({ source_language: sourceLanguage, target_language: targetLanguage })
    if (error) throw new Error(error.message)
  }

  /** Update the AI instructions for an existing pairing (null clears them). */
  async updateInstructions(sourceLanguage: string, targetLanguage: string, instructions: string | null): Promise<void> {
    const { error } = await this.db.from('language_pairs').update({ instructions })
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
