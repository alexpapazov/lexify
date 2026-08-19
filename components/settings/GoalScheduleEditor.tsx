'use client'

/**
 * components/settings/GoalScheduleEditor.tsx — build a "N words by date D" schedule for one pair.
 *
 * Everything below the form is DERIVED, live, from `lib/goalSchedule.ts` — today's number, the plan,
 * whether it's possible. Nothing is precomputed and stored, so what the preview shows is exactly what
 * the goal surfaces will show tomorrow.
 *
 * **Two ways to state a schedule**, and both are complete on their own:
 *   • a TARGET and a deadline — "200 words by Dec 1", spread and re-spread as you go; or
 *   • just NUMBERS — a ceiling, or a per-weekday row. That's a pattern schedule: it runs
 *     open-ended, has no finish line, and simply asks for that many words each day.
 * Either way you get the calendar, days off, per-date caps and a place on the combined view. The
 * calendar appears as soon as the schedule says ANYTHING — requiring a target first meant you
 * couldn't block out travel until you'd committed to a number.
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
  scheduleStatus, schedulePlan, validateSchedule, daysBetween, addScheduleDays, pickCurrentSchedule,
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

/** The three shapes a plan can take — the FIRST choice the editor asks for. */
type PlanKind = 'longterm' | 'daily' | 'weekly'

type Draft = {
  planKind:       PlanKind
  name:           string
  targetKind:     GoalTargetKind
  targetCount:    string
  startDate:      string
  deadline:       string
  dailyCeiling:   string
  weeklyTarget:   string
  debtCarryMissed: boolean
  debtCarryExtra:  boolean
  weekdayLimits:  Record<string, string>
  /** date → words allowed that day; 0 = time off. Keyed so the calendar can set/clear directly. */
  dateExceptions: Record<string, number>
  /** date → cumulative target by then. Keyed, so two checkpoints can't share a date. */
  checkpoints:    Record<string, number>
}

function draftFrom(schedule: GoalSchedule | null, today: string): Draft {
  if (!schedule) {
    return {
      planKind: 'longterm', name: '', targetKind: 'new_words', targetCount: '',
      startDate: today, deadline: '',
      dailyCeiling: '', weeklyTarget: '', debtCarryMissed: false, debtCarryExtra: false,
      weekdayLimits: {}, dateExceptions: {}, checkpoints: {},
    }
  }
  const limits: Record<string, string> = {}
  for (const [k, v] of Object.entries(schedule.weekdayLimits ?? {})) limits[k] = v == null ? '' : String(v)
  return {
    // The kind is derived, not stored: a target makes it long-term, a weekly number weekly, else daily.
    planKind:      schedule.targetCount != null ? 'longterm' : schedule.weeklyTarget != null ? 'weekly' : 'daily',
    name:          schedule.name ?? '',
    targetKind:    schedule.targetKind,
    targetCount:   schedule.targetCount == null ? '' : String(schedule.targetCount),
    startDate:     schedule.startDate,
    deadline:      schedule.deadline ?? '',
    dailyCeiling:  schedule.dailyCeiling == null ? '' : String(schedule.dailyCeiling),
    weeklyTarget:  schedule.weeklyTarget == null ? '' : String(schedule.weeklyTarget),
    debtCarryMissed: schedule.debtCarryMissed,
    debtCarryExtra:  schedule.debtCarryExtra,
    weekdayLimits: limits,
    dateExceptions: { ...(schedule.dateExceptions ?? {}) },
    checkpoints:    Object.fromEntries((schedule.checkpoints ?? []).map(c => [c.date, c.count])),
  }
}

export function GoalScheduleEditor({ userId, sourceLanguage, targetLanguage, label, color, timezone, turnoverHour, onChanged }: {
  userId:         string
  sourceLanguage: string
  targetLanguage: string
  /** Human label for the pair, e.g. "Spanish → English". */
  label:          string
  /** The language's assigned colour, so its calendar matches the combined overview. */
  color?:         string
  timezone:       string
  turnoverHour:   number
  /** Fired after a save or retire with whether this pair now has a live schedule. */
  onChanged?:     (hasSchedule: boolean) => void
}) {
  const today = useMemo(() => getToday(timezone, turnoverHour), [timezone, turnoverHour])

  /** The pair's whole queue of live schedules, earliest start first (sequential goals). */
  const [all,       setAll]       = useState<GoalSchedule[]>([])
  /** Which schedule the form edits; null = composing a brand-new one. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saved,     setSaved]     = useState<GoalSchedule | null>(null)
  const [draft,     setDraft]     = useState<Draft>(() => draftFrom(null, today))
  /** null = the count could not be read. Distinct from 0, which is a real answer. */
  const [vocabNow,  setVocabNow]  = useState<number | null>(null)
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
        const [queue, vocab] = await Promise.all([
          new SupabaseGoalScheduleRepository().listForPair(userId, sourceLanguage, targetLanguage),
          // A failure must not take the editor down with it — but it must NOT become a 0 either.
          // Reporting "you know 0 words" when the query simply failed is worse than saying nothing,
          // and it would have been stored as the schedule's baseline. null means "unknown".
          currentVocabularySize(userId, sourceLanguage, targetLanguage).catch(() => null),
        ])
        if (cancelled) return
        const existing = pickCurrentSchedule(queue, today)
        setAll(queue)
        setEditingId(existing?.id ?? null)
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

  /** Loads one of the queue's schedules (or a blank follow-up draft) into the form. */
  function editSchedule(target: GoalSchedule | null) {
    setSaved(target)
    setEditingId(target?.id ?? null)
    if (target) {
      setDraft(draftFrom(target, today))
    } else {
      // A follow-up starts the day after the queue's last deadline — the natural "and then".
      const lastEnd = all.reduce<string | null>((acc, sc) =>
        sc.deadline && (!acc || sc.deadline > acc) ? sc.deadline : acc, null)
      const start = lastEnd && lastEnd >= today ? addScheduleDays(lastEnd, 1) : today
      setDraft({ ...draftFrom(null, today), startDate: start })
    }
    setNote(null); setError(null); setConfirmArchive(false)
  }

  /**
   * The baseline the schedule measures from. A 'total_words' target counts the vocabulary you already
   * have, so it needs the size at CREATION time — an existing schedule keeps its stored snapshot
   * (re-reading it now would silently move the finish line), and switching kind takes a fresh one.
   */
  const baselineCount = draft.targetKind === 'total_words'
    ? (saved && saved.targetKind === 'total_words' ? saved.baselineCount : (vocabNow ?? 0))
    : 0
  /** A 'total_words' schedule can't be trusted without a baseline — see the load above. */
  const baselineUnknown = draft.targetKind === 'total_words' && vocabNow == null && !(saved && saved.targetKind === 'total_words')

  // ── Progress, re-read when the measure or its start moves ──
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        // After a debt reset, progress counts from the reset date — same date-not-counter trick the
        // engine's progressStart uses, so the preview matches what the study pages will show.
        const resetAt = saved?.debtResetAt
        const countFrom = (draft.debtCarryMissed || draft.debtCarryExtra) && resetAt && resetAt > draft.startDate
          ? resetAt : draft.startDate
        const done = await scheduleProgress({
          userId,
          schedule: { sourceLanguage, targetLanguage, targetKind: draft.targetKind, startDate: countFrom },
          timezone, turnoverHour,
        })
        if (!cancelled) setDoneSoFar(done)
      } catch { /* the preview degrades to "nothing done yet"; never block editing on it */ }
    }, 350)   // debounced: the date input fires on every keystroke
    return () => { cancelled = true; clearTimeout(timer) }
  }, [userId, sourceLanguage, targetLanguage, timezone, turnoverHour, draft.targetKind, draft.startDate,
      draft.debtCarryMissed, draft.debtCarryExtra, saved?.debtResetAt])

  // ── The live schedule object the engine reasons about ──
  const candidate = useMemo<GoalSchedule>(() => {
    const limits: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(draft.weekdayLimits)) {
      if (v.trim() !== '') limits[k] = Math.max(0, parseInt(v, 10) || 0)
    }
    const checkpoints: GoalScheduleCheckpoint[] = Object.entries(draft.checkpoints)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const isPattern = draft.planKind !== 'longterm'
    return {
      id: saved?.id ?? 'draft', userId, sourceLanguage, targetLanguage,
      name: draft.name.trim() || null,
      targetKind:  draft.targetKind,
      // The plan kind decides which fields exist at all — a daily goal saved while an old target
      // lingered in the form must not round-trip back into a long-term goal.
      targetCount: isPattern ? null : draft.targetCount.trim() === '' ? null : (parseInt(draft.targetCount, 10) || null),
      startDate:   draft.startDate,
      deadline:    isPattern ? null : draft.deadline.trim() === '' ? null : draft.deadline,
      baselineCount,
      dailyCeiling: draft.dailyCeiling.trim() === '' ? null : Math.max(0, parseInt(draft.dailyCeiling, 10) || 0),
      weeklyTarget: draft.planKind === 'weekly'
        ? (draft.weeklyTarget.trim() === '' ? null : (parseInt(draft.weeklyTarget, 10) || null))
        : null,
      // Debt is a pattern concept — a long-term goal re-spreads instead (debt on top would double-charge).
      debtCarryMissed: isPattern && draft.debtCarryMissed,
      debtCarryExtra:  isPattern && draft.debtCarryExtra,
      // The reset date is written by the Reset button (persisted immediately), never typed.
      debtResetAt: saved?.debtResetAt ?? null,
      weekdayLimits:  Object.keys(limits).length ? limits : null,
      dateExceptions: Object.keys(draft.dateExceptions).length ? draft.dateExceptions : null,
      checkpoints: isPattern ? [] : checkpoints,
      archivedAt: null,
      createdAt: saved?.createdAt ?? '', updatedAt: saved?.updatedAt ?? '',
    }
  }, [draft, saved, userId, sourceLanguage, targetLanguage, baselineCount])

  /**
   * Has the learner actually said anything yet? An untouched form shouldn't shout "set a target" the
   * moment it renders, but the moment ANY of the three ways to state a schedule has a value, the
   * schedule is real enough to validate and to draw a calendar for.
   */
  const stated = draft.planKind === 'weekly'
    ? draft.weeklyTarget.trim() !== ''
    : (draft.planKind === 'longterm' && draft.targetCount.trim() !== '')
      || draft.dailyCeiling.trim() !== ''
      || Object.values(draft.weekdayLimits).some(v => v.trim() !== '')

  const errors = useMemo(() => (stated ? validateSchedule(candidate) : []), [stated, candidate])
  const ready = stated && errors.length === 0 && !baselineUnknown
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
      const repo = new SupabaseGoalScheduleRepository()
      const next = await repo.save(userId, {
        sourceLanguage, targetLanguage,
        name: candidate.name, targetKind: candidate.targetKind, targetCount: candidate.targetCount,
        startDate: candidate.startDate, deadline: candidate.deadline, baselineCount: candidate.baselineCount,
        dailyCeiling: candidate.dailyCeiling, weekdayLimits: candidate.weekdayLimits,
        dateExceptions: candidate.dateExceptions, weeklyTarget: candidate.weeklyTarget,
        debtCarryMissed: candidate.debtCarryMissed, debtCarryExtra: candidate.debtCarryExtra,
        debtResetAt: candidate.debtResetAt, checkpoints: candidate.checkpoints,
      }, editingId)
      setSaved(next)
      setEditingId(next.id)
      setAll(await repo.listForPair(userId, sourceLanguage, targetLanguage))
      setNote('Schedule saved.')
      onChanged?.(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the schedule.')
    } finally { setBusy(false) }
  }

  /**
   * "Reset it at that instant" — zeroes the debt balance by moving the counting window to today, the
   * same date-not-counter trick the rest of the goal system uses. Persists immediately from the SAVED
   * config, so pressing Reset never silently commits other unsaved edits sitting in the form.
   */
  async function resetDebt() {
    if (!saved || busy) return
    setBusy(true); setError(null); setNote(null)
    try {
      const s = saved
      const next = await new SupabaseGoalScheduleRepository().save(userId, {
        sourceLanguage, targetLanguage,
        name: s.name, targetKind: s.targetKind, targetCount: s.targetCount,
        startDate: s.startDate, deadline: s.deadline, baselineCount: s.baselineCount,
        dailyCeiling: s.dailyCeiling, weekdayLimits: s.weekdayLimits,
        dateExceptions: s.dateExceptions, weeklyTarget: s.weeklyTarget,
        debtCarryMissed: s.debtCarryMissed, debtCarryExtra: s.debtCarryExtra,
        debtResetAt: today, checkpoints: s.checkpoints,
      }, s.id)
      setSaved(next)
      setNote('Debt reset — the balance starts fresh from today.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset the debt.')
    } finally { setBusy(false) }
  }

  async function archive() {
    if (!saved || busy) return
    setBusy(true); setError(null)
    try {
      await new SupabaseGoalScheduleRepository().archive(saved.id)
      const remaining = all.filter(sc => sc.id !== saved.id)
      setAll(remaining)
      const next = pickCurrentSchedule(remaining, today)
      setSaved(next)
      setEditingId(next?.id ?? null)
      setDraft(draftFrom(next, today))
      setNote(remaining.length > 0
        ? 'Schedule retired — the next goal in the queue takes over.'
        : 'Schedule retired — this language is back on its weekday goals.')
      onChanged?.(remaining.length > 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not retire the schedule.')
    } finally { setBusy(false); setConfirmArchive(false) }
  }

  function applyRemedy(change: Partial<Draft>) { setDraft(prev => ({ ...prev, ...change })); setNote(null) }

  if (loading) return <p className="text-xs text-ink-faint">Loading schedule…</p>

  const span = draft.deadline ? daysBetween(draft.startDate, draft.deadline) : 0
  const weekAhead = plan.slice(0, 7).reduce((a, d) => a + d.words, 0)
  const checkpointList = Object.entries(draft.checkpoints).sort(([a], [b]) => a.localeCompare(b))
  const timeOffCount = Object.values(draft.dateExceptions).filter(v => v === 0).length

  const isPattern = draft.planKind !== 'longterm'
  const debtOn = isPattern && (draft.debtCarryMissed || draft.debtCarryExtra)

  const activeId = pickCurrentSchedule(all, today)?.id ?? null
  return (
    <div className="space-y-5">
      {/* ── The queue: this pair's goals in order, plus "and then…". Sequential goals — finish one,
             the next takes over by date, automatically. ── */}
      {(all.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {all.map(sc => {
            const isEditing = sc.id === editingId
            const status = sc.id === activeId ? 'active'
              : sc.deadline && sc.deadline < today ? 'ended'
              : sc.startDate > today ? 'upcoming' : 'queued'
            return (
              <button key={sc.id} type="button" onClick={() => editSchedule(sc)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  isEditing ? 'border-accent text-ink bg-accent/10' : 'border-line/10 text-ink-faint hover:text-ink'
                }`}>
                {sc.name || (sc.targetCount != null ? `${sc.targetCount} words` : sc.weeklyTarget != null ? `${sc.weeklyTarget}/week` : 'daily')}
                {sc.deadline ? ` · by ${shortDate(sc.deadline)}` : ''}
                <span className={`ml-1.5 ${status === 'active' ? 'text-success' : status === 'ended' ? 'text-warning' : 'text-ink-faint/70'}`}>
                  {status === 'active' ? '● now' : status === 'upcoming' ? '↦ next' : status === 'ended' ? 'ended' : 'queued'}
                </span>
              </button>
            )
          })}
          <button type="button" onClick={() => editSchedule(null)}
            className={`text-xs px-3 py-1.5 rounded-full border border-dashed transition-colors ${
              editingId === null ? 'border-accent text-ink bg-accent/10' : 'border-line/20 text-ink-faint hover:text-ink'
            }`}
            title="Queue a goal that starts when the last one ends">
            + and then…
          </button>
        </div>
      )}

      {/* ── What kind of plan? The first choice — it decides which fields below exist. ── */}
      <div className="flex flex-wrap gap-1.5">
        {([
          { kind: 'longterm' as PlanKind, label: 'Long-term goal', hint: 'reach a number by a date' },
          { kind: 'daily'    as PlanKind, label: 'Daily goal',     hint: 'a number every day' },
          { kind: 'weekly'   as PlanKind, label: 'Weekly goal',    hint: 'a number every week' },
        ]).map(({ kind, label: kl, hint }) => (
          <button
            key={kind}
            type="button"
            onClick={() => { set('planKind', kind); setNote(null) }}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              draft.planKind === kind
                ? 'border-accent text-ink bg-accent/10'
                : 'border-line/10 text-ink-faint hover:text-ink'
            }`}
            title={hint}
          >
            {kl}
          </button>
        ))}
      </div>

      {/* ── Target / numbers ── */}
      <div className="flex flex-wrap items-end gap-3">
        {draft.planKind === 'longterm' && (
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
        )}
        {draft.planKind === 'weekly' && (
          <div className="space-y-1">
            <label className="text-xs text-ink-faint block">Each week</label>
            <div className="flex items-center gap-2">
              <input
                type="number" min={1} max={9999}
                className="input text-center text-sm px-2 py-1.5 w-24"
                placeholder="35"
                value={draft.weeklyTarget}
                onChange={e => set('weeklyTarget', e.target.value)}
              />
              <span className="text-xs text-ink-faint">words</span>
            </div>
          </div>
        )}
        <div className="space-y-1">
          <label className="text-xs text-ink-faint block">Starting</label>
          <input type="date" className="input text-sm px-2 py-1.5" value={draft.startDate}
                 onChange={e => set('startDate', e.target.value)} />
        </div>
        {draft.planKind === 'longterm' && (
          <div className="space-y-1">
            <label className="text-xs text-ink-faint block">By</label>
            <input type="date" className="input text-sm px-2 py-1.5" value={draft.deadline}
                   onChange={e => set('deadline', e.target.value)} />
          </div>
        )}
        <div className="space-y-1">
          <label className="text-xs text-ink-faint block">{isPattern ? 'Cap' : 'Never more than'}</label>
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
        {draft.planKind === 'longterm' ? (
          <>
            {draft.targetKind === 'total_words'
              ? `Counts your whole ${(label.split('→')[0] ?? label).trim()} vocabulary, including words you onboarded as already known.${baselineUnknown ? '' : ` You have ${baselineCount} now.`}`
              : 'Counts only words you learn through the ladder during the schedule. Onboarded "already known" words don’t count.'}
            {span > 0 ? ` ${span} day${span === 1 ? '' : 's'} from start to deadline.` : ''}
          </>
        ) : draft.planKind === 'weekly'
          ? 'Your weekly number is spread over the week (Monday to Sunday), respecting days off and per-day limits. Anything above the cap pushes onto the following days.'
          : 'Your daily number comes from the weekday row below (or the cap when a day is blank). Anything above the cap pushes onto the following days.'}
      </p>

      {/* ── The usual week ── the calendar below handles one-off days; this is for "every weekend". */}
      <div className="space-y-2 pt-3 border-t border-line/10">
        <p className="text-xs text-ink-faint">
          {draft.planKind === 'daily'
            ? <>Your daily numbers, weekday by weekday — blank follows the cap, <span className="text-ink">0 is a day off every week</span>.</>
            : <>Your usual week — blank follows the {isPattern ? 'cap' : 'ceiling'}, <span className="text-ink">0 is a day off every week</span>.</>}
          {' '}Use the calendar for one-off days.
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

      {/* ── Debt ── patterns only: a long-term goal re-spreads what's left instead of keeping a tab. */}
      {isPattern && (
        <div className="space-y-2 pt-3 border-t border-line/10">
          <p className="text-xs text-ink-faint">
            Debt — choose whether days carry over into each other. Off means every day starts clean.
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            <label className="flex items-center gap-2 text-xs text-ink cursor-pointer">
              <input type="checkbox" checked={draft.debtCarryMissed}
                     onChange={e => set('debtCarryMissed', e.target.checked)} />
              Missed words carry over (added to later days, up to the cap)
            </label>
            <label className="flex items-center gap-2 text-xs text-ink cursor-pointer">
              <input type="checkbox" checked={draft.debtCarryExtra}
                     onChange={e => set('debtCarryExtra', e.target.checked)} />
              Extra words carry over (worked off later days)
            </label>
          </div>
          {debtOn && (
            <div className="flex flex-wrap items-center gap-3">
              {status && (
                <span className={`text-xs ${status.debtBalance > 0 ? 'text-danger' : status.debtBalance < 0 ? 'text-success' : 'text-ink-faint'}`}>
                  {status.debtBalance === 0 ? 'Balance: level'
                    : status.debtBalance > 0 ? `Balance: ${status.debtBalance} word${status.debtBalance === 1 ? '' : 's'} behind`
                    : `Balance: ${-status.debtBalance} word${status.debtBalance === -1 ? '' : 's'} ahead`}
                </span>
              )}
              {saved && (saved.debtCarryMissed || saved.debtCarryExtra) && (
                <button className="btn-ghost text-xs py-1" disabled={busy} onClick={resetDebt}>
                  Reset balance
                </button>
              )}
              {saved?.debtResetAt && (
                <span className="text-xs text-ink-faint">{`last reset ${shortDate(saved.debtResetAt)}`}</span>
              )}
            </div>
          )}
        </div>
      )}

      {baselineUnknown && (
        <p className="text-xs text-danger">
          Couldn&apos;t read your current vocabulary size, so a total-words target can&apos;t be set
          up correctly. Reload the page; if it persists, use “new words” instead.
        </p>
      )}

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
            {status.isPattern ? (
              <>
                <Stat label="This week" value={`${weekAhead}`} hint="words over the next 7 days" />
                <Stat label="Runs" value="Open-ended" hint="no deadline — add a target to set one" />
              </>
            ) : (
              <>
                <Stat label="Still to go" value={`${status.remaining}`} hint={`over ${status.daysLeft} study day${status.daysLeft === 1 ? '' : 's'}`} />
                <Stat
                  label="Pace"
                  value={status.pace === 0 ? 'Level' : status.pace > 0 ? `+${status.pace}` : `${status.pace}`}
                  hint={status.pace === 0 ? 'on track' : status.pace > 0 ? 'words ahead' : 'words behind'}
                  tone={status.pace < 0 ? 'danger' : status.pace > 0 ? 'success' : 'muted'}
                />
              </>
            )}
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
            color={color}
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
