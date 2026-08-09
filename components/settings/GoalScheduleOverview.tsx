'use client'

/**
 * components/settings/GoalScheduleOverview.tsx — every language's schedule on ONE calendar.
 *
 * The per-language editor answers "what does Spanish want from me". This answers the question you
 * actually plan around: "what does the 14th of next month look like, across everything I'm learning?"
 * Each day is a pie of that day's planned words split by language, in the colours assigned in
 * Settings → Language colors, so a lopsided week is visible at a glance rather than by arithmetic.
 *
 * It reflects SAVED schedules — the per-language editors below own the detail, and an unsaved draft
 * has no business colouring a shared overview. It refreshes when one is saved.
 *
 * What IS editable here is deliberately only what applies to everything at once: drag out a stretch of
 * travel, or mark a weekday you never study. Doing either per-language would mean repeating the same
 * 0 on every schedule by hand, which is the one thing a combined view should spare you.
 *
 * Colours come from `assignLanguageColors(codes, overrides)`, the same helper the review calendar and
 * the library use, so a language is the same colour everywhere in the app.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { monthsBetween, monthGrid } from '@/components/settings/GoalScheduleCalendar'
import { eachDate } from '@/lib/goalSchedule'

const WEEKDAY_LABELS: { day: number; label: string }[] = [
  { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' }, { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' }, { day: 0, label: 'Sun' },
]

export interface OverviewLanguage {
  /** `${sourceLanguage}|${targetLanguage}` */
  key: string
  label: string
  color: string
  /** Planned words per date, from `schedulePlan` + `assignedPlan` for days already gone. */
  plan: Map<string, number>
  /** The schedule's own span, so the overview can mark each language's deadline. */
  startDate: string
  deadline: string
}

const monthLabel = (ym: string) =>
  new Date(ym + '-01T12:00:00Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })

const longDate = (d: string) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

export function GoalScheduleOverview({ languages, today, restDays, onBulkDateCaps, onBulkWeekdayOff }: {
  languages: OverviewLanguage[]
  today: string
  /** Weekdays currently set to 0 on EVERY live schedule — the "rest day everywhere" state. */
  restDays: number[]
  /** Applies a per-date cap (`null` clears it) to every live schedule at once. */
  onBulkDateCaps: (dates: string[], cap: number | null) => void
  /** Turns a weekday off, or back on, across every live schedule. */
  onBulkWeekdayOff: (weekday: number, off: boolean) => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [head, setHead] = useState<string | null>(null)
  const dragging = useRef(false)
  const anchorRef = useRef<string | null>(null)
  const headRef = useRef<string | null>(null)

  // Committed on `window` rather than the cell so a drag released off-grid still applies. Refs
  // because this listener is registered once and would otherwise close over first-render state.
  useEffect(() => {
    const finish = (commit: boolean) => () => {
      if (!dragging.current) return
      dragging.current = false
      const a = anchorRef.current, b = headRef.current
      if (commit && a && b) setSelection(eachDate(a <= b ? a : b, a <= b ? b : a))
      anchorRef.current = null; headRef.current = null
      setAnchor(null); setHead(null)
    }
    const up = finish(true), cancel = finish(false)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel) }
  }, [])

  const dragRange = useMemo(() => {
    if (!anchor || !head) return new Set(selection)
    return new Set(eachDate(anchor <= head ? anchor : head, anchor <= head ? head : anchor))
  }, [anchor, head, selection])

  /** date → per-language words, plus the day's total. Built once from every language's plan. */
  const byDate = useMemo(() => {
    const map = new Map<string, { parts: { lang: OverviewLanguage; words: number }[]; total: number }>()
    for (const lang of languages) {
      for (const [date, words] of lang.plan) {
        if (words <= 0) continue
        let entry = map.get(date)
        if (!entry) { entry = { parts: [], total: 0 }; map.set(date, entry) }
        entry.parts.push({ lang, words })
        entry.total += words
      }
    }
    // Biggest share first, so the pie and the hover panel agree on order.
    for (const entry of map.values()) entry.parts.sort((a, b) => b.words - a.words)
    return map
  }, [languages])

  const span = useMemo(() => {
    if (languages.length === 0) return null
    let start = languages[0]!.startDate
    let end = languages[0]!.deadline
    for (const l of languages) {
      if (l.startDate < start) start = l.startDate
      if (l.deadline > end) end = l.deadline
    }
    return { start, end }
  }, [languages])

  const totals = useMemo(() => {
    const out = new Map<string, number>()
    for (const lang of languages) {
      let sum = 0
      for (const words of lang.plan.values()) sum += words
      out.set(lang.key, sum)
    }
    return out
  }, [languages])

  if (languages.length === 0 || !span) {
    return (
      <p className="text-sm text-ink-faint">
        No live schedules yet. Set one up for a language below and it will appear here.
      </p>
    )
  }

  const months = monthsBetween(span.start, span.end)
  const grandTotal = [...totals.values()].reduce((a, b) => a + b, 0)

  return (
    <div className="space-y-4">
      {/* Legend — doubles as the per-language total across the whole span. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {languages.map(l => (
          <span key={l.key} className="flex items-center gap-1.5 text-xs text-ink-muted">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: l.color }} />
            {l.label}
            <span className="text-ink-faint">{totals.get(l.key) ?? 0} words</span>
          </span>
        ))}
        {languages.length > 1 && (
          <span className="text-xs text-ink-faint">· {grandTotal} planned in total</span>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {months.map(ym => (
          <div key={ym} className="space-y-1">
            <div className="text-xs font-medium text-ink-muted">{monthLabel(ym)}</div>
            <div className="grid grid-cols-7 gap-0.5 text-center">
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                <div key={i} className="text-[10px] text-ink-faint pb-0.5">{d}</div>
              ))}
              {monthGrid(ym).map((date, i) => {
                if (!date) return <div key={`pad-${i}`} />
                const entry = byDate.get(date)
                const isToday = date === today
                const deadlines = languages.filter(l => l.deadline === date)

                // A conic-gradient is the cheapest correct pie: no SVG, no layout, and it stays crisp
                // at the ~30px a calendar cell can spare.
                let background: string | undefined
                if (entry && entry.total > 0) {
                  let acc = 0
                  background = `conic-gradient(${entry.parts.map(p => {
                    const from = (acc / entry.total) * 100
                    acc += p.words
                    return `${p.lang.color} ${from}% ${(acc / entry.total) * 100}%`
                  }).join(', ')})`
                }

                return (
                  <div
                    key={date}
                    className={`relative aspect-square flex flex-col items-center justify-center rounded-sm cursor-pointer ${dragRange.has(date) ? 'ring-2 ring-accent' : ''}`}
                    style={{ touchAction: 'none' }}
                    onMouseEnter={() => setHovered(date)}
                    onMouseLeave={() => setHovered(h => (h === date ? null : h))}
                    onPointerDown={e => {
                      e.preventDefault()
                      // Touch/pen pointers are implicitly captured by the element that got
                      // pointerdown, so pointerenter would never fire on any other cell and a drag
                      // on a phone would select only the day it started on.
                      if (e.pointerType !== 'mouse') e.currentTarget.releasePointerCapture(e.pointerId)
                      dragging.current = true
                      anchorRef.current = date; headRef.current = date
                      setAnchor(date); setHead(date); setSelection([])
                    }}
                    onPointerEnter={() => { if (dragging.current) { headRef.current = date; setHead(date) } }}
                  >
                    <span className={`text-[9px] leading-none ${isToday ? 'text-ink font-semibold' : 'text-ink-faint'}`}>
                      {Number(date.slice(8))}
                    </span>
                    {background ? (
                      <span
                        className={`mt-0.5 rounded-full ${isToday ? 'ring-1 ring-ink' : ''} ${deadlines.length ? 'outline outline-1 outline-offset-1 outline-ink-muted' : ''}`}
                        style={{ background, width: '68%', aspectRatio: '1 / 1' }}
                      />
                    ) : (
                      <span className="mt-0.5 rounded-full bg-line/15" style={{ width: '38%', aspectRatio: '1 / 1' }} />
                    )}

                    {hovered === date && (
                      <div className="absolute z-30 top-full left-1/2 -translate-x-1/2 mt-1 w-44 rounded-md border border-line/20 bg-surface shadow-lg p-2 text-left pointer-events-none">
                        <div className="text-[11px] text-ink font-medium">{longDate(date)}</div>
                        {entry && entry.total > 0 ? (
                          <>
                            <div className="text-[10px] text-ink-faint mb-1">{entry.total} words planned</div>
                            {entry.parts.map(p => (
                              <div key={p.lang.key} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                                <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: p.lang.color }} />
                                <span className="truncate flex-1">{p.lang.label}</span>
                                <span className="text-ink tabular-nums">{p.words}</span>
                                <span className="text-ink-faint tabular-nums w-9 text-right">
                                  {Math.round((p.words / entry.total) * 100)}%
                                </span>
                              </div>
                            ))}
                          </>
                        ) : (
                          <div className="text-[10px] text-ink-faint">Nothing planned — a day off, or outside every schedule.</div>
                        )}
                        {deadlines.map(l => (
                          <div key={l.key} className="text-[10px] text-ink-faint mt-1">Deadline: {l.label}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {selection.length > 0 && (
        <div className="rounded-md border border-line/10 bg-surface/40 p-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink">
            {selection.length === 1
              ? longDate(selection[0]!)
              : `${selection.length} days · ${selection[0]!.slice(5)} → ${selection[selection.length - 1]!.slice(5)}`}
          </span>
          <button className="btn-ghost text-xs py-1" onClick={() => { onBulkDateCaps(selection, 0); setSelection([]) }}>
            Time off — every language
          </button>
          <button className="btn-ghost text-xs py-1" onClick={() => { onBulkDateCaps(selection, null); setSelection([]) }}>
            Clear time off
          </button>
          <button className="btn-ghost text-xs py-1 ml-auto" onClick={() => setSelection([])}>Done</button>
        </div>
      )}

      {/* A weekly rest day across everything. Per-language weekday patterns live in each language's
          own editor below — this is the "I never study Sundays" case, which would otherwise mean
          setting the same 0 on every schedule by hand. */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs text-ink-faint">No new words on:</span>
        {WEEKDAY_LABELS.map(({ day, label }) => {
          const off = restDays.includes(day)
          return (
            <button
              key={day}
              onClick={() => onBulkWeekdayOff(day, !off)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                off ? 'border-accent bg-accent/15 text-ink' : 'border-line/10 text-ink-muted hover:text-ink'}`}
            >
              {off ? '✓ ' : ''}{label}
            </button>
          )
        })}
        <span className="text-xs text-ink-faint">every week, all languages</span>
      </div>

      <p className="text-xs text-ink-faint">
        Each day is split by language in proportion to the words planned for it. Hover a day for the
        exact numbers; a ring marks today and an outline marks a language&apos;s deadline. Drag across
        days to block out travel. Colours are the ones set in Settings → Language colors.
      </p>
    </div>
  )
}
