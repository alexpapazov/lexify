'use client'

/**
 * app/settings/goals/page.tsx — the full-screen daily goals editor.
 *
 * Lifted out of the Language configuration page (2026-08-08) for the same reason the ladder editor
 * lives at `/settings/ladders`: a goal is now a configurable object, not a number in a box, and a
 * schedule needs room for its limits, checkpoints and plan preview.
 *
 * Two families of goal, chosen per language:
 *   • **Fixed** (`daily` / `weekday`) — a recurring target from `language_pairs.goals`, optionally
 *     adjusted by the carryover settings at the bottom of the page.
 *   • **Adaptive** (`schedule`) — a deadline in `goal_schedules`, with the daily number derived from
 *     what's left. A live schedule SUPERSEDES both the weekday goals and carryover for that language;
 *     see `features/Goal Scheduler.md` for why stacking them would double-count a missed day.
 *
 * Weekday numbers save on blur (they're one integer each). The carryover block has an explicit Save
 * because turning full debt on stamps a date and the per-language resets are irreversible.
 */

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseGoalScheduleRepository } from '@/lib/data/goalSchedules'
import { GoalScheduleEditor } from '@/components/settings/GoalScheduleEditor'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { getToday } from '@/lib/dates'
import { langName } from '@/lib/languages'
import type { LanguagePair } from '@/domain'

/**
 * How a language's goal is set. 'daily'/'weekday' write `language_pairs.goals`; 'schedule' hands the
 * pair to a `goal_schedules` row and ignores both the weekday numbers and carryover.
 */
type GoalMode = 'daily' | 'weekday' | 'schedule'

const WEEKDAYS: { day: number; label: string }[] = [
  { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' }, { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' }, { day: 0, label: 'Sun' },
]

const pairLabel = (p: LanguagePair) => `${langName(p.sourceLanguage)} → ${langName(p.targetLanguage)}`

export default function GoalsPage() {
  const supabase = createClient()

  const [userId,       setUserId]       = useState('')
  const [langPairs,    setLangPairs]    = useState<LanguagePair[]>([])
  const [timezone,     setTimezone]     = useState('')
  const [turnoverHour, setTurnoverHour] = useState(0)
  const [loading,      setLoading]      = useState(true)

  const [goalDrafts,     setGoalDrafts]     = useState<Record<string, Record<string, string>>>({})
  const [goalModes,      setGoalModes]      = useState<Record<string, GoalMode>>({})
  const [goalSavingKey,  setGoalSavingKey]  = useState<string | null>(null)
  /** Pair keys with a live schedule — they open in schedule mode and ignore carryover entirely. */
  const [scheduledPairs, setScheduledPairs] = useState<Set<string>>(new Set())

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

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setLoading(false); return }
      const uid = session.user.id
      setUserId(uid)

      const [profileRes, pairs, scheduleKeys] = await Promise.all([
        supabase.from('profiles')
          .select('timezone, day_turnover_hour, goal_carry_shortfall, goal_carry_surplus, goal_full_debt, goal_full_debt_since, goal_full_debt_resets, full_debt_skip_shortfall_days, full_debt_skip_surplus_days')
          .eq('user_id', uid).maybeSingle(),
        new SupabaseLanguagePairRepository().list(uid),
        // A missing goal_schedules table (migration 114 not yet run) must not blank the page — the
        // weekday editors below work perfectly well without it.
        new SupabaseGoalScheduleRepository().listActive(uid)
          .then(rows => rows.map(s => `${s.sourceLanguage}|${s.targetLanguage}`))
          .catch(() => [] as string[]),
      ])

      const profile = profileRes.data
      setTimezone((profile?.timezone as string | null) ?? detectBrowserTimezone())
      setTurnoverHour((profile?.day_turnover_hour as number | null) ?? 0)
      setCarryShortfall((profile?.goal_carry_shortfall as boolean | null) ?? false)
      setCarrySurplus((profile?.goal_carry_surplus as boolean | null) ?? false)
      setFullDebt((profile?.goal_full_debt as boolean | null) ?? false)
      setFullDebtSince((profile?.goal_full_debt_since as string | null) ?? null)
      setFullDebtResets((profile?.goal_full_debt_resets as Record<string, string> | null) ?? {})
      setSkipShortfallDays((profile?.full_debt_skip_shortfall_days as string[] | null) ?? [])
      setSkipSurplusDays((profile?.full_debt_skip_surplus_days as string[] | null) ?? [])

      const scheduled = new Set(scheduleKeys)
      setScheduledPairs(scheduled)
      setLangPairs(pairs)

      const drafts: Record<string, Record<string, string>> = {}
      const modes: Record<string, GoalMode> = {}
      for (const pair of pairs) {
        const key = `${pair.sourceLanguage}|${pair.targetLanguage}`
        drafts[key] = {}
        for (let d = 0; d <= 6; d++) {
          const val = pair.goals?.[String(d)]
          drafts[key][String(d)] = typeof val === 'number' ? String(val) : ''
        }
        // Default to "daily" when every weekday holds the same value, else "weekday" — unless a live
        // schedule owns the pair, in which case showing weekday boxes would be a lie.
        const vals = [0, 1, 2, 3, 4, 5, 6].map(d => drafts[key]![String(d)])
        modes[key] = scheduled.has(key) ? 'schedule' : (vals.every(v => v === vals[0]) ? 'daily' : 'weekday')
      }
      setGoalDrafts(drafts)
      setGoalModes(modes)
      setLoading(false)
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
  const fixedPairs = langPairs.filter(p => goalModes[`${p.sourceLanguage}|${p.targetLanguage}`] !== 'schedule')

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-5">
      <div>
        <a href="/settings/language" className="inline-block text-xs text-ink-faint hover:text-ink">
          ← Language configuration
        </a>
        <h1 className="text-2xl font-semibold text-ink mt-3">Daily goals</h1>
        <p className="text-sm text-ink-muted mt-1">
          How many words you aim to graduate, per language. Set a <span className="text-ink">fixed</span> number
          that repeats — every day or per weekday — or an <span className="text-ink">adaptive schedule</span> that
          works backwards from a deadline and recalculates the daily number as you go.
        </p>
      </div>

      {langPairs.length === 0 && (
        <p className="panel text-sm text-ink-faint">
          No languages yet. Add one from the Library, then set its goal here.
        </p>
      )}

      {/* ── One panel per language, full width so a schedule has room ── */}
      {langPairs.map(pair => {
        const pairKey = `${pair.sourceLanguage}|${pair.targetLanguage}`
        const drafts  = goalDrafts[pairKey] ?? {}
        const mode    = goalModes[pairKey] ?? 'daily'
        // daily -> collapse every weekday to one value and save. schedule -> only reveal the editor;
        // nothing is written until it's saved, and the weekday goals stay stored underneath so
        // retiring a schedule restores them.
        const setMode = (next: GoalMode) => {
          setGoalModes(prev => ({ ...prev, [pairKey]: next }))
          if (next === 'daily') {
            const common = drafts['0'] ?? ''
            const collapsed: Record<string, string> = {}
            for (let d = 0; d <= 6; d++) collapsed[String(d)] = common
            setGoalDrafts(prev => ({ ...prev, [pairKey]: collapsed }))
            void handleGoalBlur(pair.sourceLanguage, pair.targetLanguage, collapsed)
          }
        }

        return (
          <div key={pairKey} className="panel space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-medium text-ink">{pairLabel(pair)}</h2>
                <p className="text-xs text-ink-faint mt-0.5">
                  {mode === 'schedule'
                    ? (scheduledPairs.has(pairKey)
                        ? 'Adaptive — the daily number comes from the deadline below.'
                        : 'Adaptive — nothing is active until you start a schedule below.')
                    : mode === 'daily'
                      ? 'Fixed — the same target every day.'
                      : 'Fixed — a different target for each weekday.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {goalSavingKey === pairKey && <span className="text-xs text-ink-faint">Saving…</span>}
                <div className="flex rounded-lg border border-line/10 p-0.5 text-sm">
                  {(['daily', 'weekday', 'schedule'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`px-3 py-1 rounded-md transition-colors ${mode === m ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}
                    >
                      {m === 'daily' ? 'Daily' : m === 'weekday' ? 'Per weekday' : 'Schedule'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {mode === 'schedule' ? (
              <GoalScheduleEditor
                userId={userId}
                sourceLanguage={pair.sourceLanguage}
                targetLanguage={pair.targetLanguage}
                label={pairLabel(pair)}
                timezone={timezone || deviceTimeZone()}
                turnoverHour={turnoverHour}
                onChanged={(has) => setScheduledPairs(prev => {
                  const next = new Set(prev)
                  if (has) next.add(pairKey); else next.delete(pairKey)
                  return next
                })}
              />
            ) : mode === 'daily' ? (
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

      {/* ── Carryover — fixed-goal languages only ──
          Adjusts the goal NUMBER only; it never raises how many new cards you're served. */}
      {langPairs.length > 0 && (
        <div className="panel space-y-4">
          <div>
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Carryover</h2>
            <p className="text-xs text-ink-faint mt-1">
              What happens when you miss a fixed goal, or beat it. Adjusts the target number only — it
              never changes how many new cards you&apos;re served.
            </p>
          </div>

          {scheduledPairs.size > 0 && (
            <p className="text-xs text-ink-faint">
              {`Doesn't apply to ${[...scheduledPairs].map(k => langName(k.split('|')[0] ?? '')).join(', ')} — a schedule already spreads whatever you miss across the days it has left.`}
              {fixedPairs.length === 0 && ' Every language is on a schedule right now, so nothing here is in use.'}
            </p>
          )}

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
