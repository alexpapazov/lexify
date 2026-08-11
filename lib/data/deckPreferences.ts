import { createClient } from '@/lib/supabase/client'
import { cachedRead, invalidateReads, idsKey } from '@/lib/readCache'
import type { DeckPreferences, UserId, DeckId } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'
import type { DeckPreferencesRepository } from './interfaces'
import { isOfflineActive } from '@/lib/offline/mode'
import { getLocalStore } from '@/lib/offline/localStore'

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
    capNewToGoal:         (row.cap_new_to_goal        as boolean | null) ?? false,
    audioSpeed:           (row.audio_speed            as number | null) ?? 1,
    audioVolume:          (row.audio_volume           as number | null) ?? 1,
  }
}

export class SupabaseDeckPreferencesRepository implements DeckPreferencesRepository {
  private get db() { return createClient() }

  async get(userId: UserId, deckId: DeckId): Promise<DeckPreferences | null> {
    if (isOfflineActive()) {
      // Served from the downloaded bundle. Returning null here (as this used to) made every deck read
      // "0 new/day" offline and quietly dropped batch size / spillover / audio settings.
      const row = await getLocalStore().getDeckPreferences(deckId).catch(() => undefined)
      return row ? rowToPrefs(row as Record<string, unknown>) : null
    }
    return cachedRead(`prefs:one:${userId}:${deckId}`, async () => {
      const { data, error } = await this.db
        .from('user_deck_preferences')
        .select('*')
        .eq('user_id', userId)
        .eq('deck_id', deckId)
        .single()
      if (error) return null
      return rowToPrefs(data)
    })
  }

  /** Preferences for many decks in one query (vs. `get` once per deck in the session pages).
   *  Decks with no row are simply absent from the map. Offline loops the local store (no network). */
  async listForDecks(userId: UserId, deckIds: DeckId[]): Promise<Map<string, DeckPreferences>> {
    const out = new Map<string, DeckPreferences>()
    if (deckIds.length === 0) return out
    if (isOfflineActive()) {
      for (const id of deckIds) {
        const row = await getLocalStore().getDeckPreferences(id).catch(() => undefined)
        if (row) out.set(id, rowToPrefs(row as Record<string, unknown>))
      }
      return out
    }
    return cachedRead(`prefs:list:${userId}:${idsKey(deckIds)}`, async () => {
      const CHUNK = 200
      const chunks: DeckId[][] = []
      for (let i = 0; i < deckIds.length; i += CHUNK) chunks.push(deckIds.slice(i, i + CHUNK))
      const results = await Promise.all(chunks.map(chunk => this.db
        .from('user_deck_preferences').select('*').eq('user_id', userId).in('deck_id', chunk)))
      for (const { data, error } of results) {
        if (error) continue
        for (const row of data ?? []) out.set((row as { deck_id: string }).deck_id, rowToPrefs(row))
      }
      return out
    })
  }

  async upsert(prefs: DeckPreferences): Promise<DeckPreferences> {
    invalidateReads('prefs:')
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
        cap_new_to_goal:        prefs.capNewToGoal,
        audio_speed:            prefs.audioSpeed,
        audio_volume:           prefs.audioVolume,
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

}
