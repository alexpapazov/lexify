'use client'

/**
 * app/settings/goals/page.tsx — the full-screen daily goals editor.
 *
 * Lifted out of the Language configuration page (2026-08-08) for the same reason the ladder editor
 * lives at `?section=ladders`: a goal is now a configurable object, not a number in a box, and a
 * schedule needs room for its limits, checkpoints and plan preview.
 *
 * ── One mode for everything ──
 * The Daily / Per weekday / Schedule toggle is GLOBAL (`profiles.goal_mode`, migration 115), not
 * per-language: "am I working to a repeating number or to a deadline" is a decision about how you
 * study, not about Spanish specifically. Each language still has its own numbers or its own schedule
 * underneath — the toggle chooses which of those is being edited.
 *
 * The mode is a UI concept. What actually drives the goal surfaces is still "does this pair have a
 * non-archived `goal_schedules` row" (see `features/Goal Scheduler.md` §2), which is why leaving
 * Schedule mode OFFERS TO RETIRE the live schedules: otherwise they would keep setting your daily
 * goal from behind a page showing weekday boxes.
 *
 * Weekday numbers save on blur (they're one integer each). The carryover block has an explicit Save
 * because turning full debt on stamps a date and the per-language resets are irreversible.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseGoalScheduleRepository, progressForSchedules } from '@/lib/data/goalSchedules'
import { GoalScheduleEditor } from '@/components/settings/GoalScheduleEditor'
import { GoalScheduleOverview, type OverviewLanguage } from '@/components/settings/GoalScheduleOverview'
import { assignedPlan, schedulePlan, planEnd, eachDate } from '@/lib/goalSchedule'
import { applyDailyCeiling } from '@/lib/dailyCeiling'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { getToday } from '@/lib/dates'
import { langName, assignLanguageColors } from '@/lib/languages'
import { invalidateReads } from '@/lib/readCache'
import type { GoalSchedule, LanguagePair } from '@/domain'

/** How goals are set, for every language at once. */
type GoalMode = 'daily' | 'weekday' | 'schedule'

const WEEKDAYS: { day: number; label: string }[] = [
  { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' }, { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' }, { day: 0, label: 'Sun' },
]

const pairLabel = (p: LanguagePair) => `${langName(p.sourceLanguage)} → ${langName(p.targetLanguage)}`

/** Everything the profile read needs, minus the columns a pending migration might not have yet. */
const PROFILE_CORE = 'timezone, day_turnover_hour, language_colors, goal_carry_shortfall, goal_carry_surplus, goal_full_debt, goal_full_debt_since, goal_full_debt_resets, full_debt_skip_shortfall_days, full_debt_skip_surplus_days'

/**
 * The Daily goals editor, rendered inside the Settings shell (`?section=goals`). It owns its own data
 * and the goal-mode toggle; the shell supplies the page chrome, so there is no back link or page
 * title here.
 */
export function GoalsSettings() {
  const supabase = createClient()

  const [userId,       setUserId]       = useState('')
  const [langPairs,    setLangPairs]    = useState<LanguagePair[]>([])
  const [timezone,     setTimezone]     = useState('')
  const [turnoverHour, setTurnoverHour] = useState(0)
  const [langColors,   setLangColors]   = useState<Record<string, string>>({})
  const [loading,      setLoading]      = useState(true)

  const [goalMode,      setGoalMode]      = useState<GoalMode>('daily')
  const [modeSupported, setModeSupported] = useState(true)   // false until migration 115 is applied
  /** Max new words across ALL languages per day (migration 116). Null = no combined limit. */
  const [dailyCeiling,      setDailyCeiling]      = useState<string>('')
  const [ceilingSupported,  setCeilingSupported]  = useState(true)
  const [goalDrafts,    setGoalDrafts]    = useState<Record<string, Record<string, string>>>({})
  const [goalSavingKey, setGoalSavingKey] = useState<string | null>(null)
  /** Pair keys with a live schedule. */
  const [scheduledPairs, setScheduledPairs] = useState<Set<string>>(new Set())
  const [confirmLeaveSchedule, setConfirmLeaveSchedule] = useState<GoalMode | null>(null)

  const [overview,      setOverview]      = useState<OverviewLanguage[]>([])
  const [liveSchedules, setLiveSchedules] = useState<GoalSchedule[]>([])
  const [overviewBusy,  setOverviewBusy]  = useState(false)
  /** What the combined ceiling pushed past the end of the plan, and which days it had to defer. */
  const [spill, setSpill] = useState<{ overflow: Map<string, number>; deferredDays: string[] }>({ overflow: new Map(), deferredDays: [] })
  /** Bumped after a bulk edit so the per-language editors remount and reload from the server. */
  const [editorEpoch,   setEditorEpoch]   = useState(0)

  const [carryShortfall,   setCarryShortfall]   = useState(false)
  const [carrySurplus,     setCarrySurplus]     = useState(false)
  const [fullDebt,         setFullDebt]         = useState(false)
  const [fullDebtSince,    setFullDebtSince]    = useState<string | null>(null)
  /** Per-language debt resets (migration 109): `${src}|${tgt}` → the date to start counting from. */
  const [fullDebtResets,   setFullDebtResets]   = useState<Record<string, string>>({})
  // Study-days waived from full-debt carryover. "Checked" = today is in the list, so each box
  // auto-unchecks once the day turns over, while past waivers stay honoured in the running total.
  const [skipShortfallDays, setSkipShortfallDays] = useState<string[]>([])
  const [skipSurplusDays,   setSkipSurplusDays]   = useState<string[]>([])
  const [saved,             setSaved]             = useState(false)

  /** The combined limit as a number, or null when blank / not yet migrated. */
  const parsedCeiling = ceilingSupported && dailyCeiling.trim() !== ''
    ? (parseInt(dailyCeiling, 10) || null)
    : null

  const colorByCode = useMemo(
    () => assignLanguageColors(langPairs.map(p => p.sourceLanguage), langColors),
    [langPairs, langColors],
  )

  // ── Load ──
  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setLoading(false); return }
      const uid = session.user.id
      setUserId(uid)

      // `goal_mode` arrives with migration 115. Selecting a column that doesn't exist yet errors the
      // WHOLE query and would silently reset the timezone and every carryover flag to its default —
      // the landmine documented in CLAUDE.md. So: try the full select, fall back to the core one.
      // Widest select first, narrowing on error. `goal_mode` needs migration 115 and
      // `daily_word_ceiling` needs 116, and either may be unapplied.
      let profileRes = await supabase.from('profiles').select(`${PROFILE_CORE}, goal_mode, daily_word_ceiling`).eq('user_id', uid).maybeSingle()
      if (profileRes.error) {
        setCeilingSupported(false)
        profileRes = await supabase.from('profiles').select(`${PROFILE_CORE}, goal_mode`).eq('user_id', uid).maybeSingle()
      }
      if (profileRes.error) {
        setModeSupported(false)
        profileRes = await supabase.from('profiles').select(PROFILE_CORE).eq('user_id', uid).maybeSingle()
      }
      const profile = profileRes.data as Record<string, unknown> | null

      const [pairs, scheduleRows] = await Promise.all([
        new SupabaseLanguagePairRepository().list(uid),
        // A missing goal_schedules table (migration 114 not run) must not blank the page — the
        // weekday editors work perfectly well without it.
        // anyMode: settings must SEE schedules even outside Schedule mode (listActive is
        // mode-gated for every other surface) — you cannot retire what you cannot see.
        new SupabaseGoalScheduleRepository().listActive(uid, { anyMode: true }).catch(() => [] as GoalSchedule[]),
      ])

      const tz = (profile?.timezone as string | null) ?? detectBrowserTimezone()
      const turnover = (profile?.day_turnover_hour as number | null) ?? 0
      setTimezone(tz)
      setTurnoverHour(turnover)
      setLangColors((profile?.language_colors as Record<string, string> | null) ?? {})
      const ceil = profile?.daily_word_ceiling as number | null | undefined
      setDailyCeiling(ceil == null ? '' : String(ceil))
      setCarryShortfall((profile?.goal_carry_shortfall as boolean | null) ?? false)
      setCarrySurplus((profile?.goal_carry_surplus as boolean | null) ?? false)
      setFullDebt((profile?.goal_full_debt as boolean | null) ?? false)
      setFullDebtSince((profile?.goal_full_debt_since as string | null) ?? null)
      setFullDebtResets((profile?.goal_full_debt_resets as Record<string, string> | null) ?? {})
      setSkipShortfallDays((profile?.full_debt_skip_shortfall_days as string[] | null) ?? [])
      setSkipSurplusDays((profile?.full_debt_skip_surplus_days as string[] | null) ?? [])

      const scheduled = new Set(scheduleRows.map(s => `${s.sourceLanguage}|${s.targetLanguage}`))
      setScheduledPairs(scheduled)
      setLangPairs(pairs)

      // The STORED mode is authoritative — the mode toggle is the user's explicit choice, and
      // `listActive` is gated on it everywhere else. Live schedules only infer schedule mode when
      // the column was never set (pre-migration-115 accounts). The old rule ("a live schedule means
      // schedule mode, whatever the column says") let one zombie schedule silently flip the whole
      // goals system back to schedules.
      const stored = (profile?.goal_mode as GoalMode | null) ?? null
      setGoalMode(stored ?? (scheduled.size > 0 ? 'schedule' : 'daily'))

      const drafts: Record<string, Record<string, string>> = {}
      for (const pair of pairs) {
        const key = `${pair.sourceLanguage}|${pair.targetLanguage}`
        drafts[key] = {}
        for (let d = 0; d <= 6; d++) {
          const val = pair.goals?.[String(d)]
          drafts[key][String(d)] = typeof val === 'number' ? String(val) : ''
        }
      }
      setGoalDrafts(drafts)
      setLoading(false)
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Rebuilds the combined overview from the SAVED schedules. Past days use the plan as ASSIGNED
   * (`assignedPlan`), future days the live re-spread plan — the same split the per-language calendar
   * makes, and for the same reason: a past day's target is a historical record.
   */
  const refreshOverview = useCallback(async () => {
    if (!userId || langPairs.length === 0) return
    setOverviewBusy(true)
    try {
      const schedules = await new SupabaseGoalScheduleRepository().listActive(userId).catch(() => [] as GoalSchedule[])
      setScheduledPairs(new Set(schedules.map(s => `${s.sourceLanguage}|${s.targetLanguage}`)))
      setLiveSchedules(schedules)
      if (schedules.length === 0) { setOverview([]); return }

      const tz = timezone || deviceTimeZone()
      const today = getToday(tz, turnoverHour)
      const done = await progressForSchedules({ userId, schedules, timezone: tz, turnoverHour })
        .catch(() => new Map<string, number>())

      // Each language's own plan first…
      const raw = new Map<string, Map<string, number>>()
      for (const s of schedules) {
        const key = `${s.sourceLanguage}|${s.targetLanguage}`
        const plan = new Map<string, number>()
        for (const [date, words] of assignedPlan(s, today)) if (date < today) plan.set(date, words)
        for (const day of schedulePlan(s, today, done.get(key) ?? 0)) plan.set(day.date, day.words)
        raw.set(key, plan)
      }

      // …then the combined ceiling, which is a real CAP: whatever doesn't fit on a day moves to the
      // next one and is capped again there. Only applied from TODAY forward — a past day's plan is a
      // historical record, and re-capping it would rewrite what those days were assigned.
      const from = schedules.reduce((min, s) => (s.startDate < min ? s.startDate : min), today)
      const to = schedules.reduce((max, s) => (planEnd(s, today) > max ? planEnd(s, today) : max), today)
      const future = eachDate(today > from ? today : from, to)
      const futureDemand = new Map(
        [...raw].map(([key, plan]) => [key, new Map([...plan].filter(([d]) => d >= today))]),
      )
      const capped = applyDailyCeiling({ dates: future, demand: futureDemand, ceiling: parsedCeiling })
      setSpill({ overflow: capped.overflow, deferredDays: capped.deferredDays })

      setOverview(schedules.map(s => {
        const key = `${s.sourceLanguage}|${s.targetLanguage}`
        const plan = new Map<string, number>()
        for (const [date, words] of raw.get(key) ?? []) if (date < today) plan.set(date, words)
        for (const [date, words] of capped.planned.get(key) ?? []) plan.set(date, words)
        const pair = langPairs.find(p => `${p.sourceLanguage}|${p.targetLanguage}` === key)
        return {
          key,
          label: pair ? pairLabel(pair) : `${langName(s.sourceLanguage)} → ${langName(s.targetLanguage)}`,
          color: colorByCode[s.sourceLanguage] ?? '#888888',
          plan,
          startDate: s.startDate,
          deadline: s.deadline,
          planEnd: planEnd(s, today),
        }
      }))
    } finally { setOverviewBusy(false) }
  }, [userId, langPairs, timezone, turnoverHour, colorByCode, parsedCeiling])

  useEffect(() => {
    if (goalMode === 'schedule') void refreshOverview()
  }, [goalMode, refreshOverview])

  /**
   * Applies a change to EVERY live schedule. Each schedule still owns its own days — this just spares
   * you setting the same "I'm away" or "never on Sundays" on each one by hand, which is the whole
   * point of having a combined view.
   */
  const bulkUpdate = useCallback(async (mutate: (s: GoalSchedule) => GoalSchedule) => {
    if (!userId) return
    setOverviewBusy(true)
    try {
      const repo = new SupabaseGoalScheduleRepository()
      const live = await repo.listActive(userId, { anyMode: true }).catch(() => [] as GoalSchedule[])
      for (const s of live) {
        const next = mutate(s)
        await repo.save(userId, {
          sourceLanguage: next.sourceLanguage, targetLanguage: next.targetLanguage,
          name: next.name, targetKind: next.targetKind, targetCount: next.targetCount,
          startDate: next.startDate, deadline: next.deadline, baselineCount: next.baselineCount,
          dailyCeiling: next.dailyCeiling, weekdayLimits: next.weekdayLimits,
          dateExceptions: next.dateExceptions, weeklyTarget: next.weeklyTarget,
          debtCarryMissed: next.debtCarryMissed, debtCarryExtra: next.debtCarryExtra,
          debtResetAt: next.debtResetAt, checkpoints: next.checkpoints,
        }, s.id).catch(() => {})
      }
    } finally { setOverviewBusy(false) }
    await refreshOverview()
    setEditorEpoch(e => e + 1)   // remount the editors so they pick the change up
  }, [userId, refreshOverview])

  const bulkDateCaps = useCallback((dates: string[], cap: number | null) => {
    void bulkUpdate(s => {
      const next = { ...(s.dateExceptions ?? {}) }
      for (const d of dates) {
        // Only touch days the schedule actually covers; a shared range can span schedules that
        // start later or end sooner, and writing outside the span would be dead data.
        if (d < s.startDate || (s.deadline && d > s.deadline)) continue
        if (cap == null) delete next[d]
        else next[d] = Math.max(0, cap)
      }
      return { ...s, dateExceptions: Object.keys(next).length ? next : null }
    })
  }, [bulkUpdate])

  const bulkWeekdayOff = useCallback((weekday: number, off: boolean) => {
    void bulkUpdate(s => {
      const next = { ...(s.weekdayLimits ?? {}) }
      // Turning a rest day back ON clears the entry entirely rather than writing a number — the day
      // should return to following the ceiling, not to some value this control invented.
      if (off) next[String(weekday)] = 0
      else delete next[String(weekday)]
      return { ...s, weekdayLimits: Object.keys(next).length ? next : null }
    })
  }, [bulkUpdate])

  /** Weekdays set to 0 on EVERY live schedule — the only ones that read as a global rest day. */
  const restDays = useMemo(() => {
    if (overview.length === 0) return []
    return [0, 1, 2, 3, 4, 5, 6].filter(d => liveSchedules.length > 0
      && liveSchedules.every(s => s.weekdayLimits?.[String(d)] === 0))
  }, [overview, liveSchedules])

  const handleGoalBlur = useCallback(async (
    sourceLanguage: string,
    targetLanguage: string,
    draftsOverride?: Record<string, string>,
  ) => {
    const key = `${sourceLanguage}|${targetLanguage}`
    const drafts = draftsOverride ?? goalDrafts[key] ?? {}
    const goals: Record<string, number | null> = {}
    for (let d = 0; d <= 6; d++) {
      const raw = (drafts[String(d)] ?? '').trim()
      goals[String(d)] = raw ? (parseInt(raw, 10) || null) : null
    }
    setGoalSavingKey(key)
    try { await new SupabaseLanguagePairRepository().updateGoals(sourceLanguage, targetLanguage, goals) }
    finally { setGoalSavingKey(null) }
  }, [goalDrafts])

  /** Persists the global mode. Silently a no-op until migration 115 is applied. */
  const persistMode = useCallback(async (mode: GoalMode) => {
    if (!userId || !modeSupported) return
    await supabase.from('profiles').update({ goal_mode: mode }).eq('user_id', userId).then(() => {}, () => {})
    // listActive's mode gate caches the mode — bust it so the dashboard reflects the switch now,
    // not after the 60s TTL.
    invalidateReads('goalsched:')
  }, [userId, modeSupported]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Switching to Daily collapses every language's seven weekday numbers to one value, so the two
   * fixed modes stay consistent rather than the collapse being a per-language surprise.
   */
  async function applyMode(next: GoalMode) {
    if (next === goalMode) return
    // Leaving Schedule while schedules are live would leave them driving the goals invisibly.
    if (goalMode === 'schedule' && next !== 'schedule' && scheduledPairs.size > 0) {
      setConfirmLeaveSchedule(next)
      return
    }
    setGoalMode(next)
    void persistMode(next)
    if (next === 'daily') {
      for (const pair of langPairs) {
        const key = `${pair.sourceLanguage}|${pair.targetLanguage}`
        const common = goalDrafts[key]?.['0'] ?? ''
        const collapsed: Record<string, string> = {}
        for (let d = 0; d <= 6; d++) collapsed[String(d)] = common
        setGoalDrafts(prev => ({ ...prev, [key]: collapsed }))
        await handleGoalBlur(pair.sourceLanguage, pair.targetLanguage, collapsed)
      }
    }
  }

  /**
   * Retires every live schedule. Returns how many could NOT be archived — the old version swallowed
   * failures silently, which is how zombie schedules survived a mode switch and kept assigning
   * goals to pairs the user had zeroed.
   */
  async function retireAll(): Promise<number> {
    if (!userId) return 0
    const repo = new SupabaseGoalScheduleRepository()
    const live = await repo.listActive(userId, { anyMode: true }).catch(() => [] as GoalSchedule[])
    let failed = 0
    for (const s of live) {
      try { await repo.archive(s.id) } catch { failed++ }
    }
    const remaining = new Set(
      failed === 0 ? [] :
      (await repo.listActive(userId, { anyMode: true }).catch(() => [] as GoalSchedule[]))
        .map(s => `${s.sourceLanguage}|${s.targetLanguage}`))
    setScheduledPairs(remaining)
    if (remaining.size === 0) { setOverview([]); setLiveSchedules([]) }
    return failed
  }

  /** Retires every live schedule, then completes the mode switch that triggered the prompt. */
  async function retireAllAndSwitch() {
    const next = confirmLeaveSchedule
    if (!next || !userId) return
    await retireAll()
    setConfirmLeaveSchedule(null)
    setGoalMode(next)
    void persistMode(next)
  }

  async function saveDailyCeiling() {
    if (!userId || !ceilingSupported) return
    await supabase.from('profiles')
      .update({ daily_word_ceiling: parsedCeiling })
      .eq('user_id', userId)
      .then(() => {}, () => {})
  }

  /**
   * Writes ONLY the carryover fields. A targeted update rather than the omnibus profile save the
   * settings page does — this page never loaded the other columns, so writing them back would
   * clobber them with defaults.
   */
  async function saveCarryover() {
    if (!userId) return
    await supabase.from('profiles').update({
      goal_carry_shortfall: carryShortfall,
      goal_carry_surplus:   carrySurplus,
      goal_full_debt:       fullDebt,
      // Stamp the enable date the first time it's turned on; clear it when turned off so a later
      // re-enable starts a fresh debt from that day (never retroactively counts old history).
      goal_full_debt_since: fullDebt ? (fullDebtSince ?? getToday(timezone || deviceTimeZone(), turnoverHour)) : null,
      // Turning full debt OFF clears the per-language resets too — they only mean anything relative
      // to a running balance, and a stale one would silently re-apply if it were switched back on.
      goal_full_debt_resets: fullDebt ? fullDebtResets : {},
      // Kept even when full debt is off — a day already waived must stay waived if it's turned back on.
      full_debt_skip_shortfall_days: skipShortfallDays,
      full_debt_skip_surplus_days:   skipSurplusDays,
    }).eq('user_id', userId)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (loading) return <p className="p-6 text-sm text-ink-faint">Loading…</p>

  const todayStr = getToday(timezone || deviceTimeZone(), turnoverHour)

  return (
    <div className="space-y-5">
      <div>
        {/* Mode toggle — at the very top, and it applies to every language at once. */}
        <div className="flex w-fit rounded-lg border border-line/10 p-0.5 text-sm mb-3">
          {(['daily', 'weekday', 'schedule'] as GoalMode[]).map(m => (
            <button key={m} onClick={() => void applyMode(m)}
              className={`px-4 py-1.5 rounded-md transition-colors ${goalMode === m ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}>
              {m === 'daily' ? 'Daily' : m === 'weekday' ? 'Per weekday' : 'Schedule'}
            </button>
          ))}
        </div>

        {goalMode !== 'schedule' && scheduledPairs.size > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-card border border-warning/30 bg-warning/5 px-3 py-2 mb-3">
            <p className="text-xs text-warning">
              {`${scheduledPairs.size} goal schedule${scheduledPairs.size === 1 ? ' is' : 's are'} still live from Schedule mode. ${scheduledPairs.size === 1 ? 'It is' : 'They are'} ignored while you're in this mode, but switching back would revive ${scheduledPairs.size === 1 ? 'it' : 'them'}.`}
            </p>
            <button
              className="text-xs border border-warning/40 text-warning hover:bg-warning/10 px-2.5 py-1 rounded-lg transition-colors shrink-0"
              onClick={() => void retireAll()}
            >
              Retire {scheduledPairs.size === 1 ? 'it' : 'them'}
            </button>
          </div>
        )}

        <h2 className="text-lg font-medium text-ink">Daily goals</h2>
        <p className="text-sm text-ink-muted mt-1">
          {goalMode === 'schedule'
            ? 'Every language works backwards from its own deadline. The daily number is recalculated each morning from the words still to go, so missing a day nudges the rest of the schedule up instead of piling onto tomorrow.'
            : goalMode === 'daily'
              ? 'One target every day, per language.'
              : 'A different target for each day of the week, per language.'}
        </p>
        {!modeSupported && (
          <p className="text-xs text-warning mt-1">
            Migration 115 hasn&apos;t been applied, so this choice won&apos;t be remembered between visits.
          </p>
        )}
      </div>

      {/* Leaving schedule mode — never silently, since a live schedule would keep setting goals. */}
      {confirmLeaveSchedule && (
        <div className="panel space-y-2 border-danger/40">
          <p className="text-sm text-ink">
            {`${scheduledPairs.size} language${scheduledPairs.size === 1 ? ' has a' : 's have'} live schedule${scheduledPairs.size === 1 ? '' : 's'}.`}
          </p>
          <p className="text-xs text-ink-faint">
            A schedule overrides weekday goals wherever it exists, so switching modes without retiring
            them would leave them setting your daily number from behind this page. Retiring keeps the
            schedule on record — you just have to set it up again to resume.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary text-sm py-1.5 px-4" onClick={() => void retireAllAndSwitch()}>
              Retire them and switch
            </button>
            <button className="btn-ghost text-sm py-1.5 px-3" onClick={() => setConfirmLeaveSchedule(null)}>
              Stay on schedules
            </button>
          </div>
        </div>
      )}

      {langPairs.length === 0 && (
        <p className="panel text-sm text-ink-faint">
          No languages yet. Add one from the Library, then set its goal here.
        </p>
      )}

      {/* The combined cap — every mode, not just schedules. A per-language number can't express it:
          three languages at 10 each is 30 however each one is configured. */}
      {ceilingSupported && langPairs.length > 0 && (
        <div className="panel space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm text-ink">Never more than</label>
            <input
              type="number" min={1} max={999}
              className="input text-center text-sm px-2 py-1.5 w-20"
              placeholder="—"
              value={dailyCeiling}
              onChange={e => setDailyCeiling(e.target.value)}
              onBlur={saveDailyCeiling}
            />
            <span className="text-sm text-ink">new words a day, across every language.</span>
          </div>
          <p className="text-xs text-ink-faint">
            {goalMode === 'schedule'
              ? 'A cap, not a warning: whatever doesn\'t fit rolls into the next day and is capped again there. When a day is oversubscribed the limit is shared out so a language wanting only a couple of words still gets them.'
              : 'A cap, not a warning: today\'s goals are trimmed to fit. What\'s withheld only comes back tomorrow if carryover is on below — without it, a trimmed day is simply a lighter day.'}
          </p>
        </div>
      )}

      {/* ── Schedule mode: the combined calendar first, then each language's own editor ── */}
      {goalMode === 'schedule' && langPairs.length > 0 && (
        <div className="panel space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">All languages</h2>
            {overviewBusy && <span className="text-xs text-ink-faint">Updating…</span>}
          </div>
          <GoalScheduleOverview
            languages={overview}
            today={todayStr}
            dailyCeiling={parsedCeiling}
            spillOverflow={spill.overflow}
            deferredDays={spill.deferredDays}
            restDays={restDays}
            onBulkDateCaps={bulkDateCaps}
            onBulkWeekdayOff={bulkWeekdayOff}
          />
        </div>
      )}

      {/* ── One panel per language ── */}
      {langPairs.map(pair => {
        const pairKey = `${pair.sourceLanguage}|${pair.targetLanguage}`
        const drafts  = goalDrafts[pairKey] ?? {}
        const color   = colorByCode[pair.sourceLanguage] ?? '#888888'

        return (
          <div key={pairKey} className="panel space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-medium text-ink flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                {pairLabel(pair)}
              </h2>
              <div className="flex items-center gap-2">
                {goalSavingKey === pairKey && <span className="text-xs text-ink-faint">Saving…</span>}
                {goalMode === 'schedule' && !scheduledPairs.has(pairKey) && (
                  <span className="text-xs text-ink-faint">No schedule yet</span>
                )}
              </div>
            </div>

            {goalMode === 'schedule' ? (
              <GoalScheduleEditor
                key={`${pairKey}:${editorEpoch}`}
                userId={userId}
                sourceLanguage={pair.sourceLanguage}
                targetLanguage={pair.targetLanguage}
                label={pairLabel(pair)}
                color={color}
                timezone={timezone || deviceTimeZone()}
                turnoverHour={turnoverHour}
                onChanged={() => void refreshOverview()}
              />
            ) : goalMode === 'daily' ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-faint select-none">Every day</span>
                  <input
                    type="number" min={1} max={999}
                    className="input text-center text-sm px-2 py-1.5 w-24"
                    placeholder="—"
                    value={drafts['0'] ?? ''}
                    onChange={e => {
                      const v = e.target.value
                      setGoalDrafts(prev => {
                        const next: Record<string, string> = {}
                        for (let d = 0; d <= 6; d++) next[String(d)] = v
                        return { ...prev, [pairKey]: next }
                      })
                    }}
                    onBlur={() => void handleGoalBlur(pair.sourceLanguage, pair.targetLanguage)}
                  />
                  <span className="text-xs text-ink-faint">words. Leave blank for no goal.</span>
                </div>
                {/* The input binds Sunday, but the dashboard reads TODAY'S weekday — so leftover
                    per-weekday values are invisible here while still assigning daily goals ("no
                    goal set, yet the dashboard says 0/4"). Surface and offer to clear them. */}
                {(() => {
                  const values = Array.from({ length: 7 }, (_, d) => (drafts[String(d)] ?? '').trim())
                  if (values.every(v => v === values[0])) return null
                  const summary = values
                    .map((v, d) => (v ? `${WEEKDAYS.find(w => w.day === d)?.label ?? d} ${v}` : null))
                    .filter(Boolean).join(', ')
                  return (
                    <div className="flex items-center gap-2 text-xs text-warning">
                      <span>{`Hidden per-weekday goals still apply: ${summary}. The box above shows Sunday only.`}</span>
                      <button
                        className="border border-warning/40 hover:bg-warning/10 px-2 py-0.5 rounded transition-colors shrink-0"
                        onClick={() => {
                          const cleared: Record<string, string> = {}
                          for (let d = 0; d <= 6; d++) cleared[String(d)] = drafts['0'] ?? ''
                          setGoalDrafts(prev => ({ ...prev, [pairKey]: cleared }))
                          void handleGoalBlur(pair.sourceLanguage, pair.targetLanguage, cleared)
                        }}
                      >
                        Use one value for every day
                      </button>
                    </div>
                  )
                })()}
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-2 max-w-2xl">
                {WEEKDAYS.map(({ day, label }) => (
                  <div key={day} className="flex flex-col items-center gap-1">
                    <span className="text-xs text-ink-faint select-none">{label}</span>
                    <input
                      type="number" min={1} max={999}
                      className="input text-center text-sm px-1 py-1.5 w-full"
                      placeholder="—"
                      value={drafts[String(day)] ?? ''}
                      onChange={e => setGoalDrafts(prev => ({
                        ...prev,
                        [pairKey]: { ...(prev[pairKey] ?? {}), [String(day)]: e.target.value },
                      }))}
                      onBlur={() => void handleGoalBlur(pair.sourceLanguage, pair.targetLanguage)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* ── Carryover — fixed-goal modes only ──
          Adjusts the goal NUMBER only; it never raises how many new cards you're served. A schedule
          derives its own catch-up, so none of this applies in schedule mode. */}
      {langPairs.length > 0 && goalMode !== 'schedule' && (
        <div className="panel space-y-4">
          <div>
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Carryover</h2>
            <p className="text-xs text-ink-faint mt-1">
              What happens when you miss a goal, or beat it. Adjusts the target number only — it never
              changes how many new cards you&apos;re served.
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={carryShortfall} onChange={e => setCarryShortfall(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Make up missed cards the next day</span>
              </label>
              <p className="text-xs text-ink-faint pl-6">
                {carryShortfall
                  ? 'If you fall short of a goal, the difference is added to the next day\'s goal for that language. Only the previous day carries over.'
                  : 'Missed cards are forgiven — each day\'s goal stands on its own.'}
              </p>
            </div>
            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={carrySurplus} onChange={e => setCarrySurplus(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Extra cards count toward the next day</span>
              </label>
              <p className="text-xs text-ink-faint pl-6">
                {carrySurplus
                  ? 'Cards beyond a goal are credited against the next day\'s goal for that language, down to zero. Only the previous day carries over.'
                  : 'Extra cards don\'t reduce the next day\'s goal.'}
              </p>
            </div>
            <div className="space-y-1 pt-2 border-t border-line/10">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={fullDebt} onChange={e => setFullDebt(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Full debt</span>
              </label>
              <p className="text-xs text-ink-faint pl-6">
                {fullDebt
                  ? 'From the day you turned this on, a language\'s entire running shortfall or surplus carries forward — incomplete cards always roll to the next day, and extra study rolls credit forward across as many days as it takes. Supersedes the two options above.'
                  : 'Carryover is limited to the previous day (uses the two options above).'}
              </p>
            </div>

            {/* One-day waivers — only meaningful while full debt is on. Each resets itself at day
                turnover (checked == today is in the list), but the day it waived stays waived. */}
            {fullDebt && (() => {
              const toggle = (list: string[], on: boolean) =>
                on ? Array.from(new Set([...list, todayStr])) : list.filter(d => d !== todayStr)
              return (
                <div className="space-y-3 pl-6 border-l border-line/10">
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="checkbox" checked={skipShortfallDays.includes(todayStr)}
                        onChange={e => setSkipShortfallDays(l => toggle(l, e.target.checked))}
                        className="accent-accent w-4 h-4" />
                      <span className="text-sm text-ink">Do not carry over today&apos;s incomplete cards</span>
                    </label>
                    <p className="text-xs text-ink-faint pl-6">
                      Today&apos;s shortfall is forgiven instead of rolling into the debt. Resets tomorrow — re-check it each day you want it.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="checkbox" checked={skipSurplusDays.includes(todayStr)}
                        onChange={e => setSkipSurplusDays(l => toggle(l, e.target.checked))}
                        className="accent-accent w-4 h-4" />
                      <span className="text-sm text-ink">Do not carry over today&apos;s surplus</span>
                    </label>
                    <p className="text-xs text-ink-faint pl-6">
                      Extra cards done today don&apos;t bank credit against future days. Resets tomorrow — re-check it each day you want it.
                    </p>
                  </div>

                  {/* ── Wipe the accumulated balance ──
                      The debt is derived from history, not stored, so "reset" means "start counting
                      from today": today's goal drops straight back to the configured number. Saved as
                      a date per language (migration 109) rather than a cleared counter, which keeps
                      the whole model stateless. */}
                  <div className="space-y-2 pt-1">
                    <p className="text-sm text-ink">Reset the running balance</p>
                    <p className="text-xs text-ink-faint">
                      Clears everything owed or banked so far and puts today&apos;s goal back to the
                      number you set above. Takes effect on save.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setFullDebtResets(Object.fromEntries(
                          langPairs.map(p => [`${p.sourceLanguage}|${p.targetLanguage}`, todayStr]),
                        ))}
                        className="text-xs px-3 py-1.5 rounded-full border border-danger/30 text-ink hover:bg-danger/10 transition-colors"
                      >
                        Reset all
                      </button>
                      {langPairs.map(p => {
                        const key = `${p.sourceLanguage}|${p.targetLanguage}`
                        const isReset = fullDebtResets[key] === todayStr
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setFullDebtResets(prev => {
                              const next = { ...prev }
                              // Clicking again un-does a reset you haven't saved yet.
                              if (next[key] === todayStr) delete next[key]
                              else next[key] = todayStr
                              return next
                            })}
                            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                              isReset
                                ? 'border-danger bg-danger/15 text-ink'
                                : 'border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40'}`}
                          >
                            {isReset ? '✓ ' : ''}{langName(p.sourceLanguage)}
                          </button>
                        )
                      })}
                    </div>
                    {Object.values(fullDebtResets).includes(todayStr) && (
                      <p className="text-xs text-warning">
                        {`${Object.values(fullDebtResets).filter(d => d === todayStr).length} language${Object.values(fullDebtResets).filter(d => d === todayStr).length === 1 ? '' : 's'} will be reset when you save. This can't be undone afterwards.`}
                      </p>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-line/10">
            <button className="btn-primary text-sm py-1.5 px-4" onClick={saveCarryover}>
              {saved ? 'Saved ✓' : 'Save carryover'}
            </button>
            <span className="text-xs text-ink-faint">Weekday numbers above save on their own.</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** Same browser-timezone default the settings page uses when a profile has none stored. */
function detectBrowserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' }
}
