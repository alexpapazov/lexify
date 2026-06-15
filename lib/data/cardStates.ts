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
    scheduledIntervalDays: Number(row.scheduled_interval_days ?? 0),
    ease:             Number(row.ease),
    reps:             row.reps as number,
    lapses:           row.lapses as number,
    lastRating:       row.last_rating as Rating | null,
    lastReviewedAt:   row.last_reviewed_at as string | null,
    introducedDate:   row.introduced_date as string | null,
    lapseClusterCount: Number(row.lapse_cluster_count ?? 0),
    lastLapseAt:       row.last_lapse_at as string | null,
    graduatedAt:       row.graduated_at as string | null,
    relearningStep:    Number(row.relearning_step ?? 0),
    pendingIntervalDays: row.pending_interval_days != null ? Number(row.pending_interval_days) : null,
    typedAccuracyWindow: Array.isArray(row.typed_accuracy_window) ? (row.typed_accuracy_window as number[]) : [],
    typedReviewCount:    Number(row.typed_review_count ?? 0),
    lastTypedReviewAt:   row.last_typed_review_at as string | null,
    forcedTypedRemaining: Number(row.forced_typed_remaining ?? 0),
    intervalHistory:     Array.isArray(row.interval_history) ? (row.interval_history as number[]) : [],
    typingMistakeStreak: Number(row.typing_mistake_streak ?? 0),
    typingFailCycles:    Number(row.typing_fail_cycles ?? 0),
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
      scheduled_interval_days: state.scheduledIntervalDays,
      ease: state.ease, reps: state.reps, lapses: state.lapses,
      last_rating: state.lastRating, last_reviewed_at: state.lastReviewedAt,
      introduced_date: state.introducedDate,
      lapse_cluster_count: state.lapseClusterCount, last_lapse_at: state.lastLapseAt,
      graduated_at: state.graduatedAt,
      relearning_step: state.relearningStep, pending_interval_days: state.pendingIntervalDays,
      typed_accuracy_window: state.typedAccuracyWindow, typed_review_count: state.typedReviewCount,
      last_typed_review_at: state.lastTypedReviewAt, forced_typed_remaining: state.forcedTypedRemaining,
      interval_history: state.intervalHistory,
      typing_mistake_streak: state.typingMistakeStreak, typing_fail_cycles: state.typingFailCycles,
    }, { onConflict: 'user_id,card_id' }).select().single()
    if (error) throw new Error(error.message)
    return rowToCardState(data)
  }

  async copy(userId: UserId, fromCardId: CardId, toCardId: CardId): Promise<CardState | null> {
    const existing = await this.get(userId, fromCardId)
    if (!existing) return null
    return this.upsert({ ...existing, cardId: toCardId })
  }

  async countDueByDateRange(userId: UserId, startIso: string, endIso: string): Promise<Map<string, number>> {
    const { data, error } = await this.db.from('card_states')
      .select('due_at')
      .eq('user_id', userId)
      .eq('graduated', true)
      .gte('due_at', startIso)
      .lt('due_at', endIso)
    if (error) throw new Error(error.message)

    const counts = new Map<string, number>()
    for (const row of data ?? []) {
      const dueAt = row.due_at as string | null
      if (!dueAt) continue
      const day = dueAt.slice(0, 10)
      counts.set(day, (counts.get(day) ?? 0) + 1)
    }
    return counts
  }
}
