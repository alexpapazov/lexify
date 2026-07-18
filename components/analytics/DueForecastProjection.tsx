'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { createClient } from '@/lib/supabase/client'
import { langName, langFlag, assignLanguageColors } from '@/lib/languages'
import { monteCarloSteps, percentile, estimateInitialInterval, measureRatingMix, seedStability, seedDifficulty, DEFAULT_RATING_MIX, DEFAULT_I0, DEFAULT_DIFFICULTY, stabilityForInterval, type RatingMix } from '@/lib/forecastFsrs'

// Forward projection of daily "Due Now" load, split into Typed / Self-graded / Reverse / Total,
// simulated on the live FSRS stability model by MONTE CARLO. Each card is played forward many times;
// on every review a rating is drawn from that language's measured mix (again/hard/good/easy), stability
// and difficulty advance by the real engine, and the next interval is fuzzed like the live scheduler.
// Averaging the runs gives an unbiased mean (the mean-field stepper under-counted load via Jensen's
// inequality); the spread across runs gives a p10–p90 confidence band. Existing cards seed from their
// own real difficulty/stability (accelerated cards modelled as-is); new cards from daily goals seed from
// the per-language averages of NON-accelerated cards. New-card intake is capped at each language's
// remaining unlearned cards (finite decks), so the long tail doesn't grow forever.

const HORIZON = 730          // 2 years
const STEP = 14              // chart sampling / smoothing window (days)
const RUNS = 64              // Monte Carlo trajectories per card/track

interface PairCfg {
  typedP: number; selfgP: number; smartP: number; reverseP: number
  typedOn: boolean; selfgOn: boolean; smartOn: boolean; reverseOn: boolean
  smartThreshold: number
  maxInt: number; dailyGoal: number
  src: string; tgt: string
}

interface PairSeries { key: string; label: string; flag: string; typed: number[]; selfg: number[]; recog: number[] }
interface PairModel { key: string; label: string; flag: string; days: number; difficulty: number }
interface Forecast { pairs: PairSeries[]; sampleDays: number[]; models: PairModel[]; hasGoals: boolean; bands: Record<string, { lo: number[]; hi: number[] }> }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function ordinal(n: number): string {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  return `${n}${(['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`
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

        void supabase.from('profiles').select('language_colors').eq('user_id', uid).single()
          .then(r => { if (!cancelled) setLangColors((r.data?.language_colors as Record<string, string> | null) ?? {}) })

        const [decks, paramRows, pairs] = await Promise.all([
          new SupabaseDeckRepository().list(uid),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
          new SupabaseLanguagePairRepository().list(uid),
        ])

        // Per-pair config keyed `${src}|${tgt}`.
        const cfg = new Map<string, PairCfg>()
        const ensure = (src: string, tgt: string): PairCfg => {
          const k = `${src}|${tgt}`
          let c = cfg.get(k)
          if (!c) { c = { typedP: 0.85, selfgP: 0.9, smartP: 0.85, reverseP: 0.9, typedOn: true, selfgOn: true, smartOn: false, reverseOn: true, smartThreshold: 20, maxInt: 1460, dailyGoal: 0, src, tgt }; cfg.set(k, c) }
          return c
        }
        for (const r of paramRows) {
          const c = ensure(r.sourceLanguage, r.targetLanguage)
          c.maxInt = r.maxIntervalDays
          const p = r.recentRetentionRate ?? undefined
          if (r.answerField === 'forward_typed')  { c.typedOn = r.forwardTypedEnabled;  c.smartThreshold = r.smartTypingThresholdDays; if (p) c.typedP = p }
          if (r.answerField === 'forward_recall') { c.selfgOn = r.forwardRecallEnabled; if (p) c.selfgP = p }
          if (r.answerField === 'forward_smart')  { c.smartOn = r.forwardSmartEnabled;  if (p) c.smartP = p }
          if (r.answerField === 'reverse_recall') { c.reverseOn = r.reverseRecallEnabled; if (p) c.reverseP = p }
        }
        let anyGoal = false
        for (const pr of pairs) {
          const c = ensure(pr.sourceLanguage, pr.targetLanguage)
          const g = pr.goals
          if (g) {
            const sum = [0, 1, 2, 3, 4, 5, 6].reduce((s, d) => s + (g[String(d)] ?? 0), 0)
            c.dailyGoal = sum / 7
            if (sum > 0) anyGoal = true
          }
        }

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
        const deckStates = await Promise.all(decks.map(d => stateRepo.listByDeck(uid, d.id)))

        // Per-run total-load accumulators (K realizations) → the p10–p90 confidence band, kept PER
        // PAIR so each language filter gets its own band (the all-languages band sums them per run).
        // Each card contributes its run-k sample to system-run k; independent RNG streams make run k a
        // valid i.i.d. draw. Scale K down on large libraries to bound compute.
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
          arr: Float64Array, runs: Float64Array[], firstDay: number | null, S0: number, D0: number, retention: number, maxInt: number, mix: RatingMix,
          opts?: { maxReviews?: number; stopDay?: number },
        ): number | null => {
          if (firstDay === null) return null
          const { steps, dormantDay } = monteCarloSteps(
            { stability: S0, difficulty: D0, firstReviewDay: firstDay, retention, maxInt, horizon: HORIZON, mix, K, fuzz: true, maxReviews: opts?.maxReviews, stopDay: opts?.stopDay },
            mcSeed++,
          )
          for (const st of steps) { arr[st.day]! += st.weight; runs[st.run!]![st.day]! += 1 }
          return dormantDay
        }
        // Smart variant: each review is typed while its interval is below `threshold`, else self-graded.
        const emitSmart = (
          typedArr: Float64Array, selfgArr: Float64Array, runs: Float64Array[], firstDay: number | null, S0: number, D0: number,
          retention: number, maxInt: number, threshold: number, mix: RatingMix, opts?: { maxReviews?: number; stopDay?: number },
        ): number | null => {
          if (firstDay === null) return null
          const { steps, dormantDay } = monteCarloSteps(
            { stability: S0, difficulty: D0, firstReviewDay: firstDay, retention, maxInt, horizon: HORIZON, mix, K, fuzz: true, maxReviews: opts?.maxReviews, stopDay: opts?.stopDay },
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
        // Rating mix from every graduated forward card; initial interval + average difficulty from the
        // NON-accelerated population only (new cards go through the normal pipeline — we don't assume
        // the user will accelerate future cards). Accelerated cards keep their own real D/S below.
        const initSamples  = new Map<string, { reps: number; intervalDays: number }[]>()
        const diffSamples  = new Map<string, number[]>()
        const statesByPair = new Map<string, typeof deckStates[number]>()
        for (let di = 0; di < decks.length; di++) {
          const deck = decks[di]!, key = `${deck.sourceLanguage}|${deck.targetLanguage}`
          ;(statesByPair.get(key) ?? statesByPair.set(key, []).get(key)!).push(...deckStates[di]!)
          for (const s of deckStates[di]!) {
            if (s.reviewDirection === 'reverse' || !s.graduated) continue
            if (s.acceleratedMode === 'none') {
              if (s.difficulty != null && s.difficulty > 0) (diffSamples.get(key) ?? diffSamples.set(key, []).get(key)!).push(s.difficulty)
              const initInt = s.scheduledIntervalDays ?? s.typedIntervalDays ?? s.smartIntervalDays ?? s.intervalDays
              if (initInt && initInt > 0) (initSamples.get(key) ?? initSamples.set(key, []).get(key)!).push({ reps: s.reps, intervalDays: initInt })
            }
          }
        }
        const mixByPair  = new Map<string, RatingMix>()
        const diffByPair = new Map<string, number>()
        const initI0Map  = new Map<string, number>()
        for (const [k] of cfg) {
          mixByPair.set(k, measureRatingMix(statesByPair.get(k) ?? []))
          const ds = diffSamples.get(k) ?? []
          diffByPair.set(k, ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : DEFAULT_DIFFICULTY)
          initI0Map.set(k, estimateInitialInterval(initSamples.get(k) ?? [], DEFAULT_I0))
        }

        // ── Pass 2: simulate existing graduated cards (real per-card D/S + language mix) ──
        for (let di = 0; di < decks.length; di++) {
          const deck = decks[di]!
          const states = deckStates[di]!
          const c = ensure(deck.sourceLanguage, deck.targetLanguage)
          const key = `${deck.sourceLanguage}|${deck.targetLanguage}`
          const mix = mixByPair.get(key) ?? DEFAULT_RATING_MIX
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
              dormantDay = emit(sr.typed, runs, offset(s.typedDueAt ?? s.dueAt), seedS(s.stability, s.typedIntervalDays ?? s.intervalDays, c.typedP), dS, c.typedP, c.maxInt, mix, remOpts)
            }
            if (prodOn && s.smartDueAt) {
              const sd = emitSmart(sr.typed, sr.selfg, runs, offset(s.smartDueAt), seedS(s.stability, s.smartIntervalDays ?? s.intervalDays, c.smartP), dS, c.smartP, c.maxInt, c.smartThreshold, mix, remOpts)
              if (dormantDay == null) dormantDay = sd
            }
            if (c.selfgOn && s.recallDueAt) {
              const recallOpts = dormantDay != null ? { stopDay: dormantDay } : remOpts
              const rd = emit(sr.selfg, runs, offset(s.recallDueAt), seedS(s.stability, s.recallIntervalDays ?? s.intervalDays, c.selfgP), dS, c.selfgP, c.maxInt, mix, recallOpts)
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
            emit(sr.recog, runs, offset(s.recallDueAt ?? s.dueAt), seedS(s.stability, s.recallIntervalDays ?? s.intervalDays, c.reverseP), seedD(s.difficulty), c.reverseP, c.maxInt, mix,
              stopDay != null ? { stopDay } : undefined)
          }
        }

        // ── New cards — renewal from daily goals, seeded at each language's measured initial interval
        // and average difficulty, grown by Monte Carlo with its rating mix. A representative card's
        // per-run cumulative reviews are superposed over daily cohorts (continuous intake), so daily
        // load at age t = dailyGoal · cum(t). The daily goal is treated as ongoing learning. ──
        const emitNew = (
          targetArr: Float64Array, runs: Float64Array[], retention: number, i0: number, d0: number, mix: RatingMix, maxInt: number,
          dailyGoal: number, splitArr?: Float64Array, splitBelow?: number,
        ) => {
          const { steps } = monteCarloSteps({ stability: stabilityForInterval(i0, retention), difficulty: d0, firstReviewDay: Math.max(1, Math.round(i0)), retention, maxInt, horizon: HORIZON, mix, K, fuzz: true }, mcSeed++)
          const tRun = Array.from({ length: K }, () => new Float64Array(HORIZON + 1))
          const gRun = splitBelow != null ? Array.from({ length: K }, () => new Float64Array(HORIZON + 1)) : null
          for (const st of steps) {
            if (st.day > HORIZON) continue
            const useG = gRun && splitBelow != null && st.intervalDays >= splitBelow
            ;(useG ? gRun! : tRun)[st.run!]![st.day]! += 1
          }
          for (let k = 0; k < K; k++) {   // per-run prefix sums
            let ct = 0, cg = 0
            for (let d = 0; d <= HORIZON; d++) { ct += tRun[k]![d]!; tRun[k]![d] = ct; if (gRun) { cg += gRun[k]![d]!; gRun[k]![d] = cg } }
          }
          for (let d = 0; d <= HORIZON; d++) {
            let mt = 0, mg = 0
            for (let k = 0; k < K; k++) {
              const t = tRun[k]![d]!
              const g = gRun ? gRun[k]![d]! : 0
              mt += t; mg += g
              runs[k]![d]! += dailyGoal * (t + g)
            }
            targetArr[d]! += dailyGoal * mt / K
            if (splitArr && gRun) splitArr[d]! += dailyGoal * mg / K
          }
        }
        for (const [k, c] of cfg) {
          if (c.dailyGoal <= 0) continue
          const sr = seriesFor(k)
          const i0 = initI0Map.get(k) ?? DEFAULT_I0
          const d0 = diffByPair.get(k) ?? DEFAULT_DIFFICULTY
          const mix = mixByPair.get(k) ?? DEFAULT_RATING_MIX
          const runs = runsFor(k)
          if (c.typedOn)   emitNew(sr.typed, runs, c.typedP, i0, d0, mix, c.maxInt, c.dailyGoal)
          if (c.smartOn)   emitNew(sr.typed, runs, c.smartP, i0, d0, mix, c.maxInt, c.dailyGoal, sr.selfg, Math.min(c.smartThreshold, c.maxInt))
          if (c.selfgOn)   emitNew(sr.selfg, runs, c.selfgP, i0, d0, mix, c.maxInt, c.dailyGoal)
          if (c.reverseOn) emitNew(sr.recog, runs, c.reverseP, i0, d0, mix, c.maxInt, c.dailyGoal)
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
        const models: PairModel[] = [...initI0Map.entries()]
          .filter(([k]) => pairSeries.some(p => p.key === k))
          .map(([k, days]) => ({ key: k, label: langName(k.split('|')[0]!), flag: langFlag(k.split('|')[0]!), days, difficulty: diffByPair.get(k) ?? DEFAULT_DIFFICULTY }))

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

        if (!cancelled) setData({ pairs: pairSeries, sampleDays, models, hasGoals: anyGoal, bands })
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
    const relX = ((e.clientX - rect.left) / rect.width) * W
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
        <p className="text-xs text-warning">No daily goals set — the projection only reflects your existing cards. Set per-language goals in Settings to include future learning.</p>
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

      {/* measured per-language model (initial interval + average difficulty), fed into the forecast */}
      {data.models.length > 0 && (
        <p className="text-xs text-ink-faint">
          <span className="text-ink-muted">Per-language model</span> (measured from your cards — initial interval &amp; average difficulty, plus each language&apos;s rating mix):{' '}
          {(filterKey ? data.models.filter(s => s.key === filterKey) : data.models)
            .map(s => `${s.flag} ${s.label} ${s.days % 1 === 0 ? s.days : s.days.toFixed(1)}d · D ${s.difficulty.toFixed(1)}`).join('  ·  ')}
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
