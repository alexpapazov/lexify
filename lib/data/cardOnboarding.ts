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
import { fetchAllRows } from '@/lib/supabasePaged'
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
   * Every onboarding row across several decks — the folder-level queue. Paged (a folder's queue can
   * exceed the 1000-row PostgREST cap) and chunked on the id list. Ordered per deck like listForDeck;
   * callers regroup by deck.
   */
  async listForDecks(userId: UserId, deckIds: DeckId[]): Promise<CardOnboarding[]> {
    if (deckIds.length === 0) return []
    return cachedRead(`onboarding:decks:${userId}:${[...deckIds].sort().join(',')}`, async () => {
      const out: CardOnboarding[] = []
      const CHUNK = 400
      for (let i = 0; i < deckIds.length; i += CHUNK) {
        const ids = deckIds.slice(i, i + CHUNK)
        const rows = await fetchAllRows<Record<string, unknown>>((from, to) =>
          this.db.from('card_onboarding')
            .select('*').eq('user_id', userId).in('deck_id', ids)
            .order('deck_id').order('created_at').order('card_id')
            .range(from, to))
        out.push(...rows.map(rowToOnboarding))
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

  /**
   * Drops a card from the queue entirely — used when it's deleted during rating.
   *
   * Needed as an explicit call because `cardRepo.softDelete` only sets `deleted_at`; the row still
   * exists, so the FK's ON DELETE CASCADE never fires and the deck would keep advertising
   * "Finish onboarding" for a card that no longer shows up.
   */
  async remove(userId: UserId, cardId: CardId): Promise<void> {
    invalidateReads('onboarding:')
    const { error } = await this.db.from('card_onboarding')
      .delete().eq('user_id', userId).eq('card_id', cardId)
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
