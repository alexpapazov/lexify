import { createClient } from '@/lib/supabase/client'
import type { DismissedPair, UserId, CardId } from '@/domain'
import type { DismissedPairRepository } from './interfaces'

function rowToPair(row: Record<string, unknown>): DismissedPair {
  return {
    id:        row.id as string,
    userId:    row.user_id as string,
    cardAId:   row.card_a_id as string,
    cardBId:   row.card_b_id as string,
    createdAt: row.created_at as string,
  }
}

export class SupabaseDismissedPairRepository implements DismissedPairRepository {
  private get db() { return createClient() }

  async isDismissed(userId: UserId, cardAId: CardId, cardBId: CardId): Promise<boolean> {
    const { data, error } = await this.db.from('dismissed_duplicate_pairs')
      .select('id')
      .eq('user_id', userId)
      .or(
        `and(card_a_id.eq.${cardAId},card_b_id.eq.${cardBId}),and(card_a_id.eq.${cardBId},card_b_id.eq.${cardAId})`
      )
      .limit(1)
    if (error) throw new Error(error.message)
    return (data ?? []).length > 0
  }

  async create(userId: UserId, cardAId: CardId, cardBId: CardId): Promise<DismissedPair> {
    const { data, error } = await this.db.from('dismissed_duplicate_pairs')
      .insert({ user_id: userId, card_a_id: cardAId, card_b_id: cardBId })
      .select().single()
    if (error) throw new Error(error.message)
    return rowToPair(data)
  }
}
