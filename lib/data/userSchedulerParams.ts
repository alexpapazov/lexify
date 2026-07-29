import { createClient } from '@/lib/supabase/client'
import type { SchedulerParams, TypedStrictnessLevel } from '@/domain'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import { cachedRead, invalidateReads } from '@/lib/readCache'
import { isOfflineActive } from '@/lib/offline/mode'
import { localSchedulerParams } from '@/lib/offline/localRepos'

export interface SchedulerParamsRow extends SchedulerParams {
  userId: string
  sourceLanguage: string
  targetLanguage: string
  answerField: string
  calibratedAt: string | null
  /** When the interval multiplier was last actuated (moved). Gates it to ~once/day; see dampedCalibration. */
  retentionCalibrationAt: string | null
  totalDueReviews: number
  recentRetentionRate: number | null
  forwardTypedEnabled: boolean
  forwardRecallEnabled: boolean
  reverseRecallEnabled: boolean
  forwardSmartEnabled:  boolean
}

export interface SchedulerParamsHistoryRow {
  id: string
  userId: string
  sourceLanguage: string
  targetLanguage: string
  answerField: string
  snapshot: SchedulerParamsRow
  snapshottedAt: string
  totalDueReviews: number
}

function rowToParams(row: Record<string, unknown>): SchedulerParamsRow {
  return {
    userId:              row.user_id as string,
    sourceLanguage:      row.source_language as string,
    targetLanguage:      row.target_language as string,
    answerField:         row.answer_field as string,
    typedProbBelow70:    row.typed_prob_below_70 as number,
    typedProb70to84:     row.typed_prob_70_to_84 as number,
    typedProb85to94:     row.typed_prob_85_to_94 as number,
    typedProb95plus:     row.typed_prob_95_plus as number,
    maxIntervalDays:     row.max_interval_days as number,
    gradInterval0errMin: row.grad_interval_0err_min as number,
    gradInterval0errMax: row.grad_interval_0err_max as number,
    gradInterval1errMin: row.grad_interval_1err_min as number,
    gradInterval1errMax: row.grad_interval_1err_max as number,
    gradInterval2errMin: row.grad_interval_2err_min as number,
    gradInterval2errMax: row.grad_interval_2err_max as number,
    gradInterval3errMin: row.grad_interval_3err_min as number,
    gradInterval3errMax: row.grad_interval_3err_max as number,
    gradInterval4errMin: (row.grad_interval_4err_min as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval4errMin,
    gradInterval4errMax: (row.grad_interval_4err_max as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval4errMax,
    gradInterval5errMin: (row.grad_interval_5err_min as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval5errMin,
    gradInterval5errMax: (row.grad_interval_5err_max as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval5errMax,
    gradInterval6errMin: (row.grad_interval_6err_min as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval6errMin,
    gradInterval6errMax: (row.grad_interval_6err_max as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval6errMax,
    gradInterval7errMin: (row.grad_interval_7err_min as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval7errMin,
    gradInterval7errMax: (row.grad_interval_7err_max as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval7errMax,
    gradInterval8errMin: (row.grad_interval_8err_min as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval8errMin,
    gradInterval8errMax: (row.grad_interval_8err_max as number | null) ?? DEFAULT_SCHEDULER_PARAMS.gradInterval8errMax,
    calibratedAt:        row.calibrated_at as string | null,
    retentionCalibrationAt: (row.retention_calibration_at as string | null) ?? null,
    totalDueReviews:     row.total_due_reviews as number,
    recentRetentionRate: row.recent_retention_rate as number | null,
    forwardTypedEnabled:  (row.forward_typed_enabled as boolean) ?? true,
    forwardRecallEnabled: (row.forward_recall_enabled as boolean) ?? true,
    reverseRecallEnabled: (row.reverse_recall_enabled as boolean) ?? true,
    forwardSmartEnabled:  (row.forward_smart_enabled  as boolean) ?? false,
    strictSpelling: (row.spelling_mode as TypedStrictnessLevel | null) ?? DEFAULT_SCHEDULER_PARAMS.strictSpelling,
    strictAccents:  (row.accents_mode  as TypedStrictnessLevel | null) ?? DEFAULT_SCHEDULER_PARAMS.strictAccents,
    strictArticles: (row.articles_mode as TypedStrictnessLevel | null) ?? DEFAULT_SCHEDULER_PARAMS.strictArticles,
    requestRetention: (row.request_retention as number | null) ?? DEFAULT_SCHEDULER_PARAMS.requestRetention,
    smartTypingThresholdDays: (row.smart_typing_threshold_days as number | null) ?? DEFAULT_SCHEDULER_PARAMS.smartTypingThresholdDays,
    retentionCalibration: (row.retention_calibration as number | null) ?? DEFAULT_SCHEDULER_PARAMS.retentionCalibration,
  }
}

export class SupabaseUserSchedulerParamsRepository {
  private get db() { return createClient() }

  async getOrCreate(
    userId: string,
    sourceLanguage: string,
    targetLanguage: string,
    answerField: string,
  ): Promise<SchedulerParamsRow> {
    invalidateReads('params:')  // may insert the row — a cached listForUser wouldn't include it
    await this.db.from('user_scheduler_params').upsert(
      { user_id: userId, source_language: sourceLanguage, target_language: targetLanguage, answer_field: answerField },
      { onConflict: 'user_id,source_language,target_language,answer_field', ignoreDuplicates: true },
    )
    const { data, error } = await this.db
      .from('user_scheduler_params')
      .select('*')
      .eq('user_id', userId)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
      .eq('answer_field', answerField)
      .single()
    if (error) throw new Error(error.message)
    return rowToParams(data)
  }

  async listForUser(userId: string): Promise<SchedulerParamsRow[]> {
    if (isOfflineActive()) return localSchedulerParams()
    return cachedRead(`params:${userId}`, async () => {
      const { data, error } = await this.db
        .from('user_scheduler_params')
        .select('*')
        .eq('user_id', userId)
      if (error) throw new Error(error.message)
      return (data ?? []).map(rowToParams)
    })
  }

  async update(
    userId: string,
    sourceLanguage: string,
    targetLanguage: string,
    answerField: string,
    updates: Partial<Record<string, unknown>>,
  ): Promise<void> {
    invalidateReads('params:')
    const { error } = await this.db
      .from('user_scheduler_params')
      .update(updates)
      .eq('user_id', userId)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
      .eq('answer_field', answerField)
    if (error) throw new Error(error.message)
  }

  async getHistory(
    userId: string,
    sourceLanguage: string,
    targetLanguage: string,
    answerField: string,
  ): Promise<SchedulerParamsHistoryRow[]> {
    const { data, error } = await this.db
      .from('user_scheduler_params_history')
      .select('*')
      .eq('user_id', userId)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
      .eq('answer_field', answerField)
      .order('snapshotted_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return (data ?? []).map(r => ({
      id:              r.id as string,
      userId:          r.user_id as string,
      sourceLanguage:  r.source_language as string,
      targetLanguage:  r.target_language as string,
      answerField:     r.answer_field as string,
      snapshot:        r.snapshot as SchedulerParamsRow,
      snapshottedAt:   r.snapshotted_at as string,
      totalDueReviews: r.total_due_reviews as number,
    }))
  }

  async saveHistory(snapshot: SchedulerParamsRow): Promise<void> {
    const { error } = await this.db.from('user_scheduler_params_history').insert({
      user_id:           snapshot.userId,
      source_language:   snapshot.sourceLanguage,
      target_language:   snapshot.targetLanguage,
      answer_field:      snapshot.answerField,
      snapshot:          snapshot,
      total_due_reviews: snapshot.totalDueReviews,
    })
    if (error) throw new Error(error.message)
  }
}
