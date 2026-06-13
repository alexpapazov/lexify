import { createClient } from '@/lib/supabase/client'
import type { CardState, UserId, DeckId, CardId, Rating } from '@/domain'
import type { CardStateRepository } from './interfaces'

function rowToCardState(row: Record<string, unknown>): CardState {
  return {
    userId:           row.user_id as string,
    cardId:           row.card_id as string,
    pipelineId:       row.pipeline_id as string,
    currentStepOrder: row.current_step_order as number,
    correctInStep:    row.correct_in_step as number,
    graduated:        row.graduated as boolean,
    dueAt:            row.due_at as string | null,
    intervalDays:     Number(row.interval_days),
    ease:             Number(row.ease),
    reps:             row.reps as number,
    lapses:           row.lapses as number,
    lastRating:       row.last_rating as Rating | null,
    lastReviewedAt:   row.last_reviewed_at as string | null,
    introducedDate:   row.introduced_date as string | null,
  }
}

export class SupabaseCardStateRepository implements CardStateRepository {
  private get db() { return createClient() }

  async get(userId: UserId, cardId: CardId): Promise<CardState | null> {
    const { data, error } = await this.db.from('card_states').select('*')
      .eq('user_id', userId).eq('card_id', cardId).single()
    if (error) return null
    return rowToCardState(data)
  }

  async listByDeck(userId: UserId, deckId: DeckId): Promise<CardState[]> {
    // cards are no longer deck-owned — join through deck_cards to find
    // which cards belong to this deck, then fetch this user's states for them.
    const { data: links, error: linkError } = await this.db.from('deck_cards')
      .select('card_id').eq('deck_id', deckId)
    if (linkError) throw new Error(linkError.message)

    const cardIds = (links ?? []).map(l => l.card_id as string)
    if (cardIds.length === 0) return []

    const { data, error } = await this.db.from('card_states')
      .select('*')
      .eq('user_id', userId).in('card_id', cardIds)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToCardState)
  }

  async upsert(state: CardState): Promise<CardState> {
    const { data, error } = await this.db.from('card_states').upsert({
      user_id: state.userId, card_id: state.cardId, pipeline_id: state.pipelineId,
      current_step_order: state.currentStepOrder, correct_in_step: state.correctInStep,
      graduated: state.graduated, due_at: state.dueAt, interval_days: state.intervalDays,
      ease: state.ease, reps: state.reps, lapses: state.lapses,
      last_rating: state.lastRating, last_reviewed_at: state.lastReviewedAt,
      introduced_date: state.introducedDate,
    }, { onConflict: 'user_id,card_id' }).select().single()
    if (error) throw new Error(error.message)
    return rowToCardState(data)
  }
}
