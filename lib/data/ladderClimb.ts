import { createClient } from '@/lib/supabase/client'
import type { UserId, CardId, DeckId } from '@/domain'
import type { ClimbState } from '@/engine/ladderEngine'

export class SupabaseLadderClimbRepository {
  private get db() { return createClient() }

  /** Every climb row for the given cards (keyed by cardId). */
  async listForCards(userId: UserId, cardIds: CardId[]): Promise<Map<string, ClimbState>> {
    if (cardIds.length === 0) return new Map()
    const { data, error } = await this.db.from('ladder_climb')
      .select('card_id, state').eq('user_id', userId).in('card_id', cardIds)
    if (error) throw new Error(error.message)
    return new Map((data ?? []).map(r => [r.card_id as string, r.state as ClimbState]))
  }

  async save(userId: UserId, cardId: CardId, deckId: DeckId, state: ClimbState): Promise<void> {
    const { error } = await this.db.from('ladder_climb').upsert(
      { user_id: userId, card_id: cardId, deck_id: deckId, state, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,card_id' },
    )
    if (error) throw new Error(error.message)
  }

  /** Removes a card's climb row so it restarts from the CURRENT ladder config next time. */
  async remove(userId: UserId, cardId: CardId): Promise<void> {
    const { error } = await this.db.from('ladder_climb')
      .delete().eq('user_id', userId).eq('card_id', cardId)
    if (error) throw new Error(error.message)
  }
}
