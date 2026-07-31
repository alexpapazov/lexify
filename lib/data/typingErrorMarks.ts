import { createClient } from '@/lib/supabase/client'
import type { UserId, CardId, CardSide, TypedErrorCategory } from '@/domain'

interface TypingErrorMark {
  userId:         UserId
  cardId:         CardId
  answerSide:     CardSide
  category:       TypedErrorCategory
  count:          number
  lastExpected:   string
  lastUserAnswer: string
  updatedAt:      string
}

function rowToMark(row: Record<string, unknown>): TypingErrorMark {
  return {
    userId:         row.user_id as string,
    cardId:         row.card_id as string,
    answerSide:     row.answer_side as CardSide,
    category:       row.category as TypedErrorCategory,
    count:          row.count as number,
    lastExpected:   (row.last_expected as string | null) ?? '',
    lastUserAnswer: (row.last_user_answer as string | null) ?? '',
    updatedAt:      row.updated_at as string,
  }
}

/**
 * Records accent / article / spelling slips per card + side, for future
 * "spelling practice" and "gender/article assign" modes. There is no `lib/data`
 * barrel — import this repo directly (same convention as cardConfusions).
 */
export class SupabaseTypingErrorMarkRepository {
  private get db() { return createClient() }

  async record(
    cardId:     CardId,
    answerSide: CardSide,
    category:   TypedErrorCategory,
    expected:   string,
    userAnswer: string,
  ): Promise<void> {
    const { error } = await this.db.rpc('record_typing_error_mark', {
      p_card_id:     cardId,
      p_answer_side: answerSide,
      p_category:    category,
      p_expected:    expected,
      p_user_answer: userAnswer,
    })
    if (error) throw new Error(error.message)
  }

  async listForUser(userId: UserId, category?: TypedErrorCategory): Promise<TypingErrorMark[]> {
    let q = this.db.from('typing_error_marks').select('*').eq('user_id', userId)
    if (category) q = q.eq('category', category)
    const { data, error } = await q.order('count', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToMark)
  }

  async listForCard(userId: UserId, cardId: CardId): Promise<TypingErrorMark[]> {
    const { data, error } = await this.db.from('typing_error_marks')
      .select('*')
      .eq('user_id', userId)
      .eq('card_id', cardId)
      .order('count', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToMark)
  }
}
