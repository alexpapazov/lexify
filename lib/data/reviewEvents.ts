import { createClient } from '@/lib/supabase/client'
import type { ReviewEvent, UserId, CardId, Rating } from '@/domain'
import type { ReviewEventRepository, CreateReviewEventInput } from './interfaces'
import { isOfflineActive } from '@/lib/offline/mode'
import { localCreateReviewEvent, localDeleteReviewEvent } from '@/lib/offline/localRepos'

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
    reviewMode:        (row.review_mode as ReviewEvent['reviewMode']) ?? null,
    wasTyped:          (row.was_typed as boolean | null) ?? null,
    wasAccelerated:    (row.was_accelerated as boolean | null) ?? null,
    acceleratedPenalty:(row.accelerated_penalty as number | null) ?? null,
    reviewDirection:   (row.review_direction as 'forward' | 'reverse' | null) ?? null,
    reps:              Number(row.reps ?? 0),
    lapsed:            (row.lapsed as boolean | null) ?? false,
    hintLevel:         Number(row.hint_level ?? 0),
    nearMiss:          (row.near_miss as boolean | null) ?? false,
    nearMissWeight:    Number(row.near_miss_weight ?? (row.near_miss ? 0.2 : 0)),
    errorCategory:     (row.error_category as ReviewEvent['errorCategory']) ?? null,
    graduationErrorCount: Number(row.graduation_error_count ?? 0),
  }
}

export class SupabaseReviewEventRepository implements ReviewEventRepository {
  private get db() { return createClient() }

  async create(input: CreateReviewEventInput): Promise<ReviewEvent> {
    if (isOfflineActive()) {
      const id = await localCreateReviewEvent(input)
      // Return a best-effort local ReviewEvent (only `id` is used by callers — for undo).
      return {
        id, userId: input.userId, cardId: input.cardId, mode: input.mode,
        promptSide: input.promptSide, answerSide: input.answerSide, promptShown: input.promptShown,
        expected: input.expected, userAnswer: input.userAnswer, wasCorrect: input.wasCorrect,
        rating: input.rating, responseMs: input.responseMs ?? null, reviewedAt: '',
        reviewMode: input.reviewMode ?? null, wasTyped: input.wasTyped ?? null,
        wasAccelerated: input.wasAccelerated ?? null, acceleratedPenalty: input.acceleratedPenalty ?? null,
        reviewDirection: input.reviewDirection ?? null, reps: input.reps ?? 0, lapsed: false,
        hintLevel: input.hintLevel ?? 0, nearMiss: input.nearMiss ?? false,
        nearMissWeight: input.nearMissWeight ?? (input.nearMiss ? 0.2 : 0),
        errorCategory: input.errorCategory ?? null, graduationErrorCount: input.graduationErrorCount ?? 0,
      }
    }
    const { data, error } = await this.db.from('review_events').insert({
      user_id: input.userId, card_id: input.cardId, mode: input.mode,
      prompt_side: input.promptSide, answer_side: input.answerSide,
      prompt_shown: input.promptShown, expected: input.expected,
      user_answer: input.userAnswer, was_correct: input.wasCorrect,
      rating: input.rating, response_ms: input.responseMs,
      review_mode: input.reviewMode, was_typed: input.wasTyped,
      was_accelerated:     input.wasAccelerated,
      accelerated_penalty: input.acceleratedPenalty,
      review_direction:    input.reviewDirection,
      reps:                input.reps ?? 0,
      hint_level:          input.hintLevel ?? 0,
      near_miss:           input.nearMiss ?? false,
      near_miss_weight:    input.nearMissWeight ?? (input.nearMiss ? 0.2 : 0),
      error_category:      input.errorCategory ?? null,
      graduation_error_count: input.graduationErrorCount ?? 0,
      source_language:     input.sourceLanguage ?? null,
      target_language:     input.targetLanguage ?? null,
    }).select().single()
    if (error) throw new Error(error.message)
    return rowToEvent(data)
  }

  /** Remove a logged event — used to roll back a review on undo (so undo+redo counts once). */
  async delete(id: string): Promise<void> {
    if (isOfflineActive()) return localDeleteReviewEvent(id)
    const { error } = await this.db.from('review_events').delete().eq('id', id)
    if (error) throw new Error(error.message)
  }

  async listForCard(userId: UserId, cardId: CardId, limit = 200): Promise<ReviewEvent[]> {
    const { data, error } = await this.db
      .from('review_events')
      .select('*')
      .eq('user_id', userId)
      .eq('card_id', cardId)
      .order('reviewed_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToEvent)
  }

  async countByCard(userId: UserId, cardId: CardId): Promise<number> {
    const { count, error } = await this.db.from('review_events')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId).eq('card_id', cardId)
    if (error) throw new Error(error.message)
    return count ?? 0
  }

  async markLapsed(id: string, userId: UserId): Promise<void> {
    const { error } = await this.db.from('review_events')
      .update({ lapsed: true })
      .eq('id', id).eq('user_id', userId)
    if (error) throw new Error(error.message)
  }
}
