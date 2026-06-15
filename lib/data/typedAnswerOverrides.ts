import { createClient } from '@/lib/supabase/client'
import type { TypedAnswerOverride, UserId, CardId, CardSide } from '@/domain'
import type { TypedAnswerOverrideRepository } from './interfaces'

function rowToOverride(row: Record<string, unknown>): TypedAnswerOverride {
  return {
    userId:     row.user_id as string,
    cardId:     row.card_id as string,
    answerSide: row.answer_side as CardSide,
    answerText: row.answer_text as string,
  }
}

export class SupabaseTypedAnswerOverrideRepository implements TypedAnswerOverrideRepository {
  private get db() { return createClient() }

  async listForUser(userId: UserId): Promise<TypedAnswerOverride[]> {
    const { data, error } = await this.db.from('typed_answer_overrides')
      .select('*')
      .eq('user_id', userId)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToOverride)
  }

  async add(userId: UserId, cardId: CardId, answerSide: CardSide, answerText: string): Promise<void> {
    const { error } = await this.db.from('typed_answer_overrides')
      .upsert(
        { user_id: userId, card_id: cardId, answer_side: answerSide, answer_text: answerText },
        { onConflict: 'user_id,card_id,answer_side,answer_text' },
      )
    if (error) throw new Error(error.message)
  }

  async remove(userId: UserId, cardId: CardId, answerSide: CardSide, answerText: string): Promise<void> {
    const { error } = await this.db.from('typed_answer_overrides')
      .delete()
      .eq('user_id', userId).eq('card_id', cardId).eq('answer_side', answerSide).eq('answer_text', answerText)
    if (error) throw new Error(error.message)
  }
}
