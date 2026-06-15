import { createClient } from '@/lib/supabase/client'
import type { ReviewEvent, UserId, CardId, Rating } from '@/domain'
import type { ReviewEventRepository, CreateReviewEventInput } from './interfaces'

function rowToEvent(row: Record<string, unknown>): ReviewEvent {
  return {
    id:          row.id as string,
    userId:      row.user_id as string,
    cardId:      row.card_id as string,
    mode:        row.mode as ReviewEvent['mode'],
    promptSide:  row.prompt_side as ReviewEvent['promptSide'],
    answerSide:  row.answer_side as ReviewEvent['answerSide'],
    promptShown: row.prompt_shown as string,
    expected:    row.expected as string,
    userAnswer:  row.user_answer as string,
    wasCorrect:  row.was_correct as boolean,
    rating:      row.rating as Rating | null,
    responseMs:  row.response_ms as number | null,
    reviewedAt:  row.reviewed_at as string,
    reviewMode:  (row.review_mode as ReviewEvent['reviewMode']) ?? null,
    wasTyped:    (row.was_typed as boolean | null) ?? null,
  }
}

export class SupabaseReviewEventRepository implements ReviewEventRepository {
  private get db() { return createClient() }

  async create(input: CreateReviewEventInput): Promise<ReviewEvent> {
    const { data, error } = await this.db.from('review_events').insert({
      user_id: input.userId, card_id: input.cardId, mode: input.mode,
      prompt_side: input.promptSide, answer_side: input.answerSide,
      prompt_shown: input.promptShown, expected: input.expected,
      user_answer: input.userAnswer, was_correct: input.wasCorrect,
      rating: input.rating, response_ms: input.responseMs,
      review_mode: input.reviewMode, was_typed: input.wasTyped,
    }).select().single()
    if (error) throw new Error(error.message)
    return rowToEvent(data)
  }

  async countByCard(userId: UserId, cardId: CardId): Promise<number> {
    const { count, error } = await this.db.from('review_events')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId).eq('card_id', cardId)
    if (error) throw new Error(error.message)
    return count ?? 0
  }
}
