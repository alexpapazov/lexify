import { createClient } from '@/lib/supabase/client'
import type { CardConfusion, UserId, CardId, CardSide } from '@/domain'
import type { CardConfusionRepository } from './interfaces'

function rowToConfusion(row: Record<string, unknown>): CardConfusion {
  return {
    userId:             row.user_id as string,
    cardId:             row.card_id as string,
    confusedWithCardId: (row.confused_with_card_id as string | null) ?? null,
    confusedText:       row.confused_text as string,
    answerSide:         row.answer_side as CardSide,
    isWordMixup:        row.is_word_mixup as boolean,
    count:              row.count as number,
    lastConfusedAt:     row.last_confused_at as string,
  }
}

export class SupabaseCardConfusionRepository implements CardConfusionRepository {
  private get db() { return createClient() }

  async record(cardId: CardId, confusedText: string, answerSide: CardSide, isWordMixup: boolean, confusedWithCardId?: CardId | null): Promise<void> {
    const { error } = await this.db.rpc('record_card_confusion', {
      p_card_id: cardId,
      p_confused_text: confusedText,
      p_answer_side: answerSide,
      p_is_word_mixup: isWordMixup,
      p_confused_with_card_id: confusedWithCardId ?? null,
    })
    if (error) throw new Error(error.message)
  }

  async listForCard(userId: UserId, cardId: CardId): Promise<CardConfusion[]> {
    const { data, error } = await this.db.from('card_confusions')
      .select('*')
      .eq('user_id', userId)
      .eq('card_id', cardId)
      .order('count', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToConfusion)
  }

  async listForUser(userId: UserId): Promise<CardConfusion[]> {
    const { data, error } = await this.db.from('card_confusions')
      .select('*')
      .eq('user_id', userId)
      .order('count', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToConfusion)
  }
}
