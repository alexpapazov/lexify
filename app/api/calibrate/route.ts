import { createAdminClient } from '@/lib/supabase/admin'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import type { TypedStrictnessLevel } from '@/domain'
import type { SchedulerParamsRow } from '@/lib/data/userSchedulerParams'
import { recencyWeightedMean, retentionCalibrationFactor } from '@/lib/retentionCalibration'

export const runtime = 'nodejs'

interface CalibratePayload {
  userId:          string
  sourceLanguage?: string
  targetLanguage?: string
}

async function calibratePair(userId: string, sourceLanguage: string, targetLanguage: string) {
  const answerFields = ['forward_typed', 'forward_recall', 'reverse_recall', 'forward_smart'] as const
  for (const answerField of answerFields) {
    // Each track calibrates toward its OWN target retention (request_retention per answer_field row).
    await calibrateBucket(userId, sourceLanguage, targetLanguage, answerField)
  }
  await calibrateGradIntervals(userId, sourceLanguage, targetLanguage)
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
    retentionCalibration: (row.retention_calibration as number | null) ?? DEFAULT_SCHEDULER_PARAMS.retentionCalibration,
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
  const target = params.requestRetention   // this track's own target retention

  const n = params.totalDueReviews
  // Minimum recent reviews before we trust a calibration at all (unchanged gate).
  const minSample = Math.max(20, Math.min(150, Math.round(n * 0.15)))
  // Pull a BROADER pool than the gate so recency weighting has old-vs-recent reviews to weigh
  // against each other; the exponential half-life (7d) makes the stale tail contribute negligibly,
  // so a generous cap can't let old data dominate — it only gives the weighting more signal.
  const poolSize = Math.min(600, Math.max(minSample * 4, 200))

  const wasTyped  = answerField === 'forward_typed' || answerField === 'forward_smart'
  const reviewDir = answerField === 'reverse_recall' ? 'reverse' : 'forward'

  const { data: events, error } = await db
    .from('review_events')
    .select('was_correct, near_miss, near_miss_weight, reviewed_at')
    .eq('user_id', userId)
    .eq('source_language', sourceLang)
    .eq('target_language', targetLang)
    .eq('review_mode', 'due')
    .eq('review_direction', reviewDir)
    .eq('was_typed', wasTyped)
    .eq('was_accelerated', false)
    .order('reviewed_at', { ascending: false })
    .limit(poolSize)

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

  if (events.length < minSample) {
    await updateParams(userId, sourceLang, targetLang, answerField, { total_due_reviews: newTotal })
    return
  }

  // Near-miss weighting: a clean correct = 1.0; an "almost" counts as (1 − weight),
  // where weight is 0.2 (accent/article) or 0.3 (spelling); a full miss = 0.
  const nmWeight = (e: { near_miss: boolean; near_miss_weight?: number | null }) =>
    (e.near_miss_weight ?? (e.near_miss ? 0.2 : 0))
  const successWeight = (e: { was_correct: boolean; near_miss: boolean; near_miss_weight?: number | null }) =>
    e.was_correct ? 1 : (nmWeight(e) > 0 ? 1 - nmWeight(e) : 0)
  // FSRS owns interval scheduling now; the only thing this loop still calibrates is the MEASURED
  // recent retention rate, which the workload forecast (analytics + "Coming up") reads per track
  // AND the interval multiplier below. Recency-weighted (7d half-life) so a recent stretch of
  // strong reviews outweighs an earlier rough patch — see lib/retentionCalibration.ts.
  const nowMs = Date.now()
  const retentionRate = recencyWeightedMean(
    events.map(e => ({
      value:   successWeight(e),
      ageDays: (nowMs - new Date(e.reviewed_at as string).getTime()) / 86_400_000,
    })),
  )

  // Feed measured-vs-target back into scheduling: stretch (or shrink) this track's intervals so the
  // learner actually lands near their target retention despite the stock weights' miscalibration.
  const calibration = retentionCalibrationFactor(retentionRate, target)

  const calibratedAt = new Date().toISOString()
  await updateParams(userId, sourceLang, targetLang, answerField, {
    calibrated_at:         calibratedAt,
    total_due_reviews:     newTotal,
    recent_retention_rate: retentionRate,
    retention_calibration: calibration,
  })
  // Log a history snapshot on EVERY retention change (not only when grad intervals shift), so the
  // calibration history is a complete per-track log and its newest row always matches the live value
  // shown above — otherwise the live number can look out of sync with a sparser history.
  if (params.recentRetentionRate !== retentionRate) {
    await saveHistory({ ...params, recentRetentionRate: retentionRate, totalDueReviews: newTotal, calibratedAt })
  }
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

