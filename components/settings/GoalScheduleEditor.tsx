'use client'

/**
 * components/settings/GoalScheduleEditor.tsx — build a "N words by date D" schedule for one pair.
 *
 * Everything below the form is DERIVED, live, from `lib/goalSchedule.ts` — today's number, the plan,
 * whether it's possible. Nothing is precomputed and stored, so what the preview shows is exactly what
 * the goal surfaces will show tomorrow.
 *
 * The editor deliberately does NOT block an over-ambitious schedule. Wanting 500 words in a fortnight
 * is a legitimate thing to type; the honest response is to show that it doesn't fit and name the three
 * levers (ceiling, target, deadline), not to refuse the input. Only incoherent schedules — a deadline
 * before the start, a checkpoint above the final target — are hard errors.
 *
 * Dates are edited on the CALENDAR (`GoalScheduleCalendar`), not in rows of date inputs: time off and
 * checkpoints are statements about particular days, and a grid is how you pick days. The draft
 * therefore keys `dateExceptions`/`checkpoints` BY DATE — one entry per day by construction, so the
 * calendar can set and clear them without hunting through an array.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  SupabaseGoalScheduleRepository, scheduleProgress, currentVocabularySize,
} from '@/lib/data/goalSchedules'
import {
  scheduleStatus, schedulePlan, validateSchedule, daysBetween, addScheduleDays,
} from '@/lib/goalSchedule'
import { GoalScheduleCalendar } from '@/components/settings/GoalScheduleCalendar'
import { getToday } from '@/lib/dates'
import type { GoalSchedule, GoalScheduleCheckpoint, GoalTargetKind } from '@/domain'

const WEEKDAYS: { day: number; label: string }[] = [
  { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' }, { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' }, { day: 0, label: 'Sun' },
]

const shortDate = (d: string) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

type Draft = {
  name:           string
  targetKind:     GoalTargetKind
  targetCount:    string
  startDate:      string
  deadline:       string
  dailyCeiling:   string
  weekdayLimits:  Record<string, string>
  /** date → words allowed that day; 0 = time off. Keyed so the calendar can set/clear directly. */
  dateExceptions: Record<string, number>
  /** date → cumulative target by then. Keyed, so two checkpoints can't share a date. */
  checkpoints:    Record<string, number>
}

function draftFrom(schedule: GoalSchedule | null, today: string): Draft {
  if (!schedule) {
    return {
      name: '', targetKind: 'new_words', targetCount: '',
      startDate: today, deadline: addScheduleDays(today, 30),
      dailyCeiling: '', weekdayLimits: {}, dateExceptions: {}, checkpoints: {},
    }
  }
  const limits: Record<string, string> = {}
  for (const [k, v] of Object.entries(schedule.weekdayLimits ?? {})) limits[k] = v == null ? '' : String(v)
  return {
    name:          schedule.name ?? '',
    targetKind:    schedule.targetKind,
    targetCount:   String(schedule.targetCount),
    startDate:     schedule.startDate,
    deadline:      schedule.deadline,
    dailyCeiling:  schedule.dailyCeiling == null ? '' : String(schedule.dailyCeiling),
    weekdayLimits: limits,
    dateExceptions: { ...(schedule.dateExceptions ?? {}) },
    checkpoints:    Object.fromEntries((schedule.checkpoints ?? []).map(c => [c.date, c.count])),
  }
}

export function GoalScheduleEditor({ userId, sourceLanguage, targetLanguage, label, timezone, turnoverHour, onChanged }: {
  userId:         string
  sourceLanguage: string
  targetLanguage: string
  /** Human label for the pair, e.g. "Spanish → English". */
  label:          string
  timezone:       string
  turnoverHour:   number
  /** Fired after a save or retire with whether this pair now has a live schedule. */
  onChanged?:     (hasSchedule: boolean) => void
}) {
  const today = useMemo(() => getToday(timezone, turnoverHour), [timezone, turnoverHour])

  const [saved,     setSaved]     = useState<GoalSchedule | null>(null)
  const [draft,     setDraft]     = useState<Draft>(() => draftFrom(null, today))
  const [vocabNow,  setVocabNow]  = useState(0)
  const [doneSoFar, setDoneSoFar] = useState(0)
  const [loading,   setLoading]   = useState(true)
  const [busy,      setBusy]      = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [note,      setNote]      = useState<string | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)

  // ── Load ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [existing, vocab] = await Promise.all([
          new SupabaseGoalScheduleRepository().getForPair(userId, sourceLanguage, targetLanguage),
          // Only the 'total_words' baseline needs this; a failure must not take the editor down with
          // it, so it degrades to 0 rather than rejecting the pair.
          currentVocabularySize(userId, sourceLanguage, targetLanguage).catch(() => 0),
        ])
        if (cancelled) return
        setSaved(existing)
        setDraft(draftFrom(existing, today))
        setVocabNow(vocab)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the schedule.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [userId, sourceLanguage, targetLanguage, today])

  /**
   * The baseline the schedule measures from. A 'total_words' target counts the vocabulary you already
   * have, so it needs the size at CREATION time — an existing schedule keeps its stored snapshot
   * (re-reading it now would silently move the finish line), and switching kind takes a fresh one.
   */
  const baselineCount = draft.targetKind === 'total_words'
    ? (saved && saved.targetKind === 'total_words' ? saved.baselineCount : vocabNow)
    : 0

  // ── Progress, re-read when the measure or its start moves ──
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const done = await scheduleProgress({
          userId,
          schedule: { sourceLanguage, targetLanguage, targetKind: draft.targetKind, startDate: draft.startDate },
          timezone, turnoverHour,
        })
        if (!cancelled) setDoneSoFar(done)
      } catch { /* the preview degrades to "nothing done yet"; never block editing on it */ }
    }, 350)   // debounced: the date input fires on every keystroke
    return () => { cancelled = true; clearTimeout(timer) }
  }, [userId, sourceLanguage, targetLanguage, timezone, turnoverHour, draft.targetKind, draft.startDate])

  // ── The live schedule object the engine reasons about ──
  const candidate = useMemo<GoalSchedule>(() => {
    const limits: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(draft.weekdayLimits)) {
      if (v.trim() !== '') limits[k] = Math.max(0, parseInt(v, 10) || 0)
    }
    const checkpoints: GoalScheduleCheckpoint[] = Object.entries(draft.checkpoints)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))

    return {
      id: saved?.id ?? 'draft', userId, sourceLanguage, targetLanguage,
      name: draft.name.trim() || null,
      targetKind:  draft.targetKind,
      targetCount: parseInt(draft.targetCount, 10) || 0,
      startDate:   draft.startDate,
      deadline:    draft.deadline,
      baselineCount,
      dailyCeiling: draft.dailyCeiling.trim() === '' ? null : Math.max(0, parseInt(draft.dailyCeiling, 10) || 0),
      weekdayLimits:  Object.keys(limits).length ? limits : null,
      dateExceptions: Object.keys(draft.dateExceptions).length ? draft.dateExceptions : null,
      checkpoints,
      archivedAt: null,
      createdAt: saved?.createdAt ?? '', updatedAt: saved?.updatedAt ?? '',
    }
  }, [draft, saved, userId, sourceLanguage, targetLanguage, baselineCount])

  const errors = useMemo(() => (candidate.targetCount > 0 ? validateSchedule(candidate) : []), [candidate])
  const ready = candidate.targetCount > 0 && errors.length === 0
  const status = useMemo(
    () => (ready ? scheduleStatus({ schedule: candidate, today, doneSoFar }) : null),
    [ready, candidate, today, doneSoFar],
  )
  const plan = useMemo(() => (ready ? schedulePlan(candidate, today, doneSoFar) : []), [ready, candidate, today, doneSoFar])

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }))
    setNote(null)
  }, [])

  // ── Calendar callbacks ──
  const setDateCaps = useCallback((dates: string[], cap: number | null) => {
    setDraft(prev => {
      const next = { ...prev.dateExceptions }
      for (const d of dates) {
        if (cap == null) delete next[d]          // back to the weekday limit / ceiling
        else next[d] = Math.max(0, cap)
      }
      return { ...prev, dateExceptions: next }
    })
    setNote(null)
  }, [])

  const setCheckpoint = useCallback((date: string, count: number) => {
    setDraft(prev => ({ ...prev, checkpoints: { ...prev.checkpoints, [date]: count } }))
    setNote(null)
  }, [])

  const removeCheckpoint = useCallback((date: string) => {
    setDraft(prev => {
      const next = { ...prev.checkpoints }
      delete next[date]
      return { ...prev, checkpoints: next }
    })
    setNote(null)
  }, [])

  // ── Actions ──
  async function save() {
    if (!ready || busy) return
    setBusy(true); setError(null); setNote(null)
    try {
      const next = await new SupabaseGoalScheduleRepository().save(userId, {
        sourceLanguage, targetLanguage,
        name: candidate.name, targetKind: candidate.targetKind, targetCount: candidate.targetCount,
        startDate: candidate.startDate, deadline: candidate.deadline, baselineCount: candidate.baselineCount,
        dailyCeiling: candidate.dailyCeiling, weekdayLimits: candidate.weekdayLimits,
        dateExceptions: candidate.dateExceptions, checkpoints: candidate.checkpoints,
      })
      setSaved(next)
      setNote('Schedule saved.')
      onChanged?.(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the schedule.')
    } finally { setBusy(false) }
  }

  async function archive() {
    if (!saved || busy) return
    setBusy(true); setError(null)
    try {
      await new SupabaseGoalScheduleRepository().archive(saved.id)
      setSaved(null)
      setDraft(draftFrom(null, today))
      setNote('Schedule retired — this language is back on its weekday goals.')
      onChanged?.(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not retire the schedule.')
    } finally { setBusy(false); setConfirmArchive(false) }
  }

  function applyRemedy(change: Partial<Draft>) { setDraft(prev => ({ ...prev, ...change })); setNote(null) }

  if (loading) return <p className="text-xs text-ink-faint">Loading schedule…</p>

  const span = daysBetween(draft.startDate, draft.deadline)
  const checkpointList = Object.entries(draft.checkpoints).sort(([a], [b]) => a.localeCompare(b))
  const timeOffCount = Object.values(draft.dateExceptions).filter(v => v === 0).length

  return (
    <div className="space-y-5">
      {/* ── Target ── */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-ink-faint block">I want to reach</label>
          <div className="flex items-center gap-2">
            <input
              type="number" min={1} max={100000}
              className="input text-center text-sm px-2 py-1.5 w-24"
              placeholder="200"
              value={draft.targetCount}
              onChange={e => set('targetCount', e.target.value)}
            />
            <select
              className="input text-sm px-2 py-1.5"
              value={draft.targetKind}
              onChange={e => set('targetKind', e.target.value as GoalTargetKind)}
            >
              <option value="new_words">new words</option>
              <option value="total_words">words total</option>
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-faint block">Starting</label>
          <input type="date" className="input text-sm px-2 py-1.5" value={draft.startDate}
                 onChange={e => set('startDate', e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-faint block">By</label>
          <input type="date" className="input text-sm px-2 py-1.5" value={draft.deadline}
                 onChange={e => set('deadline', e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-ink-faint block">Never more than</label>
          <div className="flex items-center gap-2">
            <input
              type="number" min={1} max={999}
              className="input text-center text-sm px-2 py-1.5 w-20"
              placeholder="—"
              value={draft.dailyCeiling}
              onChange={e => set('dailyCeiling', e.target.value)}
            />
            <span className="text-xs text-ink-faint">a day</span>
          </div>
        </div>
        <div className="space-y-1 flex-1 min-w-[10rem]">
          <label className="text-xs text-ink-faint block">Name (optional)</label>
          <input type="text" className="input text-sm px-2 py-1.5 w-full" placeholder="Exam prep"
                 value={draft.name} onChange={e => set('name', e.target.value)} />
        </div>
      </div>

      <p className="text-xs text-ink-faint">
        {draft.targetKind === 'total_words'
          ? `Counts your whole ${(label.split('→')[0] ?? label).trim()} vocabulary, including words you onboarded as already known. You have ${baselineCount} now.`
          : 'Counts only words you learn through the ladder during the schedule. Onboarded "already known" words don’t count.'}
        {span > 0 && ` ${span} day${span === 1 ? '' : 's'} from start to deadline.`}
      </p>

      {/* ── The usual week ── the calendar below handles one-off days; this is for "every weekend". */}
      <div className="space-y-2 pt-3 border-t border-line/10">
        <p className="text-xs text-ink-faint">
          Your usual week — blank follows the ceiling, <span className="text-ink">0 is a day off every week</span>.
          Use the calendar for one-off days.
        </p>
        <div className="grid grid-cols-7 gap-2 max-w-md">
          {WEEKDAYS.map(({ day, label: wd }) => (
            <div key={day} className="flex flex-col items-center gap-1">
              <span className="text-xs text-ink-faint select-none">{wd}</span>
              <input
                type="number" min={0} max={999}
                className="input text-center text-sm px-1 py-1.5 w-full"
                placeholder="—"
                value={draft.weekdayLimits[String(day)] ?? ''}
                onChange={e => set('weekdayLimits', { ...draft.weekdayLimits, [String(day)]: e.target.value })}
              />
            </div>
          ))}
        </div>
      </div>

      {/* ── Errors ── */}
      {errors.length > 0 && (
        <ul className="text-xs text-danger space-y-0.5">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      {/* ── Live preview ── */}
      {status && (
        <div className="space-y-4 pt-3 border-t border-line/10">
          <div className="flex flex-wrap gap-6">
            <Stat label="Today" value={status.done ? 'Done' : status.expired ? '—' : `${status.goal}`}
                  hint={status.done ? 'target reached' : status.expired ? 'deadline passed' : 'words'} />
            <Stat label="Still to go" value={`${status.remaining}`} hint={`over ${status.daysLeft} study day${status.daysLeft === 1 ? '' : 's'}`} />
            <Stat
              label="Pace"
              value={status.pace === 0 ? 'Level' : status.pace > 0 ? `+${status.pace}` : `${status.pace}`}
              hint={status.pace === 0 ? 'on track' : status.pace > 0 ? 'words ahead' : 'words behind'}
              tone={status.pace < 0 ? 'danger' : status.pace > 0 ? 'success' : 'muted'}
            />
            {status.binding && !status.binding.isDeadline && (
              <Stat label="Next checkpoint" value={`${status.binding.target}`} hint={`by ${shortDate(status.binding.date)}`} />
            )}
            {timeOffCount > 0 && (
              <Stat label="Time off" value={`${timeOffCount}`} hint={`day${timeOffCount === 1 ? '' : 's'} blocked out`} />
            )}
          </div>

          {/* Feasibility — the whole point of the ceiling. */}
          {!status.feasible && status.remedies && (
            <div className="text-xs space-y-1.5 rounded-md border border-danger/40 bg-danger/5 p-2.5">
              <p className="text-danger">
                {`This doesn’t fit: ${status.shortfall} word${status.shortfall === 1 ? '' : 's'} more than the days left can hold. Pick one:`}
              </p>
              <div className="flex flex-wrap gap-2">
                {status.remedies.minimumCeiling != null && (
                  <button className="btn-ghost text-xs py-1"
                          onClick={() => applyRemedy({ dailyCeiling: String(status.remedies!.minimumCeiling) })}>
                    {`Raise the ceiling to ${status.remedies.minimumCeiling}/day`}
                  </button>
                )}
                <button className="btn-ghost text-xs py-1"
                        onClick={() => applyRemedy({ targetCount: String(status.remedies!.reducedTarget) })}>
                  {`Reduce the target to ${status.remedies.reducedTarget}`}
                </button>
                {status.remedies.feasibleDeadline && (
                  <button className="btn-ghost text-xs py-1"
                          onClick={() => applyRemedy({ deadline: status.remedies!.feasibleDeadline! })}>
                    {`Move the deadline to ${shortDate(status.remedies.feasibleDeadline)}`}
                  </button>
                )}
              </div>
              {status.remedies.minimumCeiling == null && (
                <p className="text-ink-faint">
                  Raising the ceiling wouldn&apos;t help — your per-day limits and days off are what&apos;s binding.
                </p>
              )}
            </div>
          )}

          <GoalScheduleCalendar
            schedule={candidate}
            plan={plan}
            today={today}
            onSetDateCaps={setDateCaps}
            onSetCheckpoint={setCheckpoint}
            onRemoveCheckpoint={removeCheckpoint}
          />

          {checkpointList.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-ink-faint">
                Checkpoints — cumulative targets. The nearest sets today&apos;s number whenever it&apos;s the tighter constraint.
              </p>
              <div className="flex flex-wrap gap-2">
                {checkpointList.map(([date, count]) => (
                  <span key={date} className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border border-line/10 text-ink">
                    {`${count} by ${shortDate(date)}`}
                    <button className="text-ink-faint hover:text-danger" onClick={() => removeCheckpoint(date)}
                            aria-label={`Remove checkpoint on ${date}`}>×</button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Save ── */}
      <div className="flex items-center gap-2 pt-3 border-t border-line/10">
        <button className="btn-primary text-sm py-1.5 px-4 disabled:opacity-50" disabled={!ready || busy} onClick={save}>
          {saved ? 'Update schedule' : 'Start schedule'}
        </button>
        {saved && !confirmArchive && (
          <button className="btn-ghost text-sm py-1.5 px-3" onClick={() => setConfirmArchive(true)}>Retire</button>
        )}
        {saved && confirmArchive && (
          <>
            <span className="text-xs text-ink-faint">Back to weekday goals?</span>
            <button className="btn-ghost text-xs py-1" onClick={archive}>Yes, retire</button>
            <button className="btn-ghost text-xs py-1" onClick={() => setConfirmArchive(false)}>Cancel</button>
          </>
        )}
        {note && <span className="text-xs text-success">{note}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  )
}

function Stat({ label, value, hint, tone = 'muted' }: {
  label: string; value: string; hint: string; tone?: 'muted' | 'success' | 'danger'
}) {
  const color = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-ink'
  return (
    <div>
      <div className="text-xs text-ink-faint uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-medium ${color}`}>{value}</div>
      <div className="text-xs text-ink-faint">{hint}</div>
    </div>
  )
}
