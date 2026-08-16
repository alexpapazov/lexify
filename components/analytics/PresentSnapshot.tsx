'use client'

/**
 * PresentSnapshot — the "Present" tab of Analytics: today at a glance.
 *   1. The five card-status counters (Unlearned / Learning / Graduated / Due Now / Dormant), each
 *      clickable to reveal the cards in that bucket across all decks.
 *   2. Today's per-language goal progress (mirrors the Study dashboard).
 *   3. Time tracking — time spent on Lexify today, and a projected time-to-finish split into clearing
 *      today's Due Now reviews and learning the remaining new-word goal.
 */
import { climbInProgress } from '@/lib/climbProgress'
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
import { SupabaseGoalScheduleRepository, progressForSchedules } from '@/lib/data/goalSchedules'
import { scheduleStatus, daysBetween, schedulePlan } from '@/lib/goalSchedule'
import { shareDayAcrossLanguages } from '@/lib/dailyCeiling'
import type { GoalSchedule } from '@/domain'
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

const shortDate = (d: string) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

function Metric({ label, value, hint, tone = 'muted' }: {
  label: string; value: string; hint: string; tone?: 'muted' | 'success' | 'danger'
}) {
  const color = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-ink'
  return (
    <div>
      <div className="text-[10px] text-ink-faint uppercase tracking-wider">{label}</div>
      <div className={`text-base font-medium ${color}`}>{value}</div>
      <div className="text-[10px] text-ink-faint">{hint}</div>
    </div>
  )
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—'
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 1) return '<1 min'
  const h = Math.floor(totalMin / 60), m = totalMin % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m} min`
}

/**
 * One live schedule's standing, for the "Goal progress" panel. Everything here is DERIVED from
 * `scheduleStatus` + the schedule row — nothing is stored, so it can't drift from what the study
 * dashboard shows tomorrow.
 */
interface ScheduleGoalRow {
  /**
   * 'target'    — a deadline to work toward, so progress is a percentage of a finish line.
   * 'recurring' — just a number per day or per week (a pattern schedule, or plain weekday goals).
   *               It has nothing to be a percentage OF, so it reports the number itself instead of
   *               a progress bar full of zeroes.
   */
  kind: 'target' | 'recurring'
  key: string
  label: string
  /** The learner's own name for it ("Exam prep"), or null. */
  name: string | null
  /** Null for a pattern schedule — no finish line, so most of the columns below don't apply. */
  target: number | null
  /** Words the measure had when the schedule started; 0 for a `new_words` goal. */
  baseline: number
  /** Words earned SINCE the schedule began — the honest "what have I done about this" number. */
  learnedSince: number
  /** Size of the job: `target − baseline`. */
  span: number
  remaining: number
  todayGoal: number
  /** Days that actually carry words (days off excluded). */
  studyDaysLeft: number
  /** Plain calendar days to the deadline, which is what a person counts. */
  calendarDaysLeft: number | null
  /** Null for plain weekday goals — they have no start date to measure from. */
  startDate: string | null
  deadline: string | null
  pace: number
  feasible: boolean
  shortfall: number
  done: boolean
  expired: boolean
  isPattern: boolean
  /** The soonest checkpoint still ahead, if any. */
  nextCheckpoint: { date: string; target: number; remaining: number } | null
  /** recurring only: the same number every day, or null when the week isn't uniform. */
  perDay: number | null
  /** recurring only: words across the next seven days. */
  perWeek: number
}

interface Data {
  lists: Record<Category, CardEntry[]>
  counts: Record<Category, number>
  goals: { key: string; label: string; baseGoal: number; goal: number; delta: number; done: number }[]
  /** Full-debt running balance per language (negative = owed). Empty unless full debt is on. */
  standings: { key: string; label: string; standing: number }[]
  /** The date full debt was switched on, for the standing panel's subtitle. */
  fullDebtSince: string | null
  /** Live deadline-driven goals. Empty when no language is on a schedule. */
  scheduleGoals: ScheduleGoalRow[]
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
        // Deadline-driven goals (migration 114). Never fatal — an unapplied migration just leaves
        // every pair on its weekday goals, which is what this panel showed before schedules existed.
        const schedulesP = new SupabaseGoalScheduleRepository().listActive(uid).catch(() => [] as GoalSchedule[])

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
            if (climbInProgress(cl) || (s && !s.graduated)) lists.learning.push(entry(card))
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

        const activeSchedules = await schedulesP
        const scheduleByPair = new Map(activeSchedules.map(sc => [`${sc.sourceLanguage}|${sc.targetLanguage}`, sc]))
        const scheduleDone = activeSchedules.length === 0
          ? new Map<string, number>()
          : await progressForSchedules({ userId: uid, schedules: activeSchedules, timezone: tz, turnoverHour: turnover })
              .catch(() => new Map<string, number>())
        const statusFor = (key: string) => {
          const sc = scheduleByPair.get(key)
          return sc ? scheduleStatus({ schedule: sc, today, doneSoFar: scheduleDone.get(key) ?? 0, doneToday: gradToday.get(key) ?? 0 }) : null
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
            // A live schedule OWNS this pair's goal — it has already absorbed any missed day, so
            // carryover on top would charge for it twice.
            const sched = statusFor(key)
            if (sched) {
              return { key, label: `${langName(p.sourceLanguage)} → ${langName(p.targetLanguage)}`,
                       baseGoal: sched.goal, goal: sched.goal, delta: 0, done: gradToday.get(key) ?? 0 }
            }
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

        // The combined ceiling clamps the whole set, matching the study dashboard exactly — the two
        // lists deliberately show different SLICES, but the number for a given language must agree.
        const ceiling = (profile?.daily_word_ceiling as number | null) ?? null
        if (ceiling && ceiling > 0) {
          const share = shareDayAcrossLanguages(ceiling, goals.map(g => ({ key: g.key, words: g.goal })))
          for (const g of goals) g.goal = share.get(g.key) ?? g.goal
        }
        const remainingNew = goals.reduce((sum, g) => sum + Math.max(0, g.goal - g.done), 0)

        /**
         * The running full-debt balance per language: how many cards you'd need to have finished by
         * now to be level. Negative = owed, positive = banked.
         *
         * Full-debt mode only — it's the only mode with a cumulative balance to report. Unlike
         * `goals` above, this deliberately keeps pairs with NO goal today: a language you owe 30
         * cards on must not vanish from the standing because today happens to be a rest day.
         */
        const standings = pairs.flatMap((p: LanguagePair) => {
              const key = `${p.sourceLanguage}|${p.targetLanguage}`
              // A scheduled language reports its own balance — `pace`, measured against the plan's
              // capacity rather than calendar days — and does so in EVERY mode, not just full debt,
              // because a schedule always has a cumulative position to be ahead or behind of.
              const sched = statusFor(key)
              if (sched) return [{ key, label: `${langName(p.sourceLanguage)} → ${langName(p.targetLanguage)}`, standing: sched.pace }]
              if (!(fullDebtOn && fullDebtSince)) return []
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

        // ── Goal progress ──
        // A row per language: a full progress row when there's a deadline to work toward, and a
        // compact "8 a day" row when the goal is just a recurring number. A recurring goal has no
        // finish line, so rendering it as a target would be a bar stuck at 0% forever.
        const scheduleGoals: ScheduleGoalRow[] = []

        for (const p of pairs as LanguagePair[]) {
          const key = `${p.sourceLanguage}|${p.targetLanguage}`
          const label = `${langName(p.sourceLanguage)} → ${langName(p.targetLanguage)}`
          const sc = scheduleByPair.get(key)
          const st = sc ? statusFor(key) : null

          // ── A deadline to work toward ──
          if (sc && st && !st.isPattern) {
            const doneSoFar = scheduleDone.get(key) ?? 0
          // `new_words` counts only what happened during the schedule, so its progress IS doneSoFar.
          // `total_words` counts the whole vocabulary, so the work done is what's above the baseline.
            const learnedSince = sc.targetKind === 'total_words'
              ? Math.max(0, doneSoFar - sc.baselineCount)
              : doneSoFar
            const next = st.segments.find(seg => !seg.isDeadline) ?? null
            scheduleGoals.push({
              kind: 'target',
              key,
              label,
              name: sc.name,
            target: sc.targetCount,
            baseline: sc.baselineCount,
            learnedSince,
            span: Math.max(0, (sc.targetCount ?? 0) - sc.baselineCount),
            remaining: st.remaining,
            todayGoal: st.goal,
            studyDaysLeft: st.daysLeft,
            // Inclusive of today, and 0 once the deadline has passed — `daysBetween` floors at 0.
            calendarDaysLeft: sc.deadline ? daysBetween(today, sc.deadline) : null,
            startDate: sc.startDate,
            deadline: sc.deadline,
            pace: st.pace,
            feasible: st.feasible,
            shortfall: st.shortfall,
            done: st.done,
            expired: st.expired,
            isPattern: st.isPattern,
              nextCheckpoint: next
                ? { date: next.date, target: next.target, remaining: next.remaining }
                : null,
              perDay: null,
              perWeek: 0,
            })
            continue
          }

          // ── Just a recurring number ──
          // From the pattern schedule's own plan when there is one, otherwise from the pair's
          // weekday goals. A language stating no number anywhere is omitted rather than shown as a
          // row of zeroes — that's the noise this replaced.
          let week: number[]
          if (sc && st?.isPattern) {
            week = schedulePlan(sc, today, scheduleDone.get(key) ?? 0).slice(0, 7).map(d => d.words)
          } else {
            week = [0, 1, 2, 3, 4, 5, 6].map(offset => {
              const d = new Date(new Date(today + 'T12:00:00Z').getTime() + offset * 86_400_000)
              const g = p.goals?.[String(d.getUTCDay())]
              return typeof g === 'number' && g > 0 ? g : 0
            })
          }
          const perWeek = week.reduce((a, b) => a + b, 0)
          if (perWeek <= 0) continue

          const uniform = week.every(w => w === week[0])
          scheduleGoals.push({
            kind: 'recurring',
            key,
            label,
            name: sc?.name ?? null,
            target: null,
            baseline: 0,
            learnedSince: sc ? (scheduleDone.get(key) ?? 0) : (gradToday.get(key) ?? 0),
            span: 0,
            remaining: 0,
            // The status's goal, not the plan's first day — with debt on they differ (carry + cap).
            todayGoal: st ? st.goal : week[0] ?? 0,
            studyDaysLeft: week.filter(w => w > 0).length,
            calendarDaysLeft: null,
            // A pattern schedule knows when it began; plain weekday goals don't, so "learned since"
            // falls back to today's count and says so.
            startDate: sc?.startDate ?? null,
            deadline: null,
            // The engine reports every pattern's real position vs its configured plan (debt or not);
            // only schedule-less weekday goals have no start date to measure from and stay at 0.
            pace: st?.pace ?? 0,
            feasible: true,
            shortfall: 0,
            done: false,
            expired: false,
            isPattern: true,
            nextCheckpoint: null,
            perDay: uniform ? (week[0] ?? 0) : null,
            perWeek,
          })
        }

        if (!cancelled) setData({
          lists, counts, goals, standings, fullDebtSince, scheduleGoals,
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

      {/* 3. Goal progress — one card per live schedule. "Today's goals" above answers what you owe
             right now; this answers whether the whole thing is on track: what you've done since you
             set it, what's left, and how long there is to do it in. */}
      {data.scheduleGoals.length > 0 && (
        <div className="panel space-y-4">
          <div>
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Goal progress</h2>
            <p className="text-xs text-ink-faint mt-1">
              Where each language stands. A goal with a deadline shows how far through it you are;
              one that&apos;s just a number per day or week shows that number. Everything is
              recalculated from what you&apos;ve actually done — nothing is banked, so getting ahead
              lightens the days that are left.
            </p>
          </div>

          {data.scheduleGoals.map(g => {
            const pct = g.span > 0 ? Math.min(100, Math.round((g.learnedSince / g.span) * 100)) : 0
            const tone = g.done ? 'bg-success' : !g.feasible ? 'bg-danger' : 'bg-accent'
            return (
              <div key={g.key} className="space-y-2 pt-3 first:pt-0 border-t first:border-t-0 border-line/10">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-ink">
                    {g.label}
                    {g.name && <span className="text-ink-faint"> · {g.name}</span>}
                  </span>
                  <span className="text-xs text-ink-faint">
                    {g.kind === 'recurring'
                      ? (g.perDay != null
                          ? `${g.perDay} a day`
                          : `${g.perWeek} a week · ${g.studyDaysLeft} study day${g.studyDaysLeft === 1 ? '' : 's'}`)
                      : g.done ? 'Target reached ✓'
                      : g.expired ? `Deadline passed ${shortDate(g.deadline!)}`
                      : `by ${shortDate(g.deadline!)}`}
                  </span>
                </div>

                {g.kind === 'target' && (
                  <>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-ink-muted">
                        {`${g.learnedSince} of ${g.span} words`}
                        {g.target != null && g.baseline > 0 && (
                          <span className="text-ink-faint">{` · ${g.baseline} → ${g.target} total`}</span>
                        )}
                      </span>
                      <span className={g.done ? 'text-success' : 'text-ink-muted'}>{pct}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-line/10 overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${pct}%` }} />
                    </div>
                  </>
                )}

                <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
                  <Metric
                    label={g.startDate ? 'Learned since' : 'Learned today'}
                    value={`${g.learnedSince}`}
                    hint={g.startDate ? `from ${shortDate(g.startDate)}` : 'words'}
                  />
                  {g.kind === 'target' && (
                    <Metric label="Still to go" value={`${g.remaining}`} hint="words" />
                  )}
                  <Metric label="Today" value={g.done ? '—' : `${g.todayGoal}`} hint="words" />
                  {g.calendarDaysLeft != null && (
                    <Metric
                      label="Days left"
                      value={`${g.calendarDaysLeft}`}
                      // Study days differ from calendar days whenever there are days off, and that
                      // gap is exactly what makes a deadline tighter than it looks.
                      hint={g.studyDaysLeft !== g.calendarDaysLeft ? `${g.studyDaysLeft} of them study days` : 'calendar days'}
                    />
                  )}
                  {/* Recurring goals get a pace too, as long as a schedule gives them a start date
                      to measure from — "am I ahead of my 8-a-day" is as real as any deadline pace.
                      Plain weekday goals (no schedule) have no start, so nothing honest to show. */}
                  {(g.kind === 'target' || g.startDate != null) && (
                    <Metric
                      label="Pace"
                      value={g.pace === 0 ? 'Level' : g.pace > 0 ? `+${g.pace}` : `${g.pace}`}
                      hint={g.pace === 0 ? 'on track' : g.pace > 0 ? 'words ahead' : 'words behind'}
                      tone={g.pace < 0 ? 'danger' : g.pace > 0 ? 'success' : 'muted'}
                    />
                  )}
                  {g.nextCheckpoint && (
                    <Metric
                      label="Next checkpoint"
                      value={`${g.nextCheckpoint.remaining}`}
                      hint={`more by ${shortDate(g.nextCheckpoint.date)}`}
                    />
                  )}
                </div>

                {!g.feasible && !g.done && (
                  <p className="text-xs text-danger">
                    {`${g.shortfall} word${g.shortfall === 1 ? '' : 's'} more than the days left can hold. Raise the daily limit, push the deadline back, or lower the target in Settings → Daily goals.`}
                  </p>
                )}
                {g.expired && !g.done && (
                  <p className="text-xs text-warning">
                    {`The deadline passed with ${g.remaining} to go. Retire or re-date it in Settings → Daily goals.`}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 3. Current standing — the running balance: the full-debt total for carryover languages, and
             `pace` (progress vs the plan) for scheduled ones. Both answer "how far ahead or behind
             am I", so they share the panel; only full debt has a meaningful "since" date. */}
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
