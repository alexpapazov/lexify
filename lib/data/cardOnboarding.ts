/**
 * lib/data/cardOnboarding.ts — the onboarding queue (migration 107).
 *
 * One row per card taken into a vocabulary-onboarding session. `band === null` = queued for rating;
 * a number = rated. The row is what makes a half-finished session resumable: a band-1 ("don't know")
 * card writes no card_states row, so without this it would be indistinguishable from one that was
 * never reached.
 *
 * ONLINE ONLY — onboarding needs the AI verification pass, and the rating screen is gated behind
 * `OfflineUnavailable`. There is no local-store path and nothing enqueues to the outbox.
 */

import { createClient } from '@/lib/supabase/client'
import { cachedRead, invalidateReads } from '@/lib/readCache'
import type { CardOnboarding, OnboardingBand, UserId, CardId, DeckId } from '@/domain'

function rowToOnboarding(row: Record<string, unknown>): CardOnboarding {
  return {
    userId:    row.user_id as string,
    cardId:    row.card_id as string,
    deckId:    row.deck_id as string,
    band:      row.band != null ? (Number(row.band) as OnboardingBand) : null,
    createdAt: row.created_at as string,
    ratedAt:   (row.rated_at as string | null) ?? null,
  }
}

export class SupabaseCardOnboardingRepository {
  private get db() { return createClient() }

  /**
   * Queues freshly created cards for rating. Ordered by the caller's `cardIds` order, which is the
   * deck's list order — the rating screen serves them in that order, matching how the ladder feeds
   * cards (see "Learning pipeline feeds cards in LIST ORDER" in CLAUDE.md).
   *
   * Chunked because an import can be thousands of rows.
   */
  async createPending(userId: UserId, deckId: DeckId, cardIds: CardId[]): Promise<void> {
    if (cardIds.length === 0) return
    invalidateReads('onboarding:')
    const CHUNK = 400
    for (let i = 0; i < cardIds.length; i += CHUNK) {
      const rows = cardIds.slice(i, i + CHUNK).map(cardId => ({
        user_id: userId, card_id: cardId, deck_id: deckId, band: null,
      }))
      const { error } = await this.db.from('card_onboarding')
        .upsert(rows, { onConflict: 'user_id,card_id' })
      if (error) throw new Error(error.message)
    }
  }

  /** Every onboarding row for a deck, rated or not, oldest first. */
  async listForDeck(userId: UserId, deckId: DeckId): Promise<CardOnboarding[]> {
    return cachedRead(`onboarding:deck:${userId}:${deckId}`, async () => {
      const { data, error } = await this.db.from('card_onboarding')
        .select('*').eq('user_id', userId).eq('deck_id', deckId).order('created_at').order('card_id')
      if (error) throw new Error(error.message)
      return (data ?? []).map(rowToOnboarding)
    })
  }

  /**
   * deckId → how many cards are still waiting to be rated. Drives the deck page's
   * "Finish onboarding (N left)" button. One query for the whole account.
   */
  async pendingCountsByDeck(userId: UserId): Promise<Map<string, number>> {
    return cachedRead(`onboarding:pending:${userId}`, async () => {
      const { data, error } = await this.db.from('card_onboarding')
        .select('deck_id').eq('user_id', userId).is('band', null)
      if (error) throw new Error(error.message)
      const out = new Map<string, number>()
      for (const row of data ?? []) {
        const id = row.deck_id as string
        out.set(id, (out.get(id) ?? 0) + 1)
      }
      return out
    })
  }

  /** Records a rating. Re-rating an already-rated card (undo, then a different button) just overwrites. */
  async rate(userId: UserId, cardId: CardId, band: OnboardingBand): Promise<void> {
    invalidateReads('onboarding:')
    const { error } = await this.db.from('card_onboarding')
      .update({ band, rated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('card_id', cardId)
    if (error) throw new Error(error.message)
  }

  /** Puts a card back in the queue — the undo path on the rating screen. */
  async unrate(userId: UserId, cardId: CardId): Promise<void> {
    invalidateReads('onboarding:')
    const { error } = await this.db.from('card_onboarding')
      .update({ band: null, rated_at: null })
      .eq('user_id', userId).eq('card_id', cardId)
    if (error) throw new Error(error.message)
  }
}
