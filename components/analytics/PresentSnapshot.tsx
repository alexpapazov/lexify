'use client'

/**
 * PresentSnapshot — the "Present" tab of Analytics: today at a glance.
 *   1. The five card-status counters (Unlearned / Learning / Graduated / Due Now / Dormant), each
 *      clickable to reveal the cards in that bucket across all decks.
 *   2. Today's per-language goal progress (mirrors the Study dashboard).
 *   3. Time tracking — time spent on Lexify today, and a projected time-to-finish split into clearing
 *      today's Due Now reviews and learning the remaining new-word goal.
 */
import { useEffect, useMemo, useState } from 'react'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { fetchAnalyticsProfile, fetchGraduationsWindow, fetchLadderEventsWindow, fetchReviewEventsWindow, fetchGraduationsSince } from '@/lib/analyticsData'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabasePaged'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import type { ClimbState } from '@/engine/ladderEngine'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { SupabaseLadderRepository } from '@/lib/data/ladders'
import { SupabasePathwayRepository } from '@/lib/data/pathways'
import { resolveEffectivePathway } from '@/lib/pathway'
import { minAnswersForPipeline, struggleFactor, newCardMs, DEFAULT_MS_PER_ANSWER } from '@/lib/pipelineCost'
import { buildEnabledTracksMap, trackEnabled, activeProductionTrack, forwardProductionMode } from '@/lib/sessionLimits'
import { getToday, localDateWithTurnover, localDate } from '@/lib/dates'
import { carriedGoal, plannedGoalSum, fullDebtGoal, isAutoGraduated, fullDebtExemptionAdjustment, owedGoalForDate, goalStanding, effectiveDebtSince } from '@/lib/goalCarryover'
import { AccuracyTrend } from './AccuracyTrend'
import { LearningEfficiency } from './LearningEfficiency'
import { langName } from '@/lib/languages'
import { routes } from '@/lib/routes'
import { DEFAULT_LADDER } from '@/domain'
import type { Card, Deck, LanguagePair } from '@/domain'

type Category = 'new' | 'learning' | 'graduated' | 'due' | 'dormant'
interface CardEntry { card: Card; deckId: string; deckName: string; source: string; target: string }

const DAY_MS = 86_400_000
const DEFAULT_DUE_MS = 8_000     // fallback per-review time if we have no timing history
const DEFAULT_LEARN_MS = 90_000  // fallback per-new-card learning time

/** Bucket key for review pace: a typed Spanish production review and a reverse Korean recognition
 *  take very different amounts of time, so pace is measured per language × direction × typed-or-not
 *  rather than as one global median. */
function paceKey(src: string, tgt: string, dir: 'forward' | 'reverse', typed: boolean): string {
  return `${src}|${tgt}|${dir}|${typed ? 't' : 's'}`
}

// The estimates re-tune themselves daily: every past review/graduation is weighted by how recent it
// is, so as you get faster (or slower) the projection follows within about a week without anyone
// touching a setting. A longer window than before is safe precisely because old data decays away.
const WINDOW_DAYS = 30        // history pulled in (older data still counts, just very little)
const HALF_LIFE_DAYS = 7      // a review 7 days old counts half as much as one from today
const MIN_EFF_SAMPLES = 3     // minimum *weighted* samples before a bucket is trusted on its own

/** Exponential recency weight: 1.0 today → 0.5 at one half-life → 0.25 at two, etc. */
function recencyWeight(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS)
}

interface WSample { v: number; w: number }
const totalWeight = (xs: WSample[]) => xs.reduce((t, p) => t + p.w, 0)

/**
 * Weighted median — stays robust to the occasional "walked away mid-review" outlier the way a plain
 * median does, while letting recent reviews dominate. (A weighted *mean* would be wrecked by a single
 * 4-minute response.) Returns the value at the 50% mark of accumulated weight.
 */
function weightedMedian(xs: WSample[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a.v - b.v)
  const total = totalWeight(s)
  if (total <= 0) return null
  let acc = 0
  for (const p of s) { acc += p.w; if (acc >= total / 2) return p.v }
  return s[s.length - 1]!.v
}

/**
 * Recency-weighted median response time for a bucket, widening when a bucket is too thin to trust:
 * exact (language × direction × typed) → same language+direction → same direction+typed across
 * languages → global → fixed fallback. Thinness is judged on *weighted* samples, so three reviews
 * from last week count for less than three from today.
 */
function pace(
  samples: Map<string, WSample[]>, src: string, tgt: string, dir: 'forward' | 'reverse', typed: boolean,
): number {
  const tryKeys = [
    paceKey(src, tgt, dir, typed),
    `${src}|${tgt}|${dir}`,        // same language + direction, either presentation
    `${dir}|${typed ? 't' : 's'}`, // same direction + presentation, any language
    'all',
  ]
  for (const k of tryKeys) {
    const xs = samples.get(k)
    if (xs && totalWeight(xs) >= MIN_EFF_SAMPLES) { const m = weightedMedian(xs); if (m != null && m > 0) return m }
  }
  const any = weightedMedian(samples.get('all') ?? [])
  return any && any > 0 ? any : DEFAULT_DUE_MS
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—'
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 1) return '<1 min'
  const h = Math.floor(totalMin / 60), m = totalMin % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m} min`
}

interface Data {
  lists: Record<Category, CardEntry[]>
  counts: Record<Category, number>
  goals: { key: string; label: string; baseGoal: number; goal: number; delta: number; done: number }[]
  /** Full-debt running balance per language (negative = owed). Empty unless full debt is on. */
  standings: { key: string; label: string; standing: number }[]
  /** The date full debt was switched on, for the standing panel's subtitle. */
  fullDebtSince: string | null
  timeTodayMs: number
  projDueMs: number
  projNewMs: number
  remainingNew: number
}

export function PresentSnapshot() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<Category | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())  // `${deckId}:${cardId}`
  const [langFilter, setLangFilter] = useState<string | null>(null) // `${source}|${target}`
  const [copied, setCopied] = useState(false)

  function openCategory(key: Category) {
    setActive(prev => prev === key ? null : key)
    setSelected(new Set()); setLangFilter(null); setCopied(false)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setError('Not signed in'); return }
        const uid = session.user.id

        // Shared + hardened (core-columns fallback) and cached, so the two charts below reuse it
        // instead of each issuing their own profiles read. Fired alongside the window queries — none
        // of them need anything but the user id, and they used to run as separate serial stages.
        const windowRowsP = Promise.all([
          fetchGraduationsWindow(uid, WINDOW_DAYS),
          fetchLadderEventsWindow(uid, WINDOW_DAYS),
          fetchReviewEventsWindow(uid, WINDOW_DAYS),
        ])
        const profile = await fetchAnalyticsProfile(uid)
        const tz = (profile?.timezone as string | null) ?? deviceTimeZone()
        const turnover = (profile?.day_turnover_hour as number | null) ?? 0
        const carryShortfall = (profile?.goal_carry_shortfall as boolean | null) ?? false
        const carrySurplus = (profile?.goal_carry_surplus as boolean | null) ?? false
        const fullDebtOn = (profile?.goal_full_debt as boolean | null) ?? false
        const fullDebtSince = (profile?.goal_full_debt_since as string | null) ?? null
        const fullDebtResets = (profile?.goal_full_debt_resets as Record<string, string> | null) ?? {}
        const skipShortfallDays = (profile?.full_debt_skip_shortfall_days as string[] | null) ?? []
        const skipSurplusDays   = (profile?.full_debt_skip_surplus_days   as string[] | null) ?? []
        const exemptDaySet = new Set([...skipShortfallDays, ...skipSurplusDays])
        const deferrals = (profile?.goal_deferrals as string[] | null) ?? []
        const today = getToday(tz, turnover)
        const todayWeekday = new Date(today + 'T12:00:00Z').getUTCDay()
        const yDate = new Date(today + 'T12:00:00Z'); yDate.setUTCDate(yDate.getUTCDate() - 1)
        const yesterday = yDate.toISOString().slice(0, 10)
        const yesterdayWeekday = (todayWeekday + 6) % 7
        const now = Date.now()

        // The pipeline configs join this first wave — they need nothing but the user id, and the
        // new-word estimate now reads each language's CURRENT ladder/pathway rather than inferring
        // its cost from history alone.
        const pathRepo = new SupabasePathwayRepository()
        const [decks, pairs, paramRows, savedLadders, defaultLadderRow] = await Promise.all([
          new SupabaseDeckRepository().list(uid),
          new SupabaseLanguagePairRepository().list(uid),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
          new SupabaseLadderRepository().list(uid),
          new SupabaseLadderRepository().getDefault(uid),
        ])
        const defaultLadder = defaultLadderRow ?? DEFAULT_LADDER
        const pairLadders = new Map(savedLadders.filter(l => l.source && l.target).map(l => [`${l.source}|${l.target}`, l.ladder]))
        // Pathways are per-pair reads (no list API), and only pairs actually in pathway mode need one.
        const pathwayPairs = (pairs as LanguagePair[]).filter(p => p.learningMode === 'pathway')
        const [defaultPathway, ...pathwayList] = await Promise.all([
          pathwayPairs.length > 0 ? pathRepo.getDefault(uid) : Promise.resolve(null),
          ...pathwayPairs.map(p => pathRepo.getForPair(uid, p.sourceLanguage, p.targetLanguage)),
        ])
        const pairPathways = new Map(pathwayPairs.map((p, i) => [`${p.sourceLanguage}|${p.targetLanguage}`, pathwayList[i] ?? null]))
        const deckById = new Map(decks.map(d => [d.id, d]))
        const enabledMap = buildEnabledTracksMap(paramRows)   // for track-aware Due Now (matches the dashboard)
        // Smart-typing threshold per pair (canonical on forward_typed) — decides whether a due
        // production review is presented TYPED or self-graded, which dominates how long it takes.
        const thresholdByPair = new Map<string, number>()
        for (const r of paramRows) {
          if (r.answerField === 'forward_typed') thresholdByPair.set(`${r.sourceLanguage}|${r.targetLanguage}`, r.smartTypingThresholdDays)
        }
        // Due REVIEWS bucketed by language × direction × presentation. A card due both forward and
        // reverse is two reviews (dedupeDueReviews keys on cardId:direction), so this is the real
        // workload — the Due Now *card* count below stays one-per-card to match the dashboard.
        const dueBuckets = new Map<string, number>()
        const addDue = (src: string, tgt: string, dir: 'forward' | 'reverse', typed: boolean) => {
          const k = paceKey(src, tgt, dir, typed)
          dueBuckets.set(k, (dueBuckets.get(k) ?? 0) + 1)
        }
        // `tz`/`today` are loop-invariant, so format through ONE cached formatter — this used to
        // build a fresh Intl.DateTimeFormat per call, several times per graduated card.
        const isDue = (dateStr: string | null | undefined) => !!dateStr && localDate(new Date(dateStr), tz) <= today

        // Per-deck cards + states + climb → status buckets.
        const cardRepo = new SupabaseCardRepository()
        const stateRepo = new SupabaseCardStateRepository()
        const climbRepo = new SupabaseLadderClimbRepository()
        const lists: Record<Category, CardEntry[]> = { new: [], learning: [], graduated: [], due: [], dormant: [] }

        // Whole library in FOUR cached queries instead of ~4 requests PER DECK in 3 dependent waves.
        // These also drop the audio blobs: the old per-deck `listByDeck` selects `cards(*)`, which
        // includes the base64 MP3s — megabytes shipped to render a card list and five counters.
        const [allCards, allStates, allClimb, deckIdByCard] = await Promise.all([
          cardRepo.listAllForUser(uid),
          stateRepo.listAllForUser(uid),
          climbRepo.listAllForUser(uid).catch((): Map<string, ClimbState> => new Map()),
          cardRepo.deckIdsByCard(decks.map((d: Deck) => d.id)),
        ])
        const cardsByDeck = new Map<string, Card[]>()
        for (const c of allCards) {
          const dId = deckIdByCard.get(c.id)
          if (!dId) continue
          const arr = cardsByDeck.get(dId)
          if (arr) arr.push(c); else cardsByDeck.set(dId, [c])
        }
        const statesByCard = new Map<string, typeof allStates>()
        for (const s of allStates) {
          const arr = statesByCard.get(s.cardId)
          if (arr) arr.push(s); else statesByCard.set(s.cardId, [s])
        }

        decks.forEach((deck: Deck) => {
          const cards = cardsByDeck.get(deck.id) ?? []
          const states = cards.flatMap(c => statesByCard.get(c.id) ?? [])
          const climb = allClimb
          const fwd = states.filter(s => s.reviewDirection !== 'reverse')
          const stateMap = new Map(fwd.map(s => [s.cardId, s]))
          const en = enabledMap.get(`${deck.sourceLanguage}|${deck.targetLanguage}`)
          // Track-aware Due Now — a card due only on a DISABLED track doesn't count (mirrors the dashboard).
          const prodEnabled = trackEnabled(en, 'typed', false) || trackEnabled(en, 'smart', false)
          const prodDue   = (s: typeof states[number]) => !s.dormant && prodEnabled && (s.smartDueAt ? isDue(s.smartDueAt) : s.typedDueAt ? isDue(s.typedDueAt) : isDue(s.dueAt))
          const recallDue = (s: typeof states[number]) => !s.dormant && trackEnabled(en, 'recall', false) && isDue(s.recallDueAt)
          const reverseDue = (r: typeof states[number]) => trackEnabled(en, 'recall', true) && stateMap.get(r.cardId)?.graduated === true
            && !stateMap.get(r.cardId)?.dormant && !r.dormant && isDue(r.recallDueAt ?? r.dueAt)
          // Indexed once — this was a full `states.some(...)` scan per graduated card (O(cards x states)).
          const reverseByCard = new Map<string, typeof states[number]>()
          for (const r of states) if (r.reviewDirection === 'reverse') reverseByCard.set(r.cardId, r)
          const entry = (card: Card): CardEntry => ({ card, deckId: deck.id, deckName: deck.name, source: deck.sourceLanguage, target: deck.targetLanguage })
          for (const card of cards) {
            const s = stateMap.get(card.id)
            const cl = climb.get(card.id)
            if (s?.dormant) { lists.dormant.push(entry(card)); continue }
            if (s?.graduated) {
              lists.graduated.push(entry(card))
              const fwdProd = prodDue(s), fwdRecall = recallDue(s)
              const revRow = reverseByCard.get(card.id)
              const revDue = !!revRow && reverseDue(revRow)
              // One forward review at most (production outranks recall in dedupeDueReviews); reverse is
              // its own review. Presentation decides pace: production may be typed, recall/reverse never.
              if (fwdProd) {
                const track = activeProductionTrack(en)
                const typed = !!track && forwardProductionMode(s, track, thresholdByPair.get(`${deck.sourceLanguage}|${deck.targetLanguage}`) ?? 20) === 'typed'
                addDue(deck.sourceLanguage, deck.targetLanguage, 'forward', typed)
              } else if (fwdRecall) {
                addDue(deck.sourceLanguage, deck.targetLanguage, 'forward', false)
              }
              if (revDue) addDue(deck.sourceLanguage, deck.targetLanguage, 'reverse', false)
              if (fwdProd || fwdRecall || revDue) lists.due.push(entry(card))
              continue
            }
            if ((cl && cl.rungIndex >= 1 && !cl.graduated) || (s && !s.graduated)) lists.learning.push(entry(card))
            else lists.new.push(entry(card))
          }
        })
        const counts = { new: lists.new.length, learning: lists.learning.length, graduated: lists.graduated.length, due: lists.due.length, dormant: lists.dormant.length }

        // ── Today's goals + how many new words graduated today (per pair) ──
        const sinceWindow = new Date(now - WINDOW_DAYS * DAY_MS).toISOString()
        // All three are paged: over a 30-day window each can exceed Supabase's 1000-row cap, which a
        // client-side `.limit()` does NOT lift — it just truncates. The graduations query is the worst
        // offender: at a 50-word daily goal it's ~1500 rows, and without an explicit order the cap
        // would drop an arbitrary subset, so today's graduations could vanish from goal progress.
        const [gradRows, ladderRows, dueRows] = await windowRowsP

        const gradToday = new Map<string, number>()
        const gradYesterday = new Map<string, number>()   // for goal carryover
        // Recency-weighted graduation counts — the denominator of "time per new word".
        const gradWByPair = new Map<string, number>()
        let gradWAll = 0
        for (const row of gradRows) {
          const r = row as unknown as { graduated_at: string; accelerated_mode: string | null; cards: { source_language: string; target_language: string } | null }
          if (!r.graduated_at || !r.cards) continue
          if (isAutoGraduated(r.accelerated_mode)) continue
          const key = `${r.cards.source_language}|${r.cards.target_language}`
          const w = recencyWeight((now - new Date(r.graduated_at).getTime()) / DAY_MS)
          gradWAll += w
          gradWByPair.set(key, (gradWByPair.get(key) ?? 0) + w)
          const day = localDateWithTurnover(r.graduated_at, tz, turnover)
          if (day === today) gradToday.set(key, (gradToday.get(key) ?? 0) + 1)          // exact count
          else if (day === yesterday) gradYesterday.set(key, (gradYesterday.get(key) ?? 0) + 1)
        }

        // Full-debt: cumulative graduations per pair from the enable date THROUGH YESTERDAY (paged).
        const gradSince = new Map<string, number>()
        const exemptDayGrads = new Map<string, number>()   // `${key}|${day}` for waived days only
        if (fullDebtOn && fullDebtSince) {
          const lower = new Date(new Date(fullDebtSince + 'T00:00:00Z').getTime() - 48 * DAY_MS).toISOString()
          const rows = await fetchGraduationsSince(uid, lower)
          for (const row of rows) {
            const r = row as unknown as { graduated_at: string; accelerated_mode: string | null; cards: { source_language: string; target_language: string } | null }
            if (!r.graduated_at || !r.cards) continue
            if (isAutoGraduated(r.accelerated_mode)) continue
            const day = localDateWithTurnover(r.graduated_at, tz, turnover)
            const key = `${r.cards.source_language}|${r.cards.target_language}`
            // Each language counts from its own start, so a per-language reset really clears it.
            const pairSince = effectiveDebtSince(fullDebtSince, fullDebtResets, key) ?? fullDebtSince
            if (day >= pairSince && day < today) {
              gradSince.set(key, (gradSince.get(key) ?? 0) + 1)
              if (exemptDaySet.has(day)) exemptDayGrads.set(`${key}|${day}`, (exemptDayGrads.get(`${key}|${day}`) ?? 0) + 1)
            }
          }
        }

        const goals = pairs
          .map((p: LanguagePair) => {
            const key = `${p.sourceLanguage}|${p.targetLanguage}`
            const configuredForWeekday = (wd: number) => { const g = p.goals?.[String(wd)]; return typeof g === 'number' ? g : 0 }
            const isDeferred = (d: string) => deferrals.includes(`${key}|${d}`)
            const owed = (d: string) => owedGoalForDate(d, configuredForWeekday, isDeferred)
            const baseGoal = owed(today)  // deferral-adjusted "owed today"
            // Apply goal carryover so "words needed today" matches the Study page.
            let goal: number, delta: number
            const pairSince = effectiveDebtSince(fullDebtSince, fullDebtResets, key)
            if (fullDebtOn && pairSince) {
              ;({ goal, delta } = fullDebtGoal({
                baseGoal,
                plannedThroughYesterday: plannedGoalSum(owed, pairSince, yesterday),
                gradsThroughYesterday: gradSince.get(key) ?? 0,
                exemptionAdjustment: fullDebtExemptionAdjustment({
                  skipShortfallDays, skipSurplusDays,
                  goalForDay: owed, gradsForDay: (d) => exemptDayGrads.get(`${key}|${d}`) ?? 0,
                  since: pairSince, through: yesterday,
                }),
              }))
            } else {
              const yOwed = owed(yesterday)
              ;({ goal, delta } = carriedGoal({
                baseGoal,
                yesterdayGoal: yOwed > 0 ? yOwed : null,
                yesterdayCount: gradYesterday.get(key) ?? 0,
                carryShortfall, carrySurplus,
              }))
            }
            return { key, label: `${langName(p.sourceLanguage)} → ${langName(p.targetLanguage)}`, baseGoal, goal, delta, done: gradToday.get(key) ?? 0 }
          })
          // Analytics shows the FULL carryover picture (incl. pairs a surplus auto-fulfilled to goal 0,
          // rendered as a green ✓), so filter on the owed base — any pair with a target today shows.
          .filter(g => g.baseGoal > 0 || g.goal > 0)
        const remainingNew = goals.reduce((sum, g) => sum + Math.max(0, g.goal - g.done), 0)

        /**
         * The running full-debt balance per language: how many cards you'd need to have finished by
         * now to be level. Negative = owed, positive = banked.
         *
         * Full-debt mode only — it's the only mode with a cumulative balance to report. Unlike
         * `goals` above, this deliberately keeps pairs with NO goal today: a language you owe 30
         * cards on must not vanish from the standing because today happens to be a rest day.
         */
        const standings = (fullDebtOn && fullDebtSince)
          ? pairs.flatMap((p: LanguagePair) => {
              const key = `${p.sourceLanguage}|${p.targetLanguage}`
              const configuredForWeekday = (wd: number) => { const g = p.goals?.[String(wd)]; return typeof g === 'number' ? g : 0 }
              const isDeferred = (d: string) => deferrals.includes(`${key}|${d}`)
              // Each day's CONFIGURED goal, never the displayed one — the displayed goal is clamped
              // to 2.5x base, and reading the balance off that would forgive the withheld remainder
              // that is supposed to roll forward.
              const owed = (d: string) => owedGoalForDate(d, configuredForWeekday, isDeferred)
              const pairSince = effectiveDebtSince(fullDebtSince, fullDebtResets, key) ?? fullDebtSince
              const planned = plannedGoalSum(owed, pairSince, yesterday)
              const todayGoal = owed(today)
              if (planned <= 0 && todayGoal <= 0 && (gradSince.get(key) ?? 0) === 0) return []
              const standing = goalStanding({
                plannedThroughYesterday: planned,
                gradsThroughYesterday:   gradSince.get(key) ?? 0,
                todayGoal,
                todayGrads:              gradToday.get(key) ?? 0,
                exemptionAdjustment: fullDebtExemptionAdjustment({
                  skipShortfallDays, skipSurplusDays,
                  goalForDay: owed, gradsForDay: (d) => exemptDayGrads.get(`${key}|${d}`) ?? 0,
                  since: pairSince, through: yesterday,
                }),
              })
              return [{ key, label: `${langName(p.sourceLanguage)} → ${langName(p.targetLanguage)}`, standing }]
            })
          : []

        // ── Time today + projections ──
        // Learning pace is measured PER LANGUAGE, since a Korean word takes far longer to answer than
        // a Spanish one. Two quantities per pair: total weighted TIME (for ms-per-answer) and total
        // weighted ANSWER COUNT (for the struggle factor — how many attempts a word really takes).
        let ladderTodayMs = 0, ladderWAll = 0, answerWAll = 0
        const ladderWByPair = new Map<string, number>()   // Σ (recency weight × ms)
        const answerWByPair = new Map<string, number>()   // Σ (recency weight)  — one per answer
        for (const e of ladderRows) {
          const ms = (e.duration_ms as number | null) ?? 0
          const at = e.created_at as string
          if (localDateWithTurnover(at, tz, turnover) === today) ladderTodayMs += ms
          if (ms <= 0) continue
          const w = recencyWeight((now - new Date(at).getTime()) / DAY_MS)
          ladderWAll += ms * w
          answerWAll += w
          const src = e.source_language as string | null, tgt = e.target_language as string | null
          if (src && tgt) {
            const k = `${src}|${tgt}`
            ladderWByPair.set(k, (ladderWByPair.get(k) ?? 0) + ms * w)
            answerWByPair.set(k, (answerWByPair.get(k) ?? 0) + w)
          }
        }
        // Review pace bucketed by language × direction × typed-or-not (plus the widening fallbacks),
        // each sample carrying its recency weight.
        let dueTodayMs = 0
        const paceSamples = new Map<string, WSample[]>()
        const push = (k: string, s: WSample) => { const a = paceSamples.get(k); if (a) a.push(s); else paceSamples.set(k, [s]) }
        for (const e of dueRows) {
          const ms = (e.response_ms as number | null) ?? 0
          const at = e.reviewed_at as string
          if (localDateWithTurnover(at, tz, turnover) === today) dueTodayMs += ms
          if (ms <= 0) continue
          const s: WSample = { v: ms, w: recencyWeight((now - new Date(at).getTime()) / DAY_MS) }
          const src = (e.source_language as string | null) ?? '', tgt = (e.target_language as string | null) ?? ''
          const dir: 'forward' | 'reverse' = (e.review_direction as string | null) === 'reverse' ? 'reverse' : 'forward'
          const typed = !!(e.was_typed as boolean | null)
          push('all', s)
          push(`${dir}|${typed ? 't' : 's'}`, s)
          if (src && tgt) { push(`${src}|${tgt}|${dir}`, s); push(paceKey(src, tgt, dir, typed), s) }
        }

        // Project each due bucket at its own pace, then sum — instead of (all due) × (one global median).
        let projDueMs = 0
        for (const [k, n] of dueBuckets) {
          const [src, tgt, dir, pres] = k.split('|') as [string, string, 'forward' | 'reverse', string]
          projDueMs += n * pace(paceSamples, src, tgt, dir, pres === 't')
        }
        // New words: structure × struggle × pace, per language (see lib/pipelineCost.ts).
        //
        // The structural part is read from the pipeline each language is CURRENTLY using, so editing
        // a ladder, or flipping a language to pathway mode, moves the estimate on the next load
        // instead of waiting a month for history to wash through. The other two factors stay
        // measured, so it still tracks how fast this learner actually is.
        const globalMsPerAnswer = answerWAll >= 3 && ladderWAll > 0 ? ladderWAll / answerWAll : DEFAULT_MS_PER_ANSWER
        const globalLearnMs = gradWAll >= 2 && ladderWAll > 0 ? ladderWAll / gradWAll : DEFAULT_LEARN_MS

        const minAnswersByPair = new Map<string, number>()
        for (const p of pairs as LanguagePair[]) {
          const key = `${p.sourceLanguage}|${p.targetLanguage}`
          const ladder = pairLadders.get(key) ?? defaultLadder
          const pathway = resolveEffectivePathway(pairPathways.get(key) ?? null, defaultPathway)
          minAnswersByPair.set(key, minAnswersForPipeline(p.learningMode ?? 'ladder', ladder, pathway))
        }

        // Struggle is pooled across languages on purpose — see the note in lib/pipelineCost.ts.
        const struggle = struggleFactor([...minAnswersByPair].map(([key, minAnswers]) => ({
          answers:     answerWByPair.get(key) ?? 0,
          graduations: gradWByPair.get(key) ?? 0,
          minAnswers,
        })))

        let projNewMs = 0
        for (const g of goals) {
          const remaining = Math.max(0, g.goal - g.done)
          if (remaining === 0) continue
          const aw = answerWByPair.get(g.key) ?? 0
          const lw = ladderWByPair.get(g.key) ?? 0
          // This language's own pace once it has a few answers on record; the global pace until then.
          const msPerAnswer = aw >= 3 && lw > 0 ? lw / aw : globalMsPerAnswer
          const gw = gradWByPair.get(g.key) ?? 0
          projNewMs += remaining * newCardMs({
            minAnswers: minAnswersByPair.get(g.key) ?? 0,
            struggle,
            msPerAnswer,
            // Only used when the pipeline can't be read at all.
            fallbackPerWordMs: gw >= 2 && lw > 0 ? lw / gw : globalLearnMs,
          })
        }

        if (!cancelled) setData({
          lists, counts, goals, standings, fullDebtSince,
          timeTodayMs: ladderTodayMs + dueTodayMs,
          projDueMs,
          projNewMs,
          remainingNew,
        })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const CATS = useMemo(() => ([
    { key: 'new'       as Category, label: 'Unlearned', color: 'text-ink-muted',   border: 'border-ink-faint', desc: 'Not yet started'  },
    { key: 'learning'  as Category, label: 'Learning',  color: 'text-warning',     border: 'border-warning',   desc: 'In pipeline'      },
    { key: 'graduated' as Category, label: 'Graduated', color: 'text-success',     border: 'border-success',   desc: 'Long-term review' },
    { key: 'due'       as Category, label: 'Due Now',   color: 'text-accent-soft', border: 'border-accent',    desc: 'Ready to review'  },
    { key: 'dormant'   as Category, label: 'Dormant',   color: 'text-ink',         border: 'border-line/70',   desc: 'Paused — manual'  },
  ]), [])

  if (error) return <p className="text-sm text-danger">Couldn&apos;t load: {error}</p>
  if (!data) return <p className="text-sm text-ink-faint">Loading today…</p>

  const list = active ? data.lists[active] : []
  const keyOf = (e: CardEntry) => `${e.deckId}:${e.card.id}`
  const pairKeys = [...new Set(list.map(e => `${e.source}|${e.target}`))]
  const shown = langFilter ? list.filter(e => `${e.source}|${e.target}` === langFilter) : list
  const allShownSelected = shown.length > 0 && shown.every(e => selected.has(keyOf(e)))
  const selectedCount = list.filter(e => selected.has(keyOf(e))).length

  const toggleOne = (e: CardEntry) => setSelected(prev => {
    const n = new Set(prev); const k = keyOf(e); n.has(k) ? n.delete(k) : n.add(k); return n
  })
  const toggleSelectAll = () => setSelected(prev => {
    const n = new Set(prev)
    if (allShownSelected) shown.forEach(e => n.delete(keyOf(e)))
    else shown.forEach(e => n.add(keyOf(e)))
    return n
  })
  const copySelected = () => {
    const chosen = list.filter(e => selected.has(keyOf(e)))
    const text = chosen.map(e => `${e.card.front}\t${e.card.back}`).join('\n')
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }

  return (
    <div className="space-y-6">
      {/* 1. Card counters — clickable */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {CATS.map(({ key, label, color, border, desc }) => {
          const isActive = active === key
          return (
            <button key={key} onClick={() => openCategory(key)}
              className={`panel border-t-2 ${border} space-y-1 text-center w-full transition-colors ${isActive ? 'bg-surface-raised ring-1 ring-ink/10' : 'hover:bg-surface-raised/50'}`}>
              <div className={`text-2xl font-semibold ${color}`}>{data.counts[key]}</div>
              <div className="text-xs font-medium text-ink">{label}</div>
              <div className="text-xs text-ink-faint">{desc}</div>
            </button>
          )
        })}
      </div>

      {active && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-medium text-ink-muted uppercase tracking-wider">
              {CATS.find(c => c.key === active)?.label} — {shown.length} card{shown.length !== 1 ? 's' : ''}
            </h3>
            <div className="flex items-center gap-3 text-xs">
              <button onClick={toggleSelectAll} className="text-ink-muted hover:text-ink">{allShownSelected ? 'Deselect all' : 'Select all'}</button>
              <button onClick={copySelected} disabled={selectedCount === 0} className="text-accent hover:text-accent-soft disabled:opacity-40">
                {copied ? 'Copied ✓' : `Copy${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
              </button>
              <button onClick={() => setActive(null)} className="text-accent hover:text-accent-soft">Close ✕</button>
            </div>
          </div>

          {/* Language filter */}
          {pairKeys.length > 1 && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              <button onClick={() => setLangFilter(null)}
                className={`px-2 py-0.5 rounded-full border ${langFilter === null ? 'bg-accent/20 border-accent text-ink' : 'border-line/15 text-ink-muted hover:text-ink'}`}>All</button>
              {pairKeys.map(pk => { const [s, t] = pk.split('|'); return (
                <button key={pk} onClick={() => setLangFilter(pk)}
                  className={`px-2 py-0.5 rounded-full border ${langFilter === pk ? 'bg-accent/20 border-accent text-ink' : 'border-line/15 text-ink-muted hover:text-ink'}`}>
                  {langName(s!)} → {langName(t!)}
                </button>
              )})}
            </div>
          )}

          {shown.length === 0 ? (
            <div className="panel text-ink-muted text-sm text-center py-6">No cards in this category.</div>
          ) : (
            <div className="panel divide-y divide-line/5 p-0 overflow-hidden max-h-96 overflow-y-auto">
              {shown.map(e => (
                <div key={keyOf(e)} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-raised/50 transition-colors">
                  <input type="checkbox" className="accent-accent shrink-0 w-4 h-4" checked={selected.has(keyOf(e))} onChange={() => toggleOne(e)} />
                  <Link href={routes.deck(e.deckId, { card: e.card.id })} className="flex items-center justify-between gap-4 min-w-0 flex-1">
                    <div className="flex gap-6 text-sm min-w-0">
                      <span className="text-ink font-medium w-36 truncate shrink-0">{e.card.front}</span>
                      <span className="text-ink-muted truncate">{e.card.back}</span>
                    </div>
                    <span className="text-xs text-ink-faint hidden sm:block shrink-0 ml-2">{langName(e.source)} → {langName(e.target)} · {e.deckName}</span>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 2. Today's goals */}
      {data.goals.length > 0 && (
        <div className="panel space-y-3">
          <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Today&apos;s goals</h2>
          {data.goals.map(g => {
            const done = g.done >= g.goal   // a surplus can zero the goal → auto-fulfilled (green ✓)
            const pct = g.goal <= 0 ? 100 : Math.min(100, Math.round((g.done / g.goal) * 100))
            return (
              <div key={g.key} className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink">
                    {g.label}
                    {g.delta !== 0 && (
                      <span className="text-xs text-ink-faint ml-2">
                        {g.delta > 0 ? `+${g.delta} missed yesterday` : `${-g.delta} carried over`}
                      </span>
                    )}
                  </span>
                  <span className={done ? 'text-success font-medium' : 'text-ink-muted'}>{g.done}/{g.goal}{done ? ' ✓' : ''}</span>
                </div>
                <div className="h-1.5 rounded-full bg-line/10 overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${done ? 'bg-success' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 3. Current standing — the running full-debt balance. Full-debt mode only, since that's the
             only mode with a cumulative balance to report. */}
      {data.standings.length > 0 && (() => {
        // Bars are relative to the largest imbalance on screen, so languages compare with each other.
        const maxMagnitude = data.standings.reduce((m, s) => Math.max(m, Math.abs(s.standing)), 0)
        return (
          <div className="panel space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Current standing</h2>
              {data.fullDebtSince && <span className="text-xs text-ink-faint">since {data.fullDebtSince}</span>}
            </div>
            {data.standings.map(s => {
              // Behind → red and signed, so "-30" reads as thirty cards owed. Ahead → green.
              // Exactly level → blue, the deliberate "on the mark" state.
              const tone = s.standing < 0 ? 'text-danger' : s.standing > 0 ? 'text-success' : 'text-accent'
              const bar  = s.standing < 0 ? 'bg-danger'   : s.standing > 0 ? 'bg-success' : 'bg-accent'
              const pct = maxMagnitude > 0
                ? Math.max(s.standing === 0 ? 4 : 8, Math.round((Math.abs(s.standing) / maxMagnitude) * 100))
                : 4
              return (
                <div key={s.key} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-ink">{s.label}</span>
                    <span className={`tabular-nums ${tone}`}>
                      {s.standing > 0 ? `+${s.standing}` : s.standing}
                      {s.standing === 0 && <span className="text-ink-faint"> · on track</span>}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-line/10 overflow-hidden">
                    <div className={`h-full rounded-full ${bar} transition-all duration-500`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
            <p className="text-[11px] text-ink-faint">
              Cards you&apos;d need to have finished by now to be level, counting today&apos;s goal.
            </p>
          </div>
        )
      })()}

      {/* 4. Time tracking */}
      <div className="panel space-y-4">
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Time today</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-ink">{fmtDuration(data.timeTodayMs)}</span>
          <span className="text-xs text-ink-faint">spent on Lexify so far today</span>
        </div>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div className="rounded-lg border border-line/10 p-3">
            <div className="text-lg font-semibold text-accent-soft">{data.counts.due === 0 ? '0 min' : `~${fmtDuration(data.projDueMs)}`}</div>
            <div className="text-xs text-ink-faint mt-0.5">{data.counts.due === 0 ? 'Due Now reviews all done today ✓' : "to clear today's Due Now reviews"}</div>
          </div>
          <div className="rounded-lg border border-line/10 p-3"
               title="Estimated per language from the pipeline it currently uses — how many answers a card needs to graduate, how many extra attempts you typically take, and how long your answers take in that language. Editing a ladder or pathway changes this straight away.">
            <div className="text-lg font-semibold text-warning">{data.remainingNew === 0 ? '0 min' : `~${fmtDuration(data.projNewMs)}`}</div>
            <div className="text-xs text-ink-faint mt-0.5">{data.remainingNew === 0 ? "Today's new-word goals met ✓" : `to learn ${data.remainingNew} new word${data.remainingNew === 1 ? '' : 's'} toward today's goals`}</div>
          </div>
        </div>
        <p className="text-[11px] text-ink-faint">These re-tune themselves every day. Pace is measured separately per language and direction — median review time for each language × direction × typed-or-self-graded bucket, and each language&apos;s own time per new word — over the last {WINDOW_DAYS} days, with recent days counting more (a review from {HALF_LIFE_DAYS} days ago counts half as much as today&apos;s). So as you speed up or slow down, the estimates follow within about a week.</p>
      </div>

      {/* 4. Accuracy trend — % correct per language, filterable by direction / card type */}
      <AccuracyTrend />

      {/* 5. Time + efficiency — minutes per language per day, and how many minutes a learned word costs */}
      <LearningEfficiency />
    </div>
  )
}
