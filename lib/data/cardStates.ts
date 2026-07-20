import { createClient } from '@/lib/supabase/client'
import type { CardState, UserId, DeckId, CardId, Rating } from '@/domain'
import type { CardStateRepository } from './interfaces'
import { isOfflineActive } from '@/lib/offline/mode'
import { getLocalStore } from '@/lib/offline/localStore'
import { fetchAllRows } from '@/lib/supabasePaged'
import { localCardStatesByDeck, localUpsertCardState, localDeleteCardState } from '@/lib/offline/localRepos'

export function rowToCardState(row: Record<string, unknown>): CardState {
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
    reps:             row.reps as number,
    lapses:           row.lapses as number,
    lastRating:       row.last_rating as Rating | null,
    lastReviewedAt:   row.last_reviewed_at as string | null,
    introducedDate:   row.introduced_date as string | null,
    graduatedAt:       row.graduated_at as string | null,
    relearningStep:    Number(row.relearning_step ?? 0),
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
    difficulty:           (row.difficulty as number | null) ?? null,
    stability:            (row.stability  as number | null) ?? null,
    relearning:           Boolean(row.relearning ?? false),
    goodStreak:           Number(row.good_streak  ?? 0),
    againStreak:          Number(row.again_streak ?? 0),
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
    smartIntervalDays:   row.smart_interval_days  != null ? Number(row.smart_interval_days)  : null,
    smartDueAt:          (row.smart_due_at         as string | null) ?? null,
    acceleratedTypedConfirmed: (row.accelerated_typed_confirmed as boolean | null) ?? false,
    reviewDirection:     ((row.review_direction as string) === 'reverse' ? 'reverse' : 'forward') as 'forward' | 'reverse',
  }
}

/** CardState → DB row (single source of truth for upsert/upsertBatch and the offline sync push). */
export function cardStateToRow(state: CardState): Record<string, unknown> {
  return {
    user_id: state.userId, card_id: state.cardId, pipeline_id: state.pipelineId,
    current_step_order: state.currentStepOrder, correct_in_step: state.correctInStep,
    graduated: state.graduated, due_at: state.dueAt, interval_days: state.intervalDays,
    scheduled_interval_days: state.scheduledIntervalDays,
    reps: state.reps, lapses: state.lapses,
    last_rating: state.lastRating, last_reviewed_at: state.lastReviewedAt,
    introduced_date: state.introducedDate,
    graduated_at: state.graduatedAt,
    relearning_step: state.relearningStep,
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
    difficulty:               state.difficulty,
    stability:                state.stability,
    relearning:               state.relearning,
    good_streak:              state.goodStreak,
    again_streak:             state.againStreak,
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
    smart_interval_days:      state.smartIntervalDays,
    smart_due_at:             state.smartDueAt,
    accelerated_typed_confirmed: state.acceleratedTypedConfirmed,
    review_direction:         state.reviewDirection,
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

  /** Every card_state for the user in ONE paged query (see cards.listAllForUser for why). */
  async listAllForUser(userId: UserId): Promise<CardState[]> {
    if (isOfflineActive()) return getLocalStore().allCardStates()
    const rows = await fetchAllRows<Record<string, unknown>>((f, t) => this.db.from('card_states')
      .select('*').eq('user_id', userId).order('card_id').range(f, t))
    return rows.map(rowToCardState)
  }

  async listByDeck(userId: UserId, deckId: DeckId): Promise<CardState[]> {
    if (isOfflineActive()) return localCardStatesByDeck(deckId)
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
    if (isOfflineActive()) return localUpsertCardState(state)
    const { data, error } = await this.db.from('card_states')
      .upsert(cardStateToRow(state), { onConflict: 'user_id,card_id,review_direction' })
      .select().single()
    if (error) throw new Error(error.message)
    return rowToCardState(data)
  }

  /** Targeted dormancy update on the forward row (avoids a full-row upsert). */
  async setDormancy(
    userId: UserId,
    cardId: CardId,
    patch: { dormant?: boolean; dormancyThreshold?: number | null },
    direction: 'forward' | 'reverse' = 'forward',
  ): Promise<CardState> {
    const dbPatch: Record<string, unknown> = {}
    if ('dormant' in patch)           dbPatch.dormant = patch.dormant
    if ('dormancyThreshold' in patch) dbPatch.dormancy_threshold = patch.dormancyThreshold
    // Update EVERY row for this card + direction (some accounts have duplicate rows) so dormancy is
    // card-level per direction — no stale duplicate can keep it due. `.select()` tolerates multi-row.
    // Forward = the production (target-language) side, which determines the card's overall dormant type.
    // Reverse = the recognition side, which can be paused independently.
    const { data, error } = await this.db.from('card_states')
      .update(dbPatch)
      .eq('user_id', userId).eq('card_id', cardId).eq('review_direction', direction)
      .select()
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) throw new Error(`setDormancy: no ${direction} row found for card`)
    return rowToCardState(data[0])
  }

  async upsertBatch(states: CardState[]): Promise<void> {
    if (states.length === 0) return
    const rows = states.map(cardStateToRow)
    const { error } = await this.db.from('card_states').upsert(rows, { onConflict: 'user_id,card_id,review_direction' })
    if (error) throw new Error(error.message)
  }

  async delete(userId: UserId, cardId: CardId, reviewDirection: 'forward' | 'reverse' = 'forward'): Promise<void> {
    if (isOfflineActive()) return localDeleteCardState(cardId, reviewDirection)
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
