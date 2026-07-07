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
    stage3EnteredDate:   (row.stage3_entered_date as string | null) ?? null,
    iDontKnowCount:      Number(row.i_dont_know_count ?? 0),
    pipelineErrorCount:   Number(row.pipeline_error_count ?? 0),
    graduationErrorCount: Number(row.graduation_error_count ?? 0),
    accentMistakeCount:   Number(row.accent_mistake_count   ?? 0),
    articleMistakeCount:  Number(row.article_mistake_count  ?? 0),
    genderMistakeCount:   Number(row.gender_mistake_count   ?? 0),
    typoMistakeCount:     Number(row.typo_mistake_count     ?? 0),
    semanticMistakeCount: Number(row.semantic_mistake_count ?? 0),
    wrongSynonymCount:    Number(row.wrong_synonym_count    ?? 0),
    dormant:              Boolean(row.dormant ?? false),
    dormancyThreshold:    (row.dormancy_threshold as number | null) ?? null,
    acceleratedMode:        (row.accelerated_mode as string) === 'import_known' ? 'import_known' : 'none',
    acceleratedLocked:      Boolean(row.accelerated_locked ?? false),
    acceleratedWrongStreak: Number(row.accelerated_wrong_streak ?? 0),
    acceleratedPenalty:     Number(row.accelerated_penalty      ?? 0),
    postAccelRestartWindow: Number(row.post_accel_restart_window ?? 0),
    postAccelWrongCount:    Number(row.post_accel_wrong_count    ?? 0),
    typedIntervalDays:   row.typed_interval_days  != null ? Number(row.typed_interval_days)  : null,
    typedDueAt:          (row.typed_due_at         as string | null) ?? null,
    recallIntervalDays:  row.recall_interval_days != null ? Number(row.recall_interval_days) : null,
    recallDueAt:         (row.recall_due_at        as string | null) ?? null,
    reviewDirection:     ((row.review_direction as string) === 'reverse' ? 'reverse' : 'forward') as 'forward' | 'reverse',
  }
}

export class SupabaseCardStateRepository implements CardStateRepository {
  private get db() { return createClient() }

  async get(userId: UserId, cardId: CardId, reviewDirection: 'forward' | 'reverse' = 'forward'): Promise<CardState | null> {
    const { data, error } = await this.db.from('card_states').select('*')
      .eq('user_id', userId).eq('card_id', cardId).eq('review_direction', reviewDirection).maybeSingle()
    if (error) return null
    return data ? rowToCardState(data) : null
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
      stage3_entered_date: state.stage3EnteredDate,
      i_dont_know_count: state.iDontKnowCount,
      pipeline_error_count:   state.pipelineErrorCount,
      graduation_error_count: state.graduationErrorCount,
      accent_mistake_count:     state.accentMistakeCount,
      article_mistake_count:    state.articleMistakeCount,
      gender_mistake_count:     state.genderMistakeCount,
      typo_mistake_count:       state.typoMistakeCount,
      semantic_mistake_count:   state.semanticMistakeCount,
      wrong_synonym_count:      state.wrongSynonymCount,
      dormant:                  state.dormant,
      dormancy_threshold:       state.dormancyThreshold,
      accelerated_mode:         state.acceleratedMode,
      accelerated_locked:       state.acceleratedLocked,
      accelerated_wrong_streak: state.acceleratedWrongStreak,
      accelerated_penalty:      state.acceleratedPenalty,
      post_accel_restart_window: state.postAccelRestartWindow,
      post_accel_wrong_count:    state.postAccelWrongCount,
      typed_interval_days:      state.typedIntervalDays,
      typed_due_at:             state.typedDueAt,
      recall_interval_days:     state.recallIntervalDays,
      recall_due_at:            state.recallDueAt,
      review_direction:         state.reviewDirection,
    }, { onConflict: 'user_id,card_id,review_direction' }).select().single()
    if (error) throw new Error(error.message)
    return rowToCardState(data)
  }

  /** Targeted dormancy update on the forward row (avoids a full-row upsert). */
  async setDormancy(
    userId: UserId,
    cardId: CardId,
    patch: { dormant?: boolean; dormancyThreshold?: number | null },
  ): Promise<CardState> {
    const dbPatch: Record<string, unknown> = {}
    if ('dormant' in patch)           dbPatch.dormant = patch.dormant
    if ('dormancyThreshold' in patch) dbPatch.dormancy_threshold = patch.dormancyThreshold
    const { data, error } = await this.db.from('card_states')
      .update(dbPatch)
      .eq('user_id', userId).eq('card_id', cardId).eq('review_direction', 'forward')
      .select().single()
    if (error) throw new Error(error.message)
    return rowToCardState(data)
  }

  async upsertBatch(states: CardState[]): Promise<void> {
    if (states.length === 0) return
    const rows = states.map(s => ({
      user_id: s.userId, card_id: s.cardId, pipeline_id: s.pipelineId,
      current_step_order: s.currentStepOrder, correct_in_step: s.correctInStep,
      graduated: s.graduated, due_at: s.dueAt, interval_days: s.intervalDays,
      scheduled_interval_days: s.scheduledIntervalDays,
      ease: s.ease, reps: s.reps, lapses: s.lapses,
      last_rating: s.lastRating, last_reviewed_at: s.lastReviewedAt,
      introduced_date: s.introducedDate,
      lapse_cluster_count: s.lapseClusterCount, last_lapse_at: s.lastLapseAt,
      graduated_at: s.graduatedAt,
      relearning_step: s.relearningStep, pending_interval_days: s.pendingIntervalDays,
      typed_accuracy_window: s.typedAccuracyWindow, typed_review_count: s.typedReviewCount,
      last_typed_review_at: s.lastTypedReviewAt, forced_typed_remaining: s.forcedTypedRemaining,
      interval_history: s.intervalHistory,
      typing_mistake_streak: s.typingMistakeStreak, typing_fail_cycles: s.typingFailCycles,
      stage3_entered_date: s.stage3EnteredDate,
      i_dont_know_count: s.iDontKnowCount,
      pipeline_error_count:   s.pipelineErrorCount,
      graduation_error_count: s.graduationErrorCount,
      accent_mistake_count: s.accentMistakeCount, article_mistake_count: s.articleMistakeCount,
      gender_mistake_count: s.genderMistakeCount, typo_mistake_count: s.typoMistakeCount,
      semantic_mistake_count: s.semanticMistakeCount, wrong_synonym_count: s.wrongSynonymCount,
      dormant: s.dormant, dormancy_threshold: s.dormancyThreshold,
      accelerated_mode: s.acceleratedMode, accelerated_locked: s.acceleratedLocked,
      accelerated_wrong_streak: s.acceleratedWrongStreak, accelerated_penalty: s.acceleratedPenalty,
      post_accel_restart_window: s.postAccelRestartWindow, post_accel_wrong_count: s.postAccelWrongCount,
      typed_interval_days:  s.typedIntervalDays,
      typed_due_at:         s.typedDueAt,
      recall_interval_days: s.recallIntervalDays,
      recall_due_at:        s.recallDueAt,
      review_direction:     s.reviewDirection,
    }))
    const { error } = await this.db.from('card_states').upsert(rows, { onConflict: 'user_id,card_id,review_direction' })
    if (error) throw new Error(error.message)
  }

  async delete(userId: UserId, cardId: CardId, reviewDirection: 'forward' | 'reverse' = 'forward'): Promise<void> {
    const { error } = await this.db.from('card_states')
      .delete()
      .eq('user_id', userId).eq('card_id', cardId).eq('review_direction', reviewDirection)
    if (error) throw new Error(error.message)
  }

  async copy(userId: UserId, fromCardId: CardId, toCardId: CardId): Promise<CardState | null> {
    const existing = await this.get(userId, fromCardId)
    if (!existing) return null
    return this.upsert({ ...existing, cardId: toCardId })
  }

  async listAllGraduated(userId: UserId): Promise<CardState[]> {
    const { data, error } = await this.db.from('card_states')
      .select('*')
      .eq('user_id', userId)
      .eq('graduated', true)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToCardState)
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
