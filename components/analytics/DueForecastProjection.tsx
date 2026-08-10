'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { createClient } from '@/lib/supabase/client'
import { langName, langFlag, assignLanguageColors } from '@/lib/languages'
import { monteCarloSteps, percentile, measureRatingModel, mixForReps, driftLabel, estimateInitialInterval, seedStability, seedDifficulty, DEFAULT_DIFFICULTY, stabilityForInterval, type RatingModel } from '@/lib/forecastFsrs'
import { SupabaseGoalScheduleRepository, progressForSchedules } from '@/lib/data/goalSchedules'
import { schedulePlan, dayCapacity, isPatternSchedule, eachDate, addScheduleDays } from '@/lib/goalSchedule'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { getToday } from '@/lib/dates'
import { applyDailyCeiling } from '@/lib/dailyCeiling'
import type { GoalSchedule } from '@/domain'

// Forward projection of daily "Due Now" load, split into Typed / Self-graded / Reverse / Total,
// simulated on the live FSRS stability model by MONTE CARLO. Each card is played forward many times;
// on every review a rating is drawn from that language's measured mix (again/hard/good/easy), stability
// and difficulty advance by the real engine, and the next interval is fuzzed like the live scheduler.
// Averaging the runs gives an unbiased mean (the mean-field stepper under-counted load via Jensen's
// inequality); the spread across runs gives a p10–p90 confidence band. Existing cards seed from their
// own real difficulty/stability (accelerated cards modelled as-is); new cards seed from the
// per-language averages of NON-accelerated cards.
//
// NEW-CARD INTAKE FOLLOWS THE GOAL SYSTEM DAY BY DAY, not a flat average: a schedule contributes its
// actual plan (re-spread from today's progress, days off included) and NOTHING after its deadline; a
// pattern schedule contributes its per-day capacity; plain weekday goals contribute each weekday's own
// number; and the combined daily ceiling caps the sum across languages. So when a deadline passes and
// intake stops, the projected load visibly TAPERS — the dashed deadline markers on the chart are there
// to say that's why.

const HORIZON = 730          // 2 years
const STEP = 14              // chart sampling / smoothing window (days)
const RUNS = 64              // Monte Carlo trajectories per card/track

// A NEW card enters Due Now at each language's MEASURED starting interval — the median interval of its
// freshest graduated, non-accelerated cards (reps ≤ 1), which reflects the true ladder graduation
// interval rather than the (much longer) average of mature/accelerated cards. When a language has no
// fresh sample we fall back to the ladder's 1-day Good-path graduation interval. Seeding at the mature
// average would make languages full of long-interval cards show ~0 typed load, which is wrong — so we
// deliberately sample only the freshest cards (see estimateInitialInterval).
const GRADUATION_I0_FALLBACK = 1

interface PairCfg {
  typedP: number; selfgP: number; smartP: number; reverseP: number
  // Per-track interval calibration (measured-vs-target retention) — matches the live scheduler.
  typedCal: number; selfgCal: number; smartCal: number; reverseCal: number
  typedOn: boolean; selfgOn: boolean; smartOn: boolean; reverseOn: boolean
  smartThreshold: number
  maxInt: number
  src: string; tgt: string
}

interface PairSeries { key: string; label: string; flag: string; typed: number[]; selfg: number[]; recog: number[] }
interface PairModel { key: string; label: string; flag: string; days: number; difficulty: number; drift: string }
/** A schedule's deadline, drawn as a dashed vertical on the chart to explain the load drop after it. */
interface GoalMarker { day: number; key: string; label: string }
interface Forecast { pairs: PairSeries[]; sampleDays: number[]; models: PairModel[]; hasGoals: boolean; bands: Record<string, { lo: number[]; hi: number[] }>; markers: GoalMarker[] }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function ordinal(n: number): string {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  return `${n}${(['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`
}
/** Short calendar date `dayOffset` days out, e.g. "Mar 12" — fits beside a chart marker. */
function shortForecastDate(dayOffset: number): string {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
/** Calendar date `dayOffset` days from today, e.g. "July 13th, 2026". */
function forecastDate(dayOffset: number): string {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset)
  return `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`
}

export function DueForecastProjection() {
  const [data, setData] = useState<Forecast | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filterKey, setFilterKey] = useState<string | null>(null)   // selected pair, or null = all
  const [langColors, setLangColors] = useState<Record<string, string>>({})  // per-language color overrides
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setError('Not signed in'); return }
        const uid = session.user.id

        // Widest select first, narrowing on error — `daily_word_ceiling` needs migration 116, and a
        // missing column errors the WHOLE query (the documented profiles landmine).
        let profRes = await supabase.from('profiles').select('language_colors, timezone, day_turnover_hour, daily_word_ceiling').eq('user_id', uid).maybeSingle()
        if (profRes.error) profRes = await supabase.from('profiles').select('language_colors, timezone, day_turnover_hour').eq('user_id', uid).maybeSingle()
        const prof = profRes.data as Record<string, unknown> | null
        if (!cancelled) setLangColors((prof?.language_colors as Record<string, string> | null) ?? {})
        const tz = (prof?.timezone as string | null) ?? deviceTimeZone()
        const turnover = (prof?.day_turnover_hour as number | null) ?? 0
        const wordCeiling = (prof?.daily_word_ceiling as number | null) ?? null
        const today = getToday(tz, turnover)

        const [decks, paramRows, pairs, schedules] = await Promise.all([
          new SupabaseDeckRepository().list(uid),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
          new SupabaseLanguagePairRepository().list(uid),
          new SupabaseGoalScheduleRepository().listActive(uid).catch(() => [] as GoalSchedule[]),
        ])

        // Per-pair config keyed `${src}|${tgt}`.
        const cfg = new Map<string, PairCfg>()
        const ensure = (src: string, tgt: string): PairCfg => {
          const k = `${src}|${tgt}`
          let c = cfg.get(k)
          if (!c) { c = { typedP: 0.85, selfgP: 0.9, smartP: 0.85, reverseP: 0.9, typedCal: 1, selfgCal: 1, smartCal: 1, reverseCal: 1, typedOn: true, selfgOn: true, smartOn: false, reverseOn: true, smartThreshold: 20, maxInt: 1460, src, tgt }; cfg.set(k, c) }
          return c
        }
        for (const r of paramRows) {
          const c = ensure(r.sourceLanguage, r.targetLanguage)
          c.maxInt = r.maxIntervalDays
          // Simulate at each track's TARGET retention (request_retention) + its calibration factor —
          // exactly what the live scheduler does (interval = calibration · intervalForRetention(S, target)).
          // So the per-track target sliders move this chart, and measured retention only enters via the
          // (already-computed) calibration factor.
          const ret = r.requestRetention ?? undefined
          const cal = r.retentionCalibration ?? 1
          if (r.answerField === 'forward_typed')  { c.typedOn = r.forwardTypedEnabled;  c.smartThreshold = r.smartTypingThresholdDays; if (ret) c.typedP = ret; c.typedCal = cal }
          if (r.answerField === 'forward_recall') { c.selfgOn = r.forwardRecallEnabled; if (ret) c.selfgP = ret; c.selfgCal = cal }
          if (r.answerField === 'forward_smart')  { c.smartOn = r.forwardSmartEnabled;  if (ret) c.smartP = ret; c.smartCal = cal }
          if (r.answerField === 'reverse_recall') { c.reverseOn = r.reverseRecallEnabled; if (ret) c.reverseP = ret; c.reverseCal = cal }
        }
        // ── New-word intake per pair, day by day over the horizon ──
        // A live schedule OWNS its pair's intake (same supersedence rule as every goal surface):
        // its re-spread plan for a target schedule — which is ZERO past the deadline — or its
        // per-day capacity for an open-ended pattern. Pairs without a schedule fall back to their
        // weekday goals, each weekday with its own number rather than a flattened sum/7.
        const dates = eachDate(today, addScheduleDays(today, HORIZON))
        const dateIndex = new Map(dates.map((d, i) => [d, i]))
        const scheduleDone = schedules.length
          ? await progressForSchedules({ userId: uid, schedules, timezone: tz, turnoverHour: turnover }).catch(() => new Map<string, number>())
          : new Map<string, number>()

        const intakeByPair = new Map<string, Float64Array>()
        const markers: GoalMarker[] = []
        for (const sc of schedules) {
          const key = `${sc.sourceLanguage}|${sc.targetLanguage}`
          ensure(sc.sourceLanguage, sc.targetLanguage)
          const arr = new Float64Array(HORIZON + 1)
          if (isPatternSchedule(sc)) {
            dates.forEach((dt, i) => { const cap = dayCapacity(sc, dt); arr[i] = isFinite(cap) ? cap : 0 })
          } else {
            for (const day of schedulePlan(sc, today, scheduleDone.get(key) ?? 0)) {
              const i = dateIndex.get(day.date)
              if (i != null) arr[i] = day.words
            }
            const end = sc.deadline ? dateIndex.get(sc.deadline) : null
            if (end != null) {
              markers.push({ day: end, key, label: `${langFlag(sc.sourceLanguage)} ${sc.name?.trim() || `${langName(sc.sourceLanguage)} goal`}` })
            }
          }
          intakeByPair.set(key, arr)
        }
        for (const pr of pairs) {
          const key = `${pr.sourceLanguage}|${pr.targetLanguage}`
          if (intakeByPair.has(key)) continue   // the schedule supersedes the weekday goals
          const g = pr.goals
          if (!g) continue
          ensure(pr.sourceLanguage, pr.targetLanguage)
          const arr = new Float64Array(HORIZON + 1)
          let any = false
          dates.forEach((dt, i) => {
            const v = g[String(new Date(dt + 'T12:00:00Z').getUTCDay())] ?? 0
            if (v > 0) { arr[i] = v; any = true }
          })
          if (any) intakeByPair.set(key, arr)
        }

        // The combined daily ceiling is cross-language by nature — three languages at 10 each is 30 —
        // so it must cap the SUM, deferring overflow to the next day exactly as the goal surfaces do.
        if (wordCeiling && wordCeiling > 0 && intakeByPair.size > 0) {
          const demand = new Map([...intakeByPair].map(([k, arr]) => [k, new Map(dates.map((dt, i) => [dt, arr[i] ?? 0]))]))
          const capped = applyDailyCeiling({ dates, demand, ceiling: wordCeiling })
          for (const [k, arr] of intakeByPair) {
            arr.fill(0)
            for (const [dt, words] of capped.planned.get(k) ?? []) {
              const i = dateIndex.get(dt)
              if (i != null) arr[i] = words
            }
          }
        }
        const anyGoal = [...intakeByPair.values()].some(arr => arr.some(v => v > 0))

        const now = Date.now()
        const DAY = 86_400_000
        const offset = (iso: string | null | undefined) => iso ? Math.max(0, Math.round((new Date(iso).getTime() - now) / DAY)) : null

        // Per-pair per-track daily-load accumulators.
        const series = new Map<string, { typed: Float64Array; selfg: Float64Array; recog: Float64Array }>()
        const seriesFor = (k: string) => {
          let x = series.get(k)
          if (!x) { x = { typed: new Float64Array(HORIZON + 1), selfg: new Float64Array(HORIZON + 1), recog: new Float64Array(HORIZON + 1) }; series.set(k, x) }
          return x
        }

        const seedS = seedStability
        const seedD = seedDifficulty

        const stateRepo = new SupabaseCardStateRepository()
        // ONE cached paged read for the whole library instead of a per-deck fan-out (each of which
        // was itself 2 serial round trips). Grouped back per deck so the logic below is untouched.
        const [allStates, deckIdByCard] = await Promise.all([
          stateRepo.listAllForUser(uid),
          new SupabaseCardRepository().deckIdsByCard(decks.map(d => d.id)),
        ])
        const statesByDeck = new Map<string, typeof allStates>()
        for (const s of allStates) {
          const dId = deckIdByCard.get(s.cardId)
          if (!dId) continue
          const arr = statesByDeck.get(dId)
          if (arr) arr.push(s); else statesByDeck.set(dId, [s])
        }
        const deckStates = decks.map(d => statesByDeck.get(d.id) ?? [])

        // Per-run total-load accumulators (K realizations) → the p10–p90 confidence band, kept PER
        // PAIR so each language filter gets its own band (the all-languages band sums them per run).
        // Each card contributes its run-k sample to system-run k; independent RNG streams make run k a
        // valid i.i.d. draw. Scale K down on large libraries to bound compute.
        // Yield before the Monte Carlo. Everything below is synchronous FSRS simulation — K runs per
        // track per graduated card, easily millions of iterations — and with no yield it ran in the
        // same tick as the fetch resolution, pinning the main thread so the tab froze rather than
        // showing "Building projection…". (The study dashboard's forecast already does this.)
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        if (cancelled) return

        const gradedRows = deckStates.reduce((n, ss) => n + ss.reduce((m, s) => m + (s.graduated ? 1 : 0), 0), 0)
        const K = gradedRows > 1500 ? 24 : gradedRows > 600 ? 40 : RUNS
        const runsByPair = new Map<string, Float64Array[]>()
        const runsFor = (key: string): Float64Array[] => {
          let r = runsByPair.get(key)
          if (!r) { r = Array.from({ length: K }, () => new Float64Array(HORIZON + 1)); runsByPair.set(key, r) }
          return r
        }
        let mcSeed = 1

        // Emit a card's Monte Carlo schedule into one array: accumulate each sampled review's weight
        // (1/K, so the sum is the mean load) and tally per-run totals (in `runs`) for the band. Returns
        // the median day runs hit `maxReviews` (dormancy), else null. Honors `stopDay`.
        const emit = (
          arr: Float64Array, runs: Float64Array[], firstDay: number | null, S0: number, D0: number, retention: number, maxInt: number,
          model: RatingModel, startReps: number, calibration: number, opts?: { maxReviews?: number; stopDay?: number },
        ): number | null => {
          if (firstDay === null) return null
          const { steps, dormantDay } = monteCarloSteps(
            { stability: S0, difficulty: D0, firstReviewDay: firstDay, retention, maxInt, horizon: HORIZON, mix: mixForReps(model, startReps), model, startReps, calibration, K, fuzz: true, maxReviews: opts?.maxReviews, stopDay: opts?.stopDay },
            mcSeed++,
          )
          for (const st of steps) { arr[st.day]! += st.weight; runs[st.run!]![st.day]! += 1 }
          return dormantDay
        }
        // Smart variant: each review is typed while its interval is below `threshold`, else self-graded.
        const emitSmart = (
          typedArr: Float64Array, selfgArr: Float64Array, runs: Float64Array[], firstDay: number | null, S0: number, D0: number,
          retention: number, maxInt: number, threshold: number, model: RatingModel, startReps: number, calibration: number, opts?: { maxReviews?: number; stopDay?: number },
        ): number | null => {
          if (firstDay === null) return null
          const { steps, dormantDay } = monteCarloSteps(
            { stability: S0, difficulty: D0, firstReviewDay: firstDay, retention, maxInt, horizon: HORIZON, mix: mixForReps(model, startReps), model, startReps, calibration, K, fuzz: true, maxReviews: opts?.maxReviews, stopDay: opts?.stopDay },
            mcSeed++,
          )
          for (const st of steps) {
            const arr = st.intervalDays < threshold ? typedArr : selfgArr
            arr[st.day]! += st.weight
            runs[st.run!]![st.day]! += 1
          }
          return dormantDay
        }

        // ── Pass 1: measure each language's behaviour ─────────────────────────────
        // A maturity-varying RATING MODEL (how the again/hard/good/easy mix drifts as a card ages),
        // the average difficulty, and the MEASURED starting interval — all from the NON-accelerated
        // population (new cards go through the normal ladder; we don't assume the user will accelerate
        // future cards, and accelerated imports graduate at long intervals a fresh card never sees).
        // The starting interval samples the FRESHEST cards (reps ≤ 1) so it reflects the true ladder
        // graduation interval, not a since-grown one. Accelerated cards keep their own real D/S below.
        const diffSamples  = new Map<string, number[]>()
        const i0Samples    = new Map<string, { reps: number; intervalDays: number }[]>()
        const statesByPair = new Map<string, typeof deckStates[number]>()
        for (let di = 0; di < decks.length; di++) {
          const deck = decks[di]!, key = `${deck.sourceLanguage}|${deck.targetLanguage}`
          ;(statesByPair.get(key) ?? statesByPair.set(key, []).get(key)!).push(...deckStates[di]!)
          for (const s of deckStates[di]!) {
            if (s.reviewDirection === 'reverse' || !s.graduated) continue
            // Difficulty + starting-interval samples come from the NON-accelerated population only —
            // new cards go through the normal ladder, so their graduation interval/difficulty are what
            // a future card will look like (accelerated imports graduate at long intervals we mustn't
            // seed new cards from).
            if (s.acceleratedMode !== 'none') continue
            if (s.difficulty != null && s.difficulty > 0) {
              (diffSamples.get(key) ?? diffSamples.set(key, []).get(key)!).push(s.difficulty)
            }
            const iv = s.smartIntervalDays ?? s.typedIntervalDays ?? s.intervalDays
            if (iv != null && iv > 0) {
              (i0Samples.get(key) ?? i0Samples.set(key, []).get(key)!).push({ reps: s.reps, intervalDays: iv })
            }
          }
        }
        // Rating DRIFT model (mix as a function of maturity) + average difficulty + measured starting
        // interval, per language.
        const modelByPair = new Map<string, RatingModel>()
        const diffByPair  = new Map<string, number>()
        const i0ByPair    = new Map<string, number>()
        for (const [k] of cfg) {
          modelByPair.set(k, measureRatingModel(statesByPair.get(k) ?? []))
          const ds = diffSamples.get(k) ?? []
          diffByPair.set(k, ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : DEFAULT_DIFFICULTY)
          // A new card graduates from the ladder SHORT (~1 day) and is TYPED until its interval crosses
          // the smart threshold. On a mature deck with few/no freshly-graduated cards, the fresh-card
          // sample gets polluted by long-interval cards and the "starting" interval balloons — and if it
          // lands at/above the smart threshold, every new card would model as skipping the typed phase
          // (typed load → 0, which looked like "typing cards going away"). A graduation interval can't be
          // ≥ the threshold, so treat that as a bad measurement and fall back to the graduation interval.
          const c = cfg.get(k)!
          const i0Measured = estimateInitialInterval(i0Samples.get(k) ?? [], GRADUATION_I0_FALLBACK)
          i0ByPair.set(k, i0Measured >= c.smartThreshold ? GRADUATION_I0_FALLBACK : i0Measured)
        }

        // ── Pass 2: simulate existing graduated cards (real per-card D/S + language mix) ──
        for (let di = 0; di < decks.length; di++) {
          const deck = decks[di]!
          const states = deckStates[di]!
          const c = ensure(deck.sourceLanguage, deck.targetLanguage)
          const key = `${deck.sourceLanguage}|${deck.targetLanguage}`
          const model = modelByPair.get(key) ?? []
          const sr = seriesFor(key)
          const runs = runsFor(key)
          const fwd = new Map(states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]))
          const dormantDayByCard = new Map<string, number>()

          for (const s of states) {
            if (s.reviewDirection === 'reverse' || !s.graduated || s.dormant) continue
            const remaining = s.dormancyThreshold != null ? s.dormancyThreshold - s.reps : null
            if (remaining != null && remaining <= 0) continue
            const remOpts = remaining != null ? { maxReviews: remaining } : undefined
            let dormantDay: number | null = null
            const prodOn = c.typedOn || c.smartOn
            const dS = seedD(s.difficulty)
            if (prodOn && s.typedDueAt) {
              dormantDay = emit(sr.typed, runs, offset(s.typedDueAt ?? s.dueAt), seedS(s.stability, s.typedIntervalDays ?? s.intervalDays, c.typedP), dS, c.typedP, c.maxInt, model, s.reps, c.typedCal, remOpts)
            }
            if (prodOn && s.smartDueAt) {
              const sd = emitSmart(sr.typed, sr.selfg, runs, offset(s.smartDueAt), seedS(s.stability, s.smartIntervalDays ?? s.intervalDays, c.smartP), dS, c.smartP, c.maxInt, c.smartThreshold, model, s.reps, c.smartCal, remOpts)
              if (dormantDay == null) dormantDay = sd
            }
            if (c.selfgOn && s.recallDueAt) {
              const recallOpts = dormantDay != null ? { stopDay: dormantDay } : remOpts
              const rd = emit(sr.selfg, runs, offset(s.recallDueAt), seedS(s.stability, s.recallIntervalDays ?? s.intervalDays, c.selfgP), dS, c.selfgP, c.maxInt, model, s.reps, c.selfgCal, recallOpts)
              if (dormantDay == null) dormantDay = rd
            }
            if (dormantDay != null) dormantDayByCard.set(s.cardId, dormantDay)
          }

          for (const s of states) {
            if (s.reviewDirection !== 'reverse' || !s.graduated) continue
            const fwdState = fwd.get(s.cardId)
            if (fwdState?.dormant) continue
            if (!(c.reverseOn && fwdState?.graduated)) continue
            const stopDay = dormantDayByCard.get(s.cardId)
            emit(sr.recog, runs, offset(s.recallDueAt ?? s.dueAt), seedS(s.stability, s.recallIntervalDays ?? s.intervalDays, c.reverseP), seedD(s.difficulty), c.reverseP, c.maxInt, model, s.reps, c.reverseCal,
              stopDay != null ? { stopDay } : undefined)
          }
        }

        // ── New cards — intake follows the goal system day by day, seeded at each language's
        // measured initial interval and average difficulty, grown by Monte Carlo with its rating
        // mix. Each cohort day c introduces intake[c] cards, so daily load is the superposition
        // load(d) = Σ_c intake[c] · reviews(d − c). With flat intake that reduces to the old
        // dailyGoal · cum(t); with a deadline the cohorts STOP and the load tapers — the drop the
        // dashed markers on the chart explain. Iterates the trajectory's review days (sparse — a few
        // dozen per run) against cohort days, rather than densifying to an O(HORIZON²) convolution. ──
        const emitNew = (
          targetArr: Float64Array, runs: Float64Array[], retention: number, i0: number, d0: number, model: RatingModel, maxInt: number,
          intake: Float64Array, calibration: number, splitArr?: Float64Array, splitBelow?: number,
        ) => {
          // A new card starts life at reps 0, so its ratings are drawn from the YOUNG end of the drift
          // model and mature as the trajectory advances.
          const { steps } = monteCarloSteps({ stability: stabilityForInterval(i0, retention), difficulty: d0, firstReviewDay: Math.max(1, Math.round(i0)), retention, maxInt, horizon: HORIZON, mix: mixForReps(model, 0), model, startReps: 0, calibration, K, fuzz: true }, mcSeed++)
          for (const st of steps) {
            if (st.day > HORIZON) continue
            const useG = splitArr != null && splitBelow != null && st.intervalDays >= splitBelow
            const runArr = runs[st.run!]!
            const meanArr = useG ? splitArr! : targetArr
            const lastCohort = HORIZON - st.day
            for (let c = 0; c <= lastCohort; c++) {
              const w = intake[c]!
              if (w === 0) continue
              const d = c + st.day
              runArr[d]! += w
              meanArr[d]! += w / K
            }
          }
        }
        for (const [k, c] of cfg) {
          const intake = intakeByPair.get(k)
          if (!intake || !intake.some(v => v > 0)) continue
          const sr = seriesFor(k)
          // New cards seed at the language's MEASURED starting interval (freshest graduates) and climb
          // from there — so their early load is typed and grows realistically.
          const i0 = i0ByPair.get(k) ?? GRADUATION_I0_FALLBACK
          const d0 = diffByPair.get(k) ?? DEFAULT_DIFFICULTY
          const model = modelByPair.get(k) ?? []
          const runs = runsFor(k)
          if (c.typedOn)   emitNew(sr.typed, runs, c.typedP, i0, d0, model, c.maxInt, intake, c.typedCal)
          if (c.smartOn)   emitNew(sr.typed, runs, c.smartP, i0, d0, model, c.maxInt, intake, c.smartCal, sr.selfg, Math.min(c.smartThreshold, c.maxInt))
          if (c.selfgOn)   emitNew(sr.selfg, runs, c.selfgP, i0, d0, model, c.maxInt, intake, c.selfgCal)
          if (c.reverseOn) emitNew(sr.recog, runs, c.reverseP, i0, d0, model, c.maxInt, intake, c.reverseCal)
        }

        // Downsample each pair's series to STEP-day points (windowed average).
        const sampleDays: number[] = []
        for (let s = 0; s <= HORIZON; s += STEP) sampleDays.push(s)
        const downsample = (arr: Float64Array): number[] => sampleDays.map(s => {
          let sum = 0, n = 0
          for (let d = s; d < Math.min(s + STEP, HORIZON + 1); d++) { sum += arr[d]!; n++ }
          return n ? sum / n : 0
        })
        const pairSeries: PairSeries[] = [...series.entries()]
          .map(([k, v]) => ({ key: k, label: langName(k.split('|')[0]!), flag: langFlag(k.split('|')[0]!), typed: downsample(v.typed), selfg: downsample(v.selfg), recog: downsample(v.recog) }))
          .filter(p => p.typed.some(x => x > 0) || p.selfg.some(x => x > 0) || p.recog.some(x => x > 0))
        const models: PairModel[] = [...diffByPair.entries()]
          .filter(([k]) => pairSeries.some(p => p.key === k))
          .map(([k, difficulty]) => ({ key: k, label: langName(k.split('|')[0]!), flag: langFlag(k.split('|')[0]!), days: i0ByPair.get(k) ?? GRADUATION_I0_FALLBACK, difficulty, drift: driftLabel(modelByPair.get(k) ?? []) }))

        // Confidence band per selection: downsample each run, then take p10/p90 across runs per window.
        // Stored per pair key + '__all__' (runs summed across pairs by index) so every language filter
        // — and the all-languages view — gets its own band.
        const bandFrom = (runs: Float64Array[]): { lo: number[]; hi: number[] } => {
          const down = runs.map(downsample)
          const lo: number[] = [], hi: number[] = []
          for (let i = 0; i < sampleDays.length; i++) {
            const col = down.map(r => r[i]!)
            lo.push(percentile(col, 0.1)); hi.push(percentile(col, 0.9))
          }
          return { lo, hi }
        }
        const bands: Record<string, { lo: number[]; hi: number[] }> = {}
        const allRuns = Array.from({ length: K }, () => new Float64Array(HORIZON + 1))
        for (const [key, runs] of runsByPair) {
          bands[key] = bandFrom(runs)
          for (let k = 0; k < K; k++) { const a = allRuns[k]!, r = runs[k]!; for (let d = 0; d <= HORIZON; d++) a[d]! += r[d]! }
        }
        bands.__all__ = bandFrom(allRuns)

        if (!cancelled) setData({ pairs: pairSeries, sampleDays, models, hasGoals: anyGoal, bands, markers })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Points for the currently-selected filter (all pairs, or one).
  const points = useMemo(() => {
    if (!data) return null
    const chosen = filterKey ? data.pairs.filter(p => p.key === filterKey) : data.pairs
    return data.sampleDays.map((day, i) => {
      let typed = 0, selfg = 0, recog = 0
      for (const p of chosen) { typed += p.typed[i]!; selfg += p.selfg[i]!; recog += p.recog[i]! }
      return { day, typed, selfg, recog, total: typed + selfg + recog }
    })
  }, [data, filterKey])

  const svg = useMemo(() => {
    if (!points) return null
    const W = 720, H = 280, mL = 44, mR = 12, mT = 12, mB = 26
    const band = data ? (data.bands[filterKey ?? '__all__']?.hi ?? []) : []
    const maxY = Math.max(10, ...points.map(p => p.total), ...band) * 1.1
    const x = (day: number) => mL + (day / HORIZON) * (W - mL - mR)
    const y = (v: number) => H - mB - (v / maxY) * (H - mT - mB)
    const path = (key: 'typed' | 'selfg' | 'recog' | 'total') =>
      points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.day).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ')
    return { W, H, mL, mR, mT, mB, maxY, x, y, path, yTicks: 4 }
  }, [points, data, filterKey])

  if (error) return <p className="text-sm text-danger">Couldn&apos;t build projection: {error}</p>
  if (!data || !points || !svg) return <p className="text-sm text-ink-faint">Building projection…</p>

  const { W, H, mL, mB, maxY, x, y, path, yTicks } = svg
  const xTicks = [
    { day: 0, label: 'now' }, { day: 182, label: '6 mo' },
    { day: 365, label: '1 yr' }, { day: 547, label: '18 mo' }, { day: 730, label: '2 yr' },
  ]

  // Hover → nearest sample index (for the guide line + per-language pie).
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = svgRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Map cursor into viewBox user units via the SVG's CTM — a plain rect.width ratio is wrong when
    // preserveAspectRatio letterboxes the drawing (w-full + maxHeight caps a wide chart and centres it).
    const _ctm = el.getScreenCTM()
    if (!_ctm) return
    const _pt = el.createSVGPoint(); _pt.x = e.clientX; _pt.y = e.clientY
    const relX = _pt.matrixTransform(_ctm.inverse()).x
    const day = ((relX - mL) / (W - mL - svg.mR)) * HORIZON
    if (day < 0 || day > HORIZON) { setHover(null); return }
    let bi = 0
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.day - day) < Math.abs(points[bi]!.day - day)) bi = i
    setHover({ i: bi, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const hoverPt = hover ? points[hover.i] : null
  // Distinct color per language (honoring overrides), stable across snapshots regardless of slice order.
  const colorMap = assignLanguageColors(data.pairs.map(p => p.key.split('|')[0]!), langColors)
  const pieSlices = hover && !filterKey
    ? data.pairs.map(p => ({ label: p.label, flag: p.flag, value: p.typed[hover.i]! + p.selfg[hover.i]! + p.recog[hover.i]!, color: colorMap[p.key.split('|')[0]!]! }))
        .filter(s => s.value > 0.05).sort((a, b) => b.value - a.value)
    : []

  return (
    <div className="flex flex-col gap-2">
      {/* Language filter */}
      {data.pairs.length > 1 && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          <button onClick={() => setFilterKey(null)}
            className={`px-2 py-0.5 rounded-full border ${filterKey === null ? 'bg-accent/20 border-accent text-ink' : 'border-surface-border text-ink-muted hover:text-ink'}`}>All languages</button>
          {data.pairs.map(p => (
            <button key={p.key} onClick={() => setFilterKey(p.key)}
              className={`px-2 py-0.5 rounded-full border inline-flex items-center gap-1.5 ${filterKey === p.key ? 'bg-accent/20 border-accent text-ink' : 'border-surface-border text-ink-muted hover:text-ink'}`}>
              <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: colorMap[p.key.split('|')[0]!] }} />
              {p.flag} {p.label}
            </button>
          ))}
        </div>
      )}
      {!data.hasGoals && (
        <p className="text-xs text-warning">No goals or schedules set — the projection only reflects your existing cards. Set goals in Settings → Daily goals to include future learning.</p>
      )}

      <div className="relative">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 320 }}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {/* y gridlines + labels */}
          {Array.from({ length: yTicks + 1 }, (_, i) => {
            const v = (maxY / yTicks) * i
            return (
              <g key={i}>
                <line x1={mL} y1={y(v)} x2={W - 12} y2={y(v)} stroke="currentColor" className="text-surface-border" strokeWidth={1} opacity={0.4} />
                <text x={mL - 6} y={y(v) + 3} textAnchor="end" className="fill-ink-faint" fontSize={10}>{Math.round(v)}</text>
              </g>
            )
          })}
          {/* x labels */}
          {xTicks.map(t => (
            <text key={t.day} x={x(t.day)} y={H - mB + 16} textAnchor="middle" className="fill-ink-faint" fontSize={10}>{t.label}</text>
          ))}
          {/* Goal deadlines — the days new-word intake for a language STOPS. Without these the load
              tapering after a deadline looks like a bug in the curve rather than a goal being met.
              Labels stagger vertically so adjacent deadlines stay readable. */}
          {data.markers
            .filter(m => !filterKey || m.key === filterKey)
            .map((m, i) => {
              const color = colorMap[m.key.split('|')[0]!] ?? '#888888'
              const anchorEnd = x(m.day) > W - 120   // keep late-horizon labels inside the chart
              return (
                <g key={`${m.key}-${m.day}`}>
                  <line x1={x(m.day)} y1={svg.mT} x2={x(m.day)} y2={H - mB}
                    stroke={color} strokeWidth={1} strokeDasharray="5 4" opacity={0.7} />
                  <text
                    x={x(m.day) + (anchorEnd ? -4 : 4)}
                    y={svg.mT + 9 + (i % 3) * 11}
                    textAnchor={anchorEnd ? 'end' : 'start'}
                    fontSize={9}
                    fill={color}
                  >
                    {`${m.label} · ${shortForecastDate(m.day)}`}
                  </text>
                </g>
              )
            })}
          {/* hover guide */}
          {hoverPt && (
            <g>
              <line x1={x(hoverPt.day)} y1={svg.mT} x2={x(hoverPt.day)} y2={H - mB} stroke="currentColor" className="text-ink-faint" strokeWidth={1} opacity={0.5} strokeDasharray="3 3" />
              <circle cx={x(hoverPt.day)} cy={y(hoverPt.total)} r={3} fill="#E6E8F5" />
            </g>
          )}
          {/* p10–p90 confidence band on total (for the selected language, or all) */}
          {(() => {
            const b = data.bands[filterKey ?? '__all__']
            if (!b || b.lo.length === 0) return null
            return (
              <path
                d={`${data.sampleDays.map((day, i) => `${i === 0 ? 'M' : 'L'}${x(day).toFixed(1)},${y(b.hi[i]!).toFixed(1)}`).join(' ')} ${data.sampleDays.map((day, i) => ({ day, i })).reverse().map(({ day, i }) => `L${x(day).toFixed(1)},${y(b.lo[i]!).toFixed(1)}`).join(' ')} Z`}
                fill="#E6E8F5" opacity={0.09} stroke="none"
              />
            )
          })()}
          {/* series */}
          <path d={path('total')} fill="none" stroke="#E6E8F5" strokeWidth={2.5} />
          <path d={path('typed')} fill="none" stroke="#6640FF" strokeWidth={2} opacity={0.9} />
          <path d={path('selfg')} fill="none" stroke="#F07890" strokeWidth={2} opacity={0.9} />
          <path d={path('recog')} fill="none" stroke="#2CBCBC" strokeWidth={2} opacity={0.9} />
        </svg>

        {/* Per-language pie on hover (only with no filter active). */}
        {hover && hoverPt && pieSlices.length > 0 && (
          <div className="absolute pointer-events-none z-10 rounded-lg border border-surface-border bg-surface-raised/95 backdrop-blur px-3 py-2 shadow-lg"
            style={{ left: Math.min(hover.x + 12, 520), top: Math.max(4, hover.y - 60) }}>
            <div className="text-xs text-ink-muted text-center mb-1.5 pb-1.5 border-b border-surface-border">{forecastDate(hoverPt.day)}</div>
            <PieChart slices={pieSlices} />
          </div>
        )}
      </div>

      {/* legend — appends the hovered day's counts, e.g. "Total (378)" */}
      <div className="flex flex-wrap gap-4 text-xs">
        {([
          { c: '#E6E8F5', label: 'Total', key: 'total' },
          { c: '#6640FF', label: 'Typed', key: 'typed' },
          { c: '#F07890', label: 'Self-graded', key: 'selfg' },
          { c: '#2CBCBC', label: 'Reverse', key: 'recog' },
        ] as const).map(l => (
          <span key={l.label} className="flex items-center gap-1.5 text-ink-muted">
            <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: l.c }} />
            {l.label}{hoverPt ? ` (${Math.round(hoverPt[l.key])})` : ''}
          </span>
        ))}
      </div>

      {/* per-language model fed into the forecast: new cards enter at the graduation interval, then grow
          with each language's measured difficulty + rating mix */}
      {data.models.length > 0 && (
        <p className="text-xs text-ink-faint">
          <span className="text-ink-muted">Per-language model</span> — new cards enter at each language&apos;s measured starting interval and grow by its measured average difficulty + a maturity-varying rating mix (again/hard/good/easy that drifts as cards age):{' '}
          {(filterKey ? data.models.filter(s => s.key === filterKey) : data.models)
            .map(s => `${s.flag} ${s.label} · starts ${s.days < 1.5 ? s.days.toFixed(1) : Math.round(s.days)}d · D ${s.difficulty.toFixed(1)}${s.drift ? ` · ${s.drift}` : ''}`).join('   ·   ')}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 text-xs text-ink-muted mt-1">
        {[{ day: 365, label: '1 year' }, { day: 730, label: '2 years' }].map(mk => {
          const p = points.reduce((best, cur) => Math.abs(cur.day - mk.day) < Math.abs(best.day - mk.day) ? cur : best)
          return (
            <div key={mk.day}>
              <span className="text-ink">At {mk.label}:</span> ~{Math.round(p.total)}/day
              <span className="text-ink-faint"> ({Math.round(p.typed)} typed · {Math.round(p.selfg)} self · {Math.round(p.recog)} reverse)</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Small SVG pie with per-slice labels ("🇪🇸 Spanish 12/day"). Each slice carries its own
 *  (per-language) color so a language's color is consistent across every snapshot. */
function PieChart({ slices }: { slices: { label: string; flag: string; value: number; color: string }[] }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  const R = 46, C = 52
  let ang = -Math.PI / 2
  const arcs = slices.map(s => {
    const frac = total > 0 ? s.value / total : 0
    const a0 = ang, a1 = ang + frac * Math.PI * 2
    ang = a1
    const large = a1 - a0 > Math.PI ? 1 : 0
    const p0 = [C + R * Math.cos(a0), C + R * Math.sin(a0)]
    const p1 = [C + R * Math.cos(a1), C + R * Math.sin(a1)]
    const d = frac >= 0.999
      ? `M${C - R},${C} A${R},${R} 0 1 1 ${C + R},${C} A${R},${R} 0 1 1 ${C - R},${C}Z`
      : `M${C},${C} L${p0[0]!.toFixed(1)},${p0[1]!.toFixed(1)} A${R},${R} 0 ${large} 1 ${p1[0]!.toFixed(1)},${p1[1]!.toFixed(1)} Z`
    return { d, color: s.color }
  })
  return (
    <div className="flex items-center gap-3">
      <svg width={104} height={104} viewBox="0 0 104 104">
        {arcs.map((a, i) => <path key={i} d={a.d} fill={a.color} stroke="var(--surface-raised, #202240)" strokeWidth={1} />)}
      </svg>
      <div className="flex flex-col gap-0.5 text-[11px] whitespace-nowrap">
        {slices.map((s, i) => (
          <span key={s.label + i} className="flex items-center gap-1.5 text-ink-muted">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
            {s.flag} {s.label} <span className="text-ink font-medium">{Math.round(s.value)}/day</span>
          </span>
        ))}
      </div>
    </div>
  )
}
