'use client'

/**
 * components/settings/GoalScheduleCalendar.tsx — the calendar half of the schedule editor.
 *
 * A schedule is a statement about DATES, so the editor for it is a calendar rather than a list of
 * date rows. Every day shows the words it's planned to carry, and the two things you actually want
 * to say about a date — "I'm away" and "I want to be at N by here" — are direct manipulations:
 *
 *   • **Drag across days** to select a range, then mark it time off or cap it at a number.
 *   • **Click one day** to do the same to a single date, or to hang a checkpoint on it.
 *
 * The calendar EDITS `dateExceptions` and `checkpoints`; it does not own them. It renders whatever
 * the parent's draft says and calls back, so the live preview and feasibility check stay the single
 * source of truth (see `lib/goalSchedule.ts`).
 *
 * Past days inside the schedule are shown from `plannedForDate` — the target they were ASSIGNED —
 * rather than the re-spread number, because a past day's goal is a historical record. Future days
 * come from the live plan.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { assignedPlan, weekdayOfDate, addScheduleDays, eachDate, dayCapacity } from '@/lib/goalSchedule'
import type { SchedulePlanDay } from '@/lib/goalSchedule'
import type { GoalSchedule } from '@/domain'

/** Monday-first, matching the weekday-limit row in the editor. */
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/** JS getDay() (0 = Sun) → Monday-first column index. */
const col = (jsDay: number) => (jsDay + 6) % 7

const monthLabel = (ym: string) =>
  new Date(ym + '-01T12:00:00Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** Every YYYY-MM in [from, to], capped so a mistyped year can't render 12,000 grids. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let cursor = from.slice(0, 7)
  for (let i = 0; i < 60 && cursor <= to.slice(0, 7); i++) {
    out.push(cursor)
    const [y, m] = cursor.split('-').map(Number)
    cursor = m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, '0')}`
  }
  return out
}

/** The dates of one month grid, padded to whole Monday-start weeks. */
export function monthGrid(ym: string): (string | null)[] {
  const first = `${ym}-01`
  const daysInMonth = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()
  const lead = col(weekdayOfDate(first))
  const cells: (string | null)[] = Array(lead).fill(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${ym}-${String(d).padStart(2, '0')}`)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export function GoalScheduleCalendar({ schedule, plan, today, onSetDateCaps, onSetCheckpoint, onRemoveCheckpoint }: {
  schedule: GoalSchedule
  /** The forward plan from `schedulePlan` — used for today and later. */
  plan: SchedulePlanDay[]
  today: string
  /** `cap: null` clears the override and returns the date to its weekday limit / ceiling. */
  onSetDateCaps: (dates: string[], cap: number | null) => void
  onSetCheckpoint: (date: string, count: number) => void
  onRemoveCheckpoint: (date: string) => void
}) {
  const [anchor, setAnchor] = useState<string | null>(null)   // drag origin
  const [hover, setHover] = useState<string | null>(null)     // drag head
  const [selection, setSelection] = useState<string[]>([])
  const [limitDraft, setLimitDraft] = useState('')
  const [checkpointDraft, setCheckpointDraft] = useState('')
  const dragging = useRef(false)
  // The window-level release handler reads the drag through refs: it is registered once, so it would
  // otherwise close over the anchor/hover from first render and always commit an empty range.
  const anchorRef = useRef<string | null>(null)
  const hoverRef = useRef<string | null>(null)
  const boundsRef = useRef({ start: schedule.startDate, end: schedule.deadline })
  boundsRef.current = { start: schedule.startDate, end: schedule.deadline }

  /**
   * A drag can end anywhere — on a different cell, off the grid, outside the window — so the release
   * is handled globally and COMMITS there. Committing on the cell's own pointerup would silently drop
   * any selection that ended outside the calendar.
   */
  useEffect(() => {
    const finish = (commit: boolean) => () => {
      if (!dragging.current) return
      dragging.current = false
      const a = anchorRef.current
      const b = hoverRef.current
      if (commit && a && b) {
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        const { start, end } = boundsRef.current
        setSelection(eachDate(lo, hi).filter(d => d >= start && d <= end))
        setLimitDraft('')
        setCheckpointDraft('')
      }
      anchorRef.current = null
      hoverRef.current = null
      setAnchor(null)
      setHover(null)
    }
    const onUp = finish(true)
    const onCancel = finish(false)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [])

  const months = useMemo(() => monthsBetween(schedule.startDate, schedule.deadline), [schedule.startDate, schedule.deadline])
  const planByDate = useMemo(() => new Map(plan.map(d => [d.date, d.words])), [plan])
  // Past days show the target they were ASSIGNED. Computed ONCE for the whole span — calling
  // `plannedForDate` per cell re-runs the water-fill per date, which is O(n²) across the grid and
  // freezes a long schedule on every keystroke.
  const assignedByDate = useMemo(() => assignedPlan(schedule), [schedule])
  const checkpointByDate = useMemo(
    () => new Map((schedule.checkpoints ?? []).map(c => [c.date, c.count])),
    [schedule.checkpoints],
  )

  /** The range currently under the pointer, or the committed selection when not dragging. */
  const active = useMemo(() => {
    if (anchor && hover) {
      const [a, b] = anchor <= hover ? [anchor, hover] : [hover, anchor]
      return new Set(eachDate(a, b))
    }
    return new Set(selection)
  }, [anchor, hover, selection])

  const inSchedule = (d: string) => d >= schedule.startDate && d <= schedule.deadline

  function beginDrag(date: string) {
    if (!inSchedule(date)) return
    dragging.current = true
    anchorRef.current = date
    hoverRef.current = date
    setAnchor(date)
    setHover(date)
    setSelection([])
  }

  function extendDrag(date: string) {
    if (!dragging.current || !inSchedule(date)) return
    hoverRef.current = date
    setHover(date)
  }

  function clearSelection() {
    setSelection([])
    setLimitDraft('')
    setCheckpointDraft('')
  }

  const single = selection.length === 1 ? selection[0]! : null
  const existingCheckpoint = single ? checkpointByDate.get(single) : undefined

  return (
    <div className="space-y-3 select-none">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-ink-faint">
          Drag across days to select a stretch, or click one. Numbers are the words planned for that day.
        </p>
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-accent/45" />planned</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-line/25" />time off</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm ring-1 ring-warning" />limited</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-accent" />checkpoint</span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {months.map(ym => (
          <div key={ym} className="space-y-1">
            <div className="text-xs font-medium text-ink-muted">{monthLabel(ym)}</div>
            <div className="grid grid-cols-7 gap-px text-center">
              {DOW.map(d => <div key={d} className="text-[10px] text-ink-faint pb-0.5">{d.slice(0, 1)}</div>)}
              {monthGrid(ym).map((date, i) => {
                if (!date) return <div key={`pad-${i}`} />
                const within = inSchedule(date)
                const cap = dayCapacity(schedule, date)
                const hasOverride = schedule.dateExceptions?.[date] != null
                const words = date >= today ? (planByDate.get(date) ?? 0) : (assignedByDate.get(date) ?? 0)
                const isCheckpoint = checkpointByDate.has(date)
                const isDeadline = date === schedule.deadline
                const isToday = date === today
                const selected = active.has(date)

                return (
                  <button
                    key={date}
                    type="button"
                    disabled={!within}
                    onPointerDown={e => {
                      e.preventDefault()
                      // Touch and pen pointers are IMPLICITLY captured by the element that received
                      // pointerdown, so pointerenter would never fire on any other cell and a drag
                      // on a phone would only ever select the day it started on. Releasing the
                      // capture is what makes drag-select work off the desktop.
                      if (e.pointerType !== 'mouse') e.currentTarget.releasePointerCapture(e.pointerId)
                      beginDrag(date)
                    }}
                    onPointerEnter={() => extendDrag(date)}
                    style={{ touchAction: 'none' }}
                    title={within
                      ? `${date}${cap === 0 ? ' — time off' : ` — ${words} word${words === 1 ? '' : 's'}`}${isCheckpoint ? ` · checkpoint ${checkpointByDate.get(date)}` : ''}`
                      : `${date} — outside the schedule`}
                    className={[
                      'relative aspect-square rounded-sm text-[10px] leading-none flex flex-col items-center justify-center transition-colors',
                      !within ? 'text-ink-faint/40 cursor-default'
                        : cap === 0 ? 'bg-line/25 text-ink-faint'
                        : 'bg-accent/25 text-ink hover:bg-accent/40',
                      selected && within ? 'ring-2 ring-accent' : hasOverride && within && cap > 0 ? 'ring-1 ring-warning' : '',
                      isDeadline ? 'outline outline-1 outline-accent' : '',
                      isToday ? 'font-semibold underline underline-offset-2' : '',
                    ].join(' ')}
                  >
                    <span>{Number(date.slice(8))}</span>
                    {within && cap !== 0 && words > 0 && <span className="text-[9px] text-ink-muted">{words}</span>}
                    {isCheckpoint && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── What to do with the selection ── */}
      {selection.length > 0 && (
        <div className="rounded-md border border-line/10 bg-surface/40 p-3 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink">
              {single
                ? new Date(single + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
                : `${selection.length} days · ${selection[0]!.slice(5)} → ${selection[selection.length - 1]!.slice(5)}`}
            </span>
            <button className="btn-ghost text-xs py-1" onClick={() => { onSetDateCaps(selection, 0); clearSelection() }}>
              Mark time off
            </button>
            <div className="flex items-center gap-1">
              <input
                type="number" min={1} max={999}
                className="input text-center text-xs px-1.5 py-1 w-16"
                placeholder="max"
                value={limitDraft}
                onChange={e => setLimitDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return
                  const n = parseInt(limitDraft, 10)
                  if (n > 0) { onSetDateCaps(selection, n); clearSelection() }
                }}
              />
              <button
                className="btn-ghost text-xs py-1 disabled:opacity-40"
                disabled={!(parseInt(limitDraft, 10) > 0)}
                onClick={() => { onSetDateCaps(selection, parseInt(limitDraft, 10)); clearSelection() }}
              >
                Cap these days
              </button>
            </div>
            <button className="btn-ghost text-xs py-1" onClick={() => { onSetDateCaps(selection, null); clearSelection() }}>
              Clear overrides
            </button>
            <button className="btn-ghost text-xs py-1 ml-auto" onClick={clearSelection}>Done</button>
          </div>

          {/* A checkpoint is a target ON one date, so it's only offered for a single day. */}
          {single && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line/10">
              <span className="text-xs text-ink-faint">
                {existingCheckpoint != null ? `Checkpoint: ${existingCheckpoint} words by this date.` : 'Set a target to reach by this date:'}
              </span>
              <input
                type="number" min={1} max={100000}
                className="input text-center text-xs px-1.5 py-1 w-20"
                placeholder={existingCheckpoint != null ? String(existingCheckpoint) : 'words'}
                value={checkpointDraft}
                onChange={e => setCheckpointDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return
                  const n = parseInt(checkpointDraft, 10)
                  if (n > 0) { onSetCheckpoint(single, n); clearSelection() }
                }}
              />
              <button
                className="btn-ghost text-xs py-1 disabled:opacity-40"
                disabled={!(parseInt(checkpointDraft, 10) > 0)}
                onClick={() => { onSetCheckpoint(single, parseInt(checkpointDraft, 10)); clearSelection() }}
              >
                {existingCheckpoint != null ? 'Update checkpoint' : 'Add checkpoint'}
              </button>
              {existingCheckpoint != null && (
                <button className="btn-ghost text-xs py-1" onClick={() => { onRemoveCheckpoint(single); clearSelection() }}>
                  Remove checkpoint
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {selection.length === 0 && months.length > 0 && (
        <p className="text-xs text-ink-faint">
          {`Schedule runs ${schedule.startDate} → ${schedule.deadline}. Days outside it are dimmed; the deadline is outlined.`}
          {schedule.deadline < addScheduleDays(today, 0) ? ' This deadline is in the past.' : ''}
        </p>
      )}
    </div>
  )
}
