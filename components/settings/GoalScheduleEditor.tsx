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
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  SupabaseGoalScheduleRepository, scheduleProgress, currentVocabularySize,
} from '@/lib/data/goalSchedules'
import {
  scheduleStatus, schedulePlan, validateSchedule, daysBetween, addScheduleDays,
} from '@/lib/goalSchedule'
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
  dateExceptions: { date: string; cap: string }[]
  checkpoints:    { date: string; count: string }[]
}

function draftFrom(schedule: GoalSchedule | null, today: string): Draft {
  if (!schedule) {
    return {
      name: '', targetKind: 'new_words', targetCount: '',
      startDate: today, deadline: addScheduleDays(today, 30),
      dailyCeiling: '', weekdayLimits: {}, dateExceptions: [], checkpoints: [],
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
    dateExceptions: Object.entries(schedule.dateExceptions ?? {}).map(([date, cap]) => ({ date, cap: String(cap) })),
    checkpoints:    (schedule.checkpoints ?? []).map(c => ({ date: c.date, count: String(c.count) })),
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

  const [saved,   setSaved]   = useState<GoalSchedule | null>(null)
  const [draft,   setDraft]   = useState<Draft>(() => draftFrom(null, today))
  const [vocabNow, setVocabNow] = useState(0)
  const [doneSoFar, setDoneSoFar] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [note,    setNote]    = useState<string | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)

  // ── Load ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [existing, vocab] = await Promise.all([
          new SupabaseGoalScheduleRepository().getForPair(userId, sourceLanguage, targetLanguage),
          currentVocabularySize(userId, sourceLanguage, targetLanguage),
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
  const progressKey = `${draft.targetKind}:${draft.startDate}`
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
  }, [progressKey, userId, sourceLanguage, targetLanguage, timezone, turnoverHour, draft.targetKind, draft.startDate])

  // ── The live schedule object the engine reasons about ──
  const candidate = useMemo<GoalSchedule>(() => {
    const limits: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(draft.weekdayLimits)) {
      if (v.trim() !== '') limits[k] = Math.max(0, parseInt(v, 10) || 0)
    }
    const exceptions: Record<string, number> = {}
    for (const { date, cap } of draft.dateExceptions) {
      if (date) exceptions[date] = cap.trim() === '' ? 0 : Math.max(0, parseInt(cap, 10) || 0)
    }
    const checkpoints: GoalScheduleCheckpoint[] = draft.checkpoints
      .filter(c => c.date && c.count.trim() !== '')
      .map(c => ({ date: c.date, count: parseInt(c.count, 10) || 0 }))

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
      dateExceptions: Object.keys(exceptions).length ? exceptions : null,
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

  return (
    <div className="space-y-4">
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

      {/* ── Limits ── */}
      <div className="space-y-2 pt-2 border-t border-line/10">
        <div className="flex items-center gap-2">
          <label className="text-xs text-ink-faint">Never more than</label>
          <input
            type="number" min={1} max={999}
            className="input text-center text-sm px-2 py-1.5 w-20"
            placeholder="—"
            value={draft.dailyCeiling}
            onChange={e => set('dailyCeiling', e.target.value)}
          />
          <span className="text-xs text-ink-faint">words a day. Blank = no ceiling.</span>
        </div>

        <div>
          <p className="text-xs text-ink-faint mb-1.5">Per-day limits — blank follows the ceiling, <span className="text-ink">0 is a day off</span>.</p>
          <div className="grid grid-cols-7 gap-1.5">
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
      </div>

      {/* ── Specific dates ── */}
      <div className="space-y-2 pt-2 border-t border-line/10">
        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-faint">Specific dates — holidays, or a free day you want to do extra. Overrides the ceiling.</p>
          <button className="btn-ghost text-xs py-1"
                  onClick={() => set('dateExceptions', [...draft.dateExceptions, { date: today, cap: '0' }])}>
            + Date
          </button>
        </div>
        {draft.dateExceptions.map((ex, i) => (
          <div key={i} className="flex items-center gap-2">
            <input type="date" className="input text-sm px-2 py-1.5" value={ex.date}
                   onChange={e => set('dateExceptions', draft.dateExceptions.map((x, j) => j === i ? { ...x, date: e.target.value } : x))} />
            <input type="number" min={0} max={999} className="input text-center text-sm px-2 py-1.5 w-20" placeholder="0"
                   value={ex.cap}
                   onChange={e => set('dateExceptions', draft.dateExceptions.map((x, j) => j === i ? { ...x, cap: e.target.value } : x))} />
            <span className="text-xs text-ink-faint flex-1">
              {ex.cap.trim() === '' || parseInt(ex.cap, 10) === 0 ? 'day off' : `max ${parseInt(ex.cap, 10)} words`}
            </span>
            <button className="btn-ghost text-xs py-1"
                    onClick={() => set('dateExceptions', draft.dateExceptions.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
      </div>

      {/* ── Checkpoints ── */}
      <div className="space-y-2 pt-2 border-t border-line/10">
        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-faint">
            Checkpoints — a running total to have reached by a date. Counts are cumulative, and the
            nearest one sets today&apos;s number when it&apos;s the tighter constraint.
          </p>
          <button className="btn-ghost text-xs py-1"
                  onClick={() => set('checkpoints', [...draft.checkpoints, { date: draft.startDate, count: '' }])}>
            + Checkpoint
          </button>
        </div>
        {draft.checkpoints.map((cp, i) => (
          <div key={i} className="flex items-center gap-2">
            <input type="date" className="input text-sm px-2 py-1.5" value={cp.date}
                   onChange={e => set('checkpoints', draft.checkpoints.map((x, j) => j === i ? { ...x, date: e.target.value } : x))} />
            <input type="number" min={1} max={100000} className="input text-center text-sm px-2 py-1.5 w-24" placeholder="50"
                   value={cp.count}
                   onChange={e => set('checkpoints', draft.checkpoints.map((x, j) => j === i ? { ...x, count: e.target.value } : x))} />
            <span className="text-xs text-ink-faint flex-1">words by then</span>
            <button className="btn-ghost text-xs py-1"
                    onClick={() => set('checkpoints', draft.checkpoints.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
      </div>

      {/* ── Errors ── */}
      {errors.length > 0 && (
        <ul className="text-xs text-danger space-y-0.5">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      {/* ── Live preview ── */}
      {status && (
        <div className="space-y-3 pt-2 border-t border-line/10">
          <div className="flex flex-wrap gap-4">
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

          <PlanStrip plan={plan} schedule={candidate} />
        </div>
      )}

      {/* ── Save ── */}
      <div className="flex items-center gap-2 pt-2 border-t border-line/10">
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

/**
 * The plan as a bar strip. Long schedules bucket by week — 200 one-pixel bars say nothing, and the
 * shape (where the checkpoints bend it, where the days off fall) is the whole point.
 */
function PlanStrip({ plan, schedule }: { plan: { date: string; words: number; capacity: number; milestone: unknown }[]; schedule: GoalSchedule }) {
  if (plan.length === 0) return null

  const weekly = plan.length > 45
  const buckets: { label: string; words: number; milestone: boolean }[] = []
  if (weekly) {
    for (let i = 0; i < plan.length; i += 7) {
      const week = plan.slice(i, i + 7)
      buckets.push({
        label: shortDate(week[0]!.date),
        words: week.reduce((a, d) => a + d.words, 0),
        milestone: week.some(d => d.milestone != null),
      })
    }
  } else {
    for (const d of plan) {
      buckets.push({ label: shortDate(d.date), words: d.words, milestone: d.milestone != null })
    }
  }

  const max = Math.max(1, ...buckets.map(b => b.words))
  return (
    <div>
      <div className="flex items-end gap-px h-16">
        {buckets.map((b, i) => (
          <div key={i} className="flex-1 flex flex-col justify-end h-full group relative"
               title={`${b.label}: ${b.words} word${b.words === 1 ? '' : 's'}`}>
            <div
              className={`w-full rounded-sm ${b.milestone ? 'bg-accent' : b.words === 0 ? 'bg-line/20' : 'bg-accent/45'}`}
              style={{ height: `${Math.max(b.words === 0 ? 3 : 8, (b.words / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-ink-faint mt-1">
        <span>{shortDate(schedule.startDate > plan[0]!.date ? schedule.startDate : plan[0]!.date)}</span>
        <span>{weekly ? 'per week' : 'per day'}</span>
        <span>{shortDate(schedule.deadline)}</span>
      </div>
    </div>
  )
}
