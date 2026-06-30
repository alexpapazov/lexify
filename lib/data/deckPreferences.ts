import { createClient } from '@/lib/supabase/client'
import type { DeckPreferences, UserId, DeckId } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'
import type { DeckPreferencesRepository } from './interfaces'

function rowToPrefs(row: Record<string, unknown>): DeckPreferences {
  return {
    userId:            row.user_id as string,
    deckId:            row.deck_id as string,
    dailyNewCards:     row.daily_new_cards as number,
    dailyOverride:     row.daily_override as number | null,
    dailyOverrideDate: row.daily_override_date as string | null,
    spilloverDue:      (row.spillover_due as boolean) ?? false,
    cardsPerSession:      (row.cards_per_session      as number | null) ?? null,
    electiveSessionLimit: (row.elective_session_limit as number | null) ?? null,
    learningBatchMode:    (row.learning_batch_mode    as boolean | null) ?? false,
  }
}

export class SupabaseDeckPreferencesRepository implements DeckPreferencesRepository {
  private get db() { return createClient() }

  async get(userId: UserId, deckId: DeckId): Promise<DeckPreferences | null> {
    const { data, error } = await this.db
      .from('user_deck_preferences')
      .select('*')
      .eq('user_id', userId)
      .eq('deck_id', deckId)
      .single()
    if (error) return null
    return rowToPrefs(data)
  }

  async upsert(prefs: DeckPreferences): Promise<DeckPreferences> {
    const { data, error } = await this.db
      .from('user_deck_preferences')
      .upsert({
        user_id:             prefs.userId,
        deck_id:             prefs.deckId,
        daily_new_cards:     prefs.dailyNewCards,
        daily_override:      prefs.dailyOverride,
        daily_override_date: prefs.dailyOverrideDate,
        spillover_due:       prefs.spilloverDue,
        cards_per_session:      prefs.cardsPerSession,
        elective_session_limit: prefs.electiveSessionLimit,
        learning_batch_mode:    prefs.learningBatchMode,
      }, { onConflict: 'user_id,deck_id' })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return rowToPrefs(data)
  }

  effectiveDailyLimit(prefs: DeckPreferences): number {
    const today = new Date().toISOString().slice(0, 10)
    if (prefs.dailyOverride !== null && prefs.dailyOverrideDate === today) {
      return prefs.dailyOverride
    }
    return prefs.dailyNewCards
  }

  /**
   * Resets the spillover backlog for a deck by setting introduced_date = today
   * on all in-pipeline (non-graduated) cards for this user+deck.
   * Effect: the budget calc treats them as introduced today, clearing the backlog.
   */
  async resetDeckBacklog(userId: UserId, deckId: DeckId): Promise<void> {
    const today = new Date().toISOString().slice(0, 10)
    // Get all card IDs in this deck
    const { data: cards } = await this.db
      .from('cards')
      .select('id')
      .eq('deck_id', deckId)
      .is('deleted_at', null)

    if (!cards || cards.length === 0) return

    const cardIds = cards.map(c => c.id as string)

    await this.db
      .from('card_states')
      .update({ introduced_date: today })
      .eq('user_id', userId)
      .eq('graduated', false)
      .in('card_id', cardIds)
  }

  /**
   * Resets the backlog across ALL decks for this user.
   */
  async resetAllBacklogs(userId: UserId): Promise<void> {
    const today = new Date().toISOString().slice(0, 10)
    await this.db
      .from('card_states')
      .update({ introduced_date: today })
      .eq('user_id', userId)
      .eq('graduated', false)
  }
}
