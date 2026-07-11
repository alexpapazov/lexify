'use client'

import { useEffect, useMemo, useState } from 'react'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { createClient } from '@/lib/supabase/client'

// Forward projection of daily "Due Now" load, split into four lines: Typed
// production, Self-graded production (recall + smart-typing past its threshold),
// Reverse recognition, and Total. Blends:
//   • existing graduated cards — simulated forward from their real due dates
//     and intervals, growing by each pair's calibrated multiplier;
//   • new cards — added at each pair's average daily goal (from Settings),
//     contributing via the renewal model N·(1/p)·stages(t).
// Smart-typing cards are typed while their interval is below the pair's threshold,
// then self-graded — each simulated review is routed accordingly.

const HORIZON = 730          // 2 years
const STEP = 14              // chart sampling / smoothing window (days)
const I0 = 3                 // assumed post-graduation interval for new cards

interface PairCfg {
  typedM: number; selfgM: number; smartM: number; reverseM: number
  typedP: number; selfgP: number; smartP: number; reverseP: number
  typedOn: boolean; selfgOn: boolean; smartOn: boolean; reverseOn: boolean
  smartThreshold: number
  maxInt: number; dailyGoal: number
}

interface ChartPoint { day: number; typed: number; selfg: number; recog: number; total: number }

function stages(t: number, m: number, maxInt: number): number {
  if (t <= 0 || m <= 1) return 0
  const s = Math.log(1 + (t * (m - 1)) / I0) / Math.log(m)
  const cap = Math.log(maxInt / I0) / Math.log(m)
  return Math.min(s, cap)
}

export function DueForecastProjection() {
  const [points, setPoints] = useState<ChartPoint[] | null>(null)
  const [hasGoals, setHasGoals] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setError('Not signed in'); return }
        const uid = session.user.id

        const [decks, paramRows, pairs] = await Promise.all([
          new SupabaseDeckRepository().list(uid),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
          new SupabaseLanguagePairRepository().list(uid),
        ])

        // Per-pair config keyed `${src}|${tgt}`.
        const cfg = new Map<string, PairCfg>()
        const ensure = (k: string): PairCfg => {
          let c = cfg.get(k)
          if (!c) { c = { typedM: 2.25, selfgM: 2.25, smartM: 2.25, reverseM: 2.25, typedP: 0.85, selfgP: 0.9, smartP: 0.85, reverseP: 0.9, typedOn: true, selfgOn: true, smartOn: false, reverseOn: true, smartThreshold: 20, maxInt: 1460, dailyGoal: 0 }; cfg.set(k, c) }
          return c
        }
        for (const r of paramRows) {
          const c = ensure(`${r.sourceLanguage}|${r.targetLanguage}`)
          c.maxInt = r.maxIntervalDays
          const p = r.recentRetentionRate ?? undefined
          if (r.answerField === 'forward_typed')  { c.typedM = r.goodIdeal;  c.typedOn = r.forwardTypedEnabled;  c.smartThreshold = r.smartTypingThresholdDays; if (p) c.typedP = p }
          if (r.answerField === 'forward_recall') { c.selfgM = r.goodIdeal;  c.selfgOn = r.forwardRecallEnabled; if (p) c.selfgP = p }
          if (r.answerField === 'forward_smart')  { c.smartM = r.goodIdeal;  c.smartOn = r.forwardSmartEnabled;  if (p) c.smartP = p }
          if (r.answerField === 'reverse_recall') { c.reverseM = r.goodIdeal; c.reverseOn = r.reverseRecallEnabled; if (p) c.reverseP = p }
        }
        let anyGoal = false
        for (const pr of pairs) {
          const c = ensure(`${pr.sourceLanguage}|${pr.targetLanguage}`)
          const g = pr.goals
          if (g) {
            const sum = [0, 1, 2, 3, 4, 5, 6].reduce((s, d) => s + (g[String(d)] ?? 0), 0)
            c.dailyGoal = sum / 7
            if (sum > 0) anyGoal = true
          }
        }

        const typed = new Float64Array(HORIZON + 1)
        const selfg = new Float64Array(HORIZON + 1)
        const recog = new Float64Array(HORIZON + 1)
        const now = Date.now()
        const DAY = 86_400_000
        const offset = (iso: string | null | undefined) => iso ? Math.max(0, Math.round((new Date(iso).getTime() - now) / DAY)) : null

        // Simulates a card's future reviews into `arr`. `maxReviews` caps how many
        // future reviews it emits before going dormant (returns the day it went
        // dormant); `stopDay` halts it once dormant (from another track). Returns the
        // dormant day when `maxReviews` was hit, else null.
        const simulate = (
          arr: Float64Array, startDay: number | null, interval: number | null | undefined,
          m: number, maxInt: number, opts?: { maxReviews?: number; stopDay?: number },
        ): number | null => {
          if (startDay === null || m <= 1) return null
          let day = startDay
          let intv = Math.max(0.5, interval || 1)
          let guard = 0
          let count = 0
          while (day <= HORIZON && guard++ < 300) {
            if (opts?.stopDay != null && day > opts.stopDay) break
            arr[day] = (arr[day] ?? 0) + 1
            count++
            if (opts?.maxReviews != null && count >= opts.maxReviews) return day
            intv = Math.min(intv * m, maxInt)
            day += Math.max(1, Math.round(intv))
          }
          return null
        }

        // Smart-typing variant: routes each review to `typedArr` while the interval is
        // below `threshold`, else `selfgArr`. Same maxReviews/stopDay semantics.
        const simulateSmart = (
          typedArr: Float64Array, selfgArr: Float64Array, startDay: number | null,
          interval: number | null | undefined, m: number, maxInt: number, threshold: number,
          opts?: { maxReviews?: number; stopDay?: number },
        ): number | null => {
          if (startDay === null || m <= 1) return null
          let day = startDay
          let intv = Math.max(0.5, interval || 1)
          let guard = 0
          let count = 0
          while (day <= HORIZON && guard++ < 300) {
            if (opts?.stopDay != null && day > opts.stopDay) break
            const arr = intv < threshold ? typedArr : selfgArr
            arr[day] = (arr[day] ?? 0) + 1
            count++
            if (opts?.maxReviews != null && count >= opts.maxReviews) return day
            intv = Math.min(intv * m, maxInt)
            day += Math.max(1, Math.round(intv))
          }
          return null
        }

        // Existing graduated cards — simulate their real schedules forward.
        // Dormancy: already-dormant cards are excluded entirely; a card with a
        // future dormancy_threshold stops contributing once its remaining
        // production reviews run out (and its reverse row stops the same day).
        const stateRepo = new SupabaseCardStateRepository()
        const deckStates = await Promise.all(decks.map(d => stateRepo.listByDeck(uid, d.id)))
        for (let di = 0; di < decks.length; di++) {
          const deck = decks[di]!
          const states = deckStates[di]!
          const c = ensure(`${deck.sourceLanguage}|${deck.targetLanguage}`)
          const fwd = new Map(states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]))
          // The day each card goes dormant (production threshold reached), so the
          // reverse row can be stopped at the same point.
          const dormantDayByCard = new Map<string, number>()

          // Forward (production) pass first, so reverse rows can read dormant days.
          for (const s of states) {
            if (s.reviewDirection === 'reverse' || !s.graduated || s.dormant) continue
            // remaining production reviews before dormancy (null = never goes dormant).
            const remaining = s.dormancyThreshold != null ? s.dormancyThreshold - s.reps : null
            if (remaining != null && remaining <= 0) continue   // already at/over threshold → treat as dormant
            const remOpts = remaining != null ? { maxReviews: remaining } : undefined
            let dormantDay: number | null = null
            // Typed and smart are mutually exclusive; only the active one has a due date.
            if (c.typedOn && s.typedDueAt) {
              dormantDay = simulate(typed, offset(s.typedDueAt ?? s.dueAt), s.typedIntervalDays ?? s.intervalDays, c.typedM, c.maxInt, remOpts)
            }
            if (c.smartOn && s.smartDueAt) {
              const sd = simulateSmart(typed, selfg, offset(s.smartDueAt), s.smartIntervalDays ?? s.intervalDays, c.smartM, c.maxInt, c.smartThreshold, remOpts)
              if (dormantDay == null) dormantDay = sd
            }
            if (c.selfgOn && s.recallDueAt) {
              const recallOpts = dormantDay != null ? { stopDay: dormantDay } : remOpts
              const rd = simulate(selfg, offset(s.recallDueAt), s.recallIntervalDays ?? s.intervalDays, c.selfgM, c.maxInt, recallOpts)
              if (dormantDay == null) dormantDay = rd
            }
            if (dormantDay != null) dormantDayByCard.set(s.cardId, dormantDay)
          }

          // Reverse (recognition) pass.
          for (const s of states) {
            if (s.reviewDirection !== 'reverse' || !s.graduated) continue
            const fwdState = fwd.get(s.cardId)
            if (fwdState?.dormant) continue                     // forward already dormant → reverse ghosted
            if (!(c.reverseOn && fwdState?.graduated)) continue
            const stopDay = dormantDayByCard.get(s.cardId)
            simulate(recog, offset(s.recallDueAt ?? s.dueAt), s.recallIntervalDays ?? s.intervalDays, c.reverseM, c.maxInt,
              stopDay != null ? { stopDay } : undefined)
          }
        }

        // New cards — renewal contribution from daily goals.
        for (let t = 0; t <= HORIZON; t++) {
          for (const c of cfg.values()) {
            if (c.dailyGoal <= 0) continue
            if (c.typedOn)  typed[t] = (typed[t] ?? 0) + (c.dailyGoal / c.typedP) * stages(t, c.typedM, c.maxInt)
            if (c.smartOn) {
              // Smart: reviews below the threshold are typed, the rest self-graded.
              const thr = Math.min(c.smartThreshold, c.maxInt)
              const typedStages = stages(t, c.smartM, thr)
              const fullStages  = stages(t, c.smartM, c.maxInt)
              typed[t] = (typed[t] ?? 0) + (c.dailyGoal / c.smartP) * typedStages
              selfg[t] = (selfg[t] ?? 0) + (c.dailyGoal / c.smartP) * Math.max(0, fullStages - typedStages)
            }
            if (c.selfgOn)   selfg[t] = (selfg[t] ?? 0) + (c.dailyGoal / c.selfgP)   * stages(t, c.selfgM,   c.maxInt)
            if (c.reverseOn) recog[t] = (recog[t] ?? 0) + (c.dailyGoal / c.reverseP) * stages(t, c.reverseM, c.maxInt)
          }
        }

        // Downsample to STEP-day points, averaging each window to smooth spikes.
        const pts: ChartPoint[] = []
        for (let s = 0; s <= HORIZON; s += STEP) {
          let st = 0, sg = 0, sr = 0, n = 0
          for (let d = s; d < Math.min(s + STEP, HORIZON + 1); d++) { st += typed[d]!; sg += selfg[d]!; sr += recog[d]!; n++ }
          pts.push({ day: s, typed: st / n, selfg: sg / n, recog: sr / n, total: (st + sg + sr) / n })
        }
        if (!cancelled) { setPoints(pts); setHasGoals(anyGoal) }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const svg = useMemo(() => {
    if (!points) return null
    const W = 720, H = 280, mL = 44, mR = 12, mT = 12, mB = 26
    const maxY = Math.max(10, ...points.map(p => p.total)) * 1.1
    const x = (day: number) => mL + (day / HORIZON) * (W - mL - mR)
    const y = (v: number) => H - mB - (v / maxY) * (H - mT - mB)
    const path = (key: 'typed' | 'selfg' | 'recog' | 'total') =>
      points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.day).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ')
    const yTicks = 4
    return { W, H, mL, mR, mT, mB, maxY, x, y, path, yTicks }
  }, [points])

  if (error) return <p className="text-sm text-danger">Couldn&apos;t build projection: {error}</p>
  if (!points || !svg) return <p className="text-sm text-ink-faint">Building projection…</p>

  const { W, H, mL, mB, maxY, x, y, path, yTicks } = svg
  const xTicks = [
    { day: 0, label: 'now' }, { day: 182, label: '6 mo' },
    { day: 365, label: '1 yr' }, { day: 547, label: '18 mo' }, { day: 730, label: '2 yr' },
  ]

  return (
    <div className="flex flex-col gap-2">
      {!hasGoals && (
        <p className="text-xs text-warning">No daily goals set — the projection only reflects your existing cards. Set per-language goals in Settings to include future learning.</p>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 320 }}>
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
        {/* series */}
        <path d={path('total')} fill="none" stroke="#7c6af7" strokeWidth={2.5} />
        <path d={path('typed')} fill="none" stroke="#6366f1" strokeWidth={2} opacity={0.9} />
        <path d={path('selfg')} fill="none" stroke="#f59e0b" strokeWidth={2} opacity={0.9} />
        <path d={path('recog')} fill="none" stroke="#10b981" strokeWidth={2} opacity={0.9} />
      </svg>
      {/* legend + readouts */}
      <div className="flex flex-wrap gap-4 text-xs">
        {([
          { c: '#7c6af7', label: 'Total' },
          { c: '#6366f1', label: 'Typed' },
          { c: '#f59e0b', label: 'Self-graded' },
          { c: '#10b981', label: 'Reverse' },
        ]).map(l => (
          <span key={l.label} className="flex items-center gap-1.5 text-ink-muted">
            <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: l.c }} />{l.label}
          </span>
        ))}
      </div>
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
