import { createAdminClient } from '@/lib/supabase/admin'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import type { TypedStrictnessLevel } from '@/domain'
import type { SchedulerParamsRow } from '@/lib/data/userSchedulerParams'

export const runtime = 'nodejs'

interface CalibratePayload {
  userId:          string
  sourceLanguage?: string
  targetLanguage?: string
}

async function calibratePair(userId: string, sourceLanguage: string, targetLanguage: string) {
  const answerFields = ['forward_typed', 'forward_recall', 'reverse_recall', 'forward_smart'] as const
  for (const answerField of answerFields) {
    await calibrateBucket(userId, sourceLanguage, targetLanguage, answerField)
  }
  await calibrateGradIntervals(userId, sourceLanguage, targetLanguage)
  await calibrateAccelBucket(userId, sourceLanguage, targetLanguage)
}

export async function POST(req: Request) {
  try {
    const { userId, sourceLanguage, targetLanguage }: CalibratePayload = await req.json()
    if (!userId) {
      return Response.json({ ok: false, error: 'Missing userId' }, { status: 400 })
    }

    if (sourceLanguage && targetLanguage) {
      await calibratePair(userId, sourceLanguage, targetLanguage)
    } else {
      // No pair given (e.g. after a "Study all due" session across languages):
      // calibrate every pair the user has, each scoped to its own reviews.
      const db = createAdminClient()
      const { data: decks } = await db.from('decks')
        .select('source_language, target_language')
        .eq('owner_id', userId)
      const seen = new Set<string>()
      for (const d of decks ?? []) {
        const key = `${d.source_language}|${d.target_language}`
        if (seen.has(key)) continue
        seen.add(key)
        await calibratePair(userId, d.source_language as string, d.target_language as string)
      }
    }

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
    totalDueReviews:     Number(row.total_due_reviews ?? 0),
    recentRetentionRate: row.recent_retention_rate as number | null,
    forwardTypedEnabled:  Boolean(row.forward_typed_enabled ?? true),
    forwardRecallEnabled: Boolean(row.forward_recall_enabled ?? true),
    reverseRecallEnabled: Boolean(row.reverse_recall_enabled ?? true),
    forwardSmartEnabled:  Boolean(row.forward_smart_enabled ?? false),
    strictSpelling: (row.spelling_mode as TypedStrictnessLevel | null) ?? DEFAULT_SCHEDULER_PARAMS.strictSpelling,
    strictAccents:  (row.accents_mode  as TypedStrictnessLevel | null) ?? DEFAULT_SCHEDULER_PARAMS.strictAccents,
    strictArticles: (row.articles_mode as TypedStrictnessLevel | null) ?? DEFAULT_SCHEDULER_PARAMS.strictArticles,
    requestRetention: (row.request_retention as number | null) ?? DEFAULT_SCHEDULER_PARAMS.requestRetention,
    smartTypingThresholdDays: (row.smart_typing_threshold_days as number | null) ?? DEFAULT_SCHEDULER_PARAMS.smartTypingThresholdDays,
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
  answerField: 'forward_typed' | 'forward_recall' | 'reverse_recall' | 'forward_smart',
) {
  const db     = createAdminClient()
  const params = await getOrCreate(userId, sourceLang, targetLang, answerField)

  const n              = params.totalDueReviews
  const windowSize     = Math.max(20, Math.min(150, Math.round(n * 0.15)))
  // Converge a bit faster than the old 0.01 floor while still easing off as data grows.
  const adjustmentStep = Math.max(0.03, 0.10 * Math.exp(-n / 300))

  const wasTyped  = answerField === 'forward_typed' || answerField === 'forward_smart'
  const reviewDir = answerField === 'reverse_recall' ? 'reverse' : 'forward'

  const { data: events, error } = await db
    .from('review_events')
    .select('was_correct, near_miss, near_miss_weight')
    .eq('user_id', userId)
    .eq('source_language', sourceLang)
    .eq('target_language', targetLang)
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
    .eq('source_language', sourceLang)
    .eq('target_language', targetLang)
    .eq('review_mode', 'due')
    .eq('review_direction', reviewDir)
    .eq('was_typed', wasTyped)
    .eq('was_accelerated', false)

  const newTotal = totalCount ?? n

  if (events.length < windowSize) {
    await updateParams(userId, sourceLang, targetLang, answerField, { total_due_reviews: newTotal })
    return
  }

  // Near-miss weighting: a clean correct = 1.0; an "almost" counts as (1 − weight),
  // where weight is 0.2 (accent/article) or 0.3 (spelling); a full miss = 0.
  const nmWeight = (e: { near_miss: boolean; near_miss_weight?: number | null }) =>
    (e.near_miss_weight ?? (e.near_miss ? 0.2 : 0))
  const successWeight = (e: { was_correct: boolean; near_miss: boolean; near_miss_weight?: number | null }) =>
    e.was_correct ? 1 : (nmWeight(e) > 0 ? 1 - nmWeight(e) : 0)
  const retentionRate = events.reduce((sum, e) => sum + successWeight(e), 0) / events.length

  let newGoodIdeal = params.goodIdeal
  let newEasyIdeal = params.easyIdeal
  let newHardIdeal = params.hardIdeal

  if (retentionRate < 0.88) {
    newGoodIdeal = Math.max(1.50, params.goodIdeal - adjustmentStep)
    newEasyIdeal = Math.max(2.00, params.easyIdeal - adjustmentStep)
    newHardIdeal = Math.max(1.05, params.hardIdeal - adjustmentStep)  // never fully flatten
  } else if (retentionRate > 0.92) {
    newGoodIdeal = Math.min(4.00, params.goodIdeal + adjustmentStep)
    newEasyIdeal = Math.min(6.00, params.easyIdeal + adjustmentStep)
    newHardIdeal = Math.min(1.80, params.hardIdeal + adjustmentStep)
  }

  const changed = newGoodIdeal !== params.goodIdeal
    || newEasyIdeal !== params.easyIdeal
    || newHardIdeal !== params.hardIdeal

  if (changed) {
    await saveHistory({ ...params, totalDueReviews: newTotal })
  }

  // Move the [min,max] band by the same delta as the ideal, so the
  // density-smoothing range stays centered on the calibrated ideal instead of
  // drifting outside it (which let the smoother partially undo calibration).
  const gd = newGoodIdeal - params.goodIdeal
  const ed = newEasyIdeal - params.easyIdeal
  const hd = newHardIdeal - params.hardIdeal

  await updateParams(userId, sourceLang, targetLang, answerField, {
    good_min:   params.goodMin + gd, good_ideal: newGoodIdeal, good_max: params.goodMax + gd,
    easy_min:   params.easyMin + ed, easy_ideal: newEasyIdeal, easy_max: params.easyMax + ed,
    hard_min:   params.hardMin + hd, hard_ideal: newHardIdeal, hard_max: params.hardMax + hd,
    calibrated_at:         new Date().toISOString(),
    total_due_reviews:     newTotal,
    recent_retention_rate: retentionRate,
  })
}

/**
 * Calibrates the graduation-interval [min,max] for each exact pipeline-error
 * bucket (0–7 individual, 8+ combined), using first-post-graduation reviews
 * (reps=1) grouped by the card's graduationErrorCount. A near-miss counts as
 * only 0.2 of a failure. Stored on the forward_typed row (the one the session
 * reads at graduation).
 */
async function calibrateGradIntervals(userId: string, sourceLang: string, targetLang: string) {
  const db     = createAdminClient()
  const params = await getOrCreate(userId, sourceLang, targetLang, 'forward_typed')

  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const { data: firstReviews } = await db
    .from('review_events')
    .select('was_correct, near_miss, near_miss_weight, graduation_error_count')
    .eq('user_id', userId)
    .eq('source_language', sourceLang)
    .eq('target_language', targetLang)
    .eq('reps', 1)
    .eq('review_direction', 'forward')
    .eq('was_accelerated', false)
    .gte('reviewed_at', ninetyDaysAgo)

  if (!firstReviews || firstReviews.length === 0) return

  // Group into buckets 0–7 and 8 (= 8 or more).
  type WeightedEvent = { was_correct: boolean; near_miss_weight: number }
  const buckets = new Map<number, WeightedEvent[]>()
  for (const e of firstReviews) {
    const raw = Number(e.graduation_error_count ?? 0)
    const bucket = Math.min(8, Math.max(0, raw))
    const arr = buckets.get(bucket) ?? []
    arr.push({ was_correct: !!e.was_correct, near_miss_weight: Number(e.near_miss_weight ?? (e.near_miss ? 0.2 : 0)) })
    buckets.set(bucket, arr)
  }

  const failWeight = (e: WeightedEvent) =>
    e.was_correct ? 0 : (e.near_miss_weight > 0 ? e.near_miss_weight : 1)

  const updates: Record<string, number> = {}
  let anyChange = false
  for (const [bucket, evs] of buckets) {
    if (evs.length < 5) continue
    const failRate = evs.reduce((s, e) => s + failWeight(e), 0) / evs.length
    const minKey = `gradInterval${bucket}errMin` as keyof typeof params
    const maxKey = `gradInterval${bucket}errMax` as keyof typeof params
    const curMin = params[minKey] as number
    const curMax = params[maxKey] as number
    let newMin = curMin
    let newMax = curMax
    if (failRate > 0.20) { newMin = Math.max(1, curMin - 1); newMax = Math.max(1, curMax - 1) }
    else if (failRate < 0.05) { newMin = Math.min(14, curMin + 1); newMax = Math.min(14, curMax + 1) }
    if (newMin !== curMin || newMax !== curMax) {
      updates[`grad_interval_${bucket}err_min`] = newMin
      updates[`grad_interval_${bucket}err_max`] = newMax
      anyChange = true
    }
  }

  if (anyChange) {
    await saveHistory({ ...params })
    await updateParams(userId, sourceLang, targetLang, 'forward_typed', updates)
  }
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
    .select('was_correct, near_miss, near_miss_weight, accelerated_penalty')
    .eq('user_id', userId)
    .eq('source_language', sourceLang)
    .eq('target_language', targetLang)
    .eq('review_mode', 'due')
    .eq('was_accelerated', true)
    .order('reviewed_at', { ascending: false })
    .limit(windowSize)

  if (!events || events.length < windowSize) return

  let weightedCorrect = 0
  let weightedTotal   = 0
  for (const e of events) {
    const weight  = Math.max(0, 1 - (e.accelerated_penalty ?? 0) / 5)
    const nmw     = Number(e.near_miss_weight ?? (e.near_miss ? 0.2 : 0))
    const success = e.was_correct ? 1 : (nmw > 0 ? 1 - nmw : 0)
    weightedTotal   += weight
    weightedCorrect += weight * success
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
    // Shift the [min,max] band with the ideal (same fix as the normal track).
    const gd = newAccelGoodIdeal - params.accelGoodIdeal
    const ed = newAccelEasyIdeal - params.accelEasyIdeal
    await updateParams(userId, sourceLang, targetLang, 'forward_typed', {
      accel_good_min: params.accelGoodMin + gd, accel_good_ideal: newAccelGoodIdeal, accel_good_max: params.accelGoodMax + gd,
      accel_easy_min: params.accelEasyMin + ed, accel_easy_ideal: newAccelEasyIdeal, accel_easy_max: params.accelEasyMax + ed,
    })
  }
}
