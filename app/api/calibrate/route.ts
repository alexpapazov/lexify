import { createAdminClient } from '@/lib/supabase/admin'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import type { SchedulerParamsRow } from '@/lib/data/userSchedulerParams'

export const runtime = 'nodejs'

interface CalibratePayload {
  userId:         string
  sourceLanguage: string
  targetLanguage: string
}

export async function POST(req: Request) {
  try {
    const { userId, sourceLanguage, targetLanguage }: CalibratePayload = await req.json()
    if (!userId || !sourceLanguage || !targetLanguage) {
      return Response.json({ ok: false, error: 'Missing required fields' }, { status: 400 })
    }

    const answerFields = ['forward_typed', 'forward_recall', 'reverse_recall'] as const
    for (const answerField of answerFields) {
      await calibrateBucket(userId, sourceLanguage, targetLanguage, answerField)
    }

    await calibrateAccelBucket(userId, sourceLanguage, targetLanguage)

    return Response.json({ ok: true })
  } catch (err) {
    console.error('[calibrate] error:', err)
    return Response.json({ ok: false }, { status: 500 })
  }
}

function rowToParams(row: Record<string, unknown>): SchedulerParamsRow {
  return {
    userId:              row.user_id as string,
    sourceLanguage:      row.source_language as string,
    targetLanguage:      row.target_language as string,
    answerField:         row.answer_field as string,
    goodMin:             row.good_min as number,
    goodIdeal:           row.good_ideal as number,
    goodMax:             row.good_max as number,
    goodFloor:           row.good_floor as number,
    hardMin:             row.hard_min as number,
    hardIdeal:           row.hard_ideal as number,
    hardMax:             row.hard_max as number,
    hardFloor:           row.hard_floor as number,
    easyMin:             row.easy_min as number,
    easyIdeal:           row.easy_ideal as number,
    easyMax:             row.easy_max as number,
    easyFloor:           row.easy_floor as number,
    accelGoodMin:        row.accel_good_min as number,
    accelGoodIdeal:      row.accel_good_ideal as number,
    accelGoodMax:        row.accel_good_max as number,
    accelHardMin:        row.accel_hard_min as number,
    accelHardIdeal:      row.accel_hard_ideal as number,
    accelHardMax:        row.accel_hard_max as number,
    accelEasyMin:        row.accel_easy_min as number,
    accelEasyIdeal:      row.accel_easy_ideal as number,
    accelEasyMax:        row.accel_easy_max as number,
    typedProbBelow70:    row.typed_prob_below_70 as number,
    typedProb70to84:     row.typed_prob_70_to_84 as number,
    typedProb85to94:     row.typed_prob_85_to_94 as number,
    typedProb95plus:     row.typed_prob_95_plus as number,
    decayConstantDays:   row.decay_constant_days as number,
    againReduction:      row.again_reduction as number,
    maxIntervalDays:     row.max_interval_days as number,
    gradInterval0errMin: row.grad_interval_0err_min as number,
    gradInterval0errMax: row.grad_interval_0err_max as number,
    gradInterval1errMin: row.grad_interval_1err_min as number,
    gradInterval1errMax: row.grad_interval_1err_max as number,
    gradInterval2errMin: row.grad_interval_2err_min as number,
    gradInterval2errMax: row.grad_interval_2err_max as number,
    gradInterval3errMin: row.grad_interval_3err_min as number,
    gradInterval3errMax: row.grad_interval_3err_max as number,
    calibratedAt:        row.calibrated_at as string | null,
    totalDueReviews:     Number(row.total_due_reviews ?? 0),
    recentRetentionRate: row.recent_retention_rate as number | null,
    forwardTypedEnabled:  Boolean(row.forward_typed_enabled ?? true),
    forwardRecallEnabled: Boolean(row.forward_recall_enabled ?? true),
    reverseRecallEnabled: Boolean(row.reverse_recall_enabled ?? true),
  }
}

async function getOrCreate(
  userId: string, sourceLang: string, targetLang: string, answerField: string,
): Promise<SchedulerParamsRow> {
  const db = createAdminClient()
  await db.from('user_scheduler_params').upsert(
    { user_id: userId, source_language: sourceLang, target_language: targetLang, answer_field: answerField },
    { onConflict: 'user_id,source_language,target_language,answer_field', ignoreDuplicates: true },
  )
  const { data, error } = await db
    .from('user_scheduler_params')
    .select('*')
    .eq('user_id', userId)
    .eq('source_language', sourceLang)
    .eq('target_language', targetLang)
    .eq('answer_field', answerField)
    .single()
  if (error) throw new Error(error.message)
  return rowToParams(data)
}

async function updateParams(
  userId: string, sourceLang: string, targetLang: string, answerField: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const db = createAdminClient()
  const { error } = await db.from('user_scheduler_params')
    .update(updates)
    .eq('user_id', userId)
    .eq('source_language', sourceLang)
    .eq('target_language', targetLang)
    .eq('answer_field', answerField)
  if (error) throw new Error(error.message)
}

async function saveHistory(snapshot: SchedulerParamsRow): Promise<void> {
  const db = createAdminClient()
  await db.from('user_scheduler_params_history').insert({
    user_id:           snapshot.userId,
    source_language:   snapshot.sourceLanguage,
    target_language:   snapshot.targetLanguage,
    answer_field:      snapshot.answerField,
    snapshot,
    total_due_reviews: snapshot.totalDueReviews,
  })
}

async function calibrateBucket(
  userId: string,
  sourceLang: string,
  targetLang: string,
  answerField: 'forward_typed' | 'forward_recall' | 'reverse_recall',
) {
  const db     = createAdminClient()
  const params = await getOrCreate(userId, sourceLang, targetLang, answerField)

  const n              = params.totalDueReviews
  const windowSize     = Math.max(20, Math.min(150, Math.round(n * 0.15)))
  const adjustmentStep = Math.max(0.01, 0.08 * Math.exp(-n / 200))

  const wasTyped  = answerField === 'forward_typed'
  const reviewDir = answerField === 'reverse_recall' ? 'reverse' : 'forward'

  const { data: events, error } = await db
    .from('review_events')
    .select('was_correct')
    .eq('user_id', userId)
    .eq('review_mode', 'due')
    .eq('review_direction', reviewDir)
    .eq('was_typed', wasTyped)
    .eq('was_accelerated', false)
    .order('reviewed_at', { ascending: false })
    .limit(windowSize)

  if (error || !events) return

  const { count: totalCount } = await db
    .from('review_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('review_mode', 'due')
    .eq('review_direction', reviewDir)
    .eq('was_typed', wasTyped)
    .eq('was_accelerated', false)

  const newTotal = totalCount ?? n

  if (events.length < windowSize) {
    await updateParams(userId, sourceLang, targetLang, answerField, { total_due_reviews: newTotal })
    return
  }

  const retentionRate = events.filter(e => e.was_correct).length / events.length

  let newGoodIdeal = params.goodIdeal
  let newEasyIdeal = params.easyIdeal

  if (retentionRate < 0.88) {
    newGoodIdeal = Math.max(1.50, params.goodIdeal - adjustmentStep)
    newEasyIdeal = Math.max(2.00, params.easyIdeal - adjustmentStep)
  } else if (retentionRate > 0.92) {
    newGoodIdeal = Math.min(4.00, params.goodIdeal + adjustmentStep)
    newEasyIdeal = Math.min(6.00, params.easyIdeal + adjustmentStep)
  }

  let gradUpdate: Record<string, number> = {}
  if (answerField === 'forward_typed' || answerField === 'forward_recall') {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const { data: firstReviews } = await db
      .from('review_events')
      .select('was_correct')
      .eq('user_id', userId)
      .eq('reps', 1)
      .eq('review_direction', reviewDir)
      .eq('was_typed', wasTyped)
      .gte('reviewed_at', ninetyDaysAgo)

    if (firstReviews && firstReviews.length >= 5) {
      const failRate = firstReviews.filter(e => !e.was_correct).length / firstReviews.length
      if (failRate > 0.20) {
        gradUpdate = {
          grad_interval_0err_min: Math.max(1, params.gradInterval0errMin - 1),
          grad_interval_0err_max: Math.max(1, params.gradInterval0errMax - 1),
        }
      } else if (failRate < 0.05) {
        gradUpdate = {
          grad_interval_0err_min: Math.min(14, params.gradInterval0errMin + 1),
          grad_interval_0err_max: Math.min(14, params.gradInterval0errMax + 1),
        }
      }
    }
  }

  const changed = newGoodIdeal !== params.goodIdeal || newEasyIdeal !== params.easyIdeal
    || Object.keys(gradUpdate).length > 0

  if (changed) {
    await saveHistory({ ...params, totalDueReviews: newTotal })
  }

  await updateParams(userId, sourceLang, targetLang, answerField, {
    good_ideal:            newGoodIdeal,
    easy_ideal:            newEasyIdeal,
    calibrated_at:         new Date().toISOString(),
    total_due_reviews:     newTotal,
    recent_retention_rate: retentionRate,
    ...gradUpdate,
  })
}

async function calibrateAccelBucket(
  userId: string,
  sourceLang: string,
  targetLang: string,
) {
  const db     = createAdminClient()
  const params = await getOrCreate(userId, sourceLang, targetLang, 'forward_typed')

  const n              = params.totalDueReviews
  const windowSize     = Math.max(20, Math.min(150, Math.round(n * 0.15)))
  const adjustmentStep = Math.max(0.01, 0.08 * Math.exp(-n / 200))

  const { data: events } = await db
    .from('review_events')
    .select('was_correct, accelerated_penalty')
    .eq('user_id', userId)
    .eq('review_mode', 'due')
    .eq('was_accelerated', true)
    .order('reviewed_at', { ascending: false })
    .limit(windowSize)

  if (!events || events.length < windowSize) return

  let weightedCorrect = 0
  let weightedTotal   = 0
  for (const e of events) {
    const weight = Math.max(0, 1 - (e.accelerated_penalty ?? 0) / 5)
    weightedTotal   += weight
    if (e.was_correct) weightedCorrect += weight
  }

  if (weightedTotal < 5) return

  const retentionRate = weightedCorrect / weightedTotal

  let newAccelGoodIdeal = params.accelGoodIdeal
  let newAccelEasyIdeal = params.accelEasyIdeal

  if (retentionRate < 0.88) {
    newAccelGoodIdeal = Math.max(2.50, params.accelGoodIdeal - adjustmentStep)
    newAccelEasyIdeal = Math.max(3.00, params.accelEasyIdeal - adjustmentStep)
  } else if (retentionRate > 0.92) {
    newAccelGoodIdeal = Math.min(3.50, params.accelGoodIdeal + adjustmentStep)
    newAccelEasyIdeal = Math.min(6.00, params.accelEasyIdeal + adjustmentStep)
  }

  if (newAccelGoodIdeal !== params.accelGoodIdeal || newAccelEasyIdeal !== params.accelEasyIdeal) {
    await saveHistory({ ...params })
    await updateParams(userId, sourceLang, targetLang, 'forward_typed', {
      accel_good_ideal: newAccelGoodIdeal,
      accel_easy_ideal: newAccelEasyIdeal,
    })
  }
}
