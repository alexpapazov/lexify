'use client'

/**
 * components/study/CatchUpPanel.tsx — "you're 1,693 behind" turned into a daily number.
 *
 * Shows one row per scope that has a backlog. A scope with no plan offers to make one; a scope with a
 * plan shows today's quota, how it splits, and how far through the drain it is.
 *
 * The panel renders entirely from DERIVED numbers — nothing here is read back from storage except the
 * target date itself (see lib/catchUp.ts for why that matters). So it is always honest about the live
 * backlog, including on a day you did nothing.
 */

import { useMemo, useState } from 'react'
import { langName } from '@/lib/languages'
import {
  catchUpQuota, previewCatchUp, isLapsed, scopeKey,
  addDays, daysBetween,
  type CatchUpPlans, type CatchUpType,
} from '@/lib/catchUp'
import type { ScopePool } from '@/lib/catchUpPools'

/** Day options offered by the picker, plus whatever the learner types in. */
const PRESET_DAYS = [3, 7, 14, 30]

const TYPE_LABEL: Record<CatchUpType, string> = {
  typing:    'Typing',
  sgForward: 'Self-graded · native → target',
  sgReverse: 'Self-graded · target → native',
}

export interface CatchUpScope {
  /** `${source}|${target}` */
  pairKey: string
  source:  string
  target:  string
  /** null = the whole language. */
  type:    CatchUpType | null
  pool:    ScopePool
  /** Measured ms per review for this scope, for the minutes estimate. */
  msPerReview: number
}

interface Props {
  scopes:   CatchUpScope[]
  plans:    CatchUpPlans
  today:    string
  /** Estimated arrivals per day for a scope, from the forecast. */
  inflowFor: (pairKey: string, type: CatchUpType | null) => number
  onSave:   (key: string, targetDate: string | null) => void
}

function fmtMinutes(mins: number): string {
  if (mins < 60) return `~${Math.round(mins)} min`
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m === 0 ? `~${h} hr` : `~${h} hr ${m} min`
}

export default function CatchUpPanel({ scopes, plans, today, inflowFor, onSave }: Props) {
  const [granularity, setGranularity] = useState<'language' | 'type'>('language')
  const [picking, setPicking] = useState<string | null>(null)
  const [custom,  setCustom]  = useState('')

  const visible = useMemo(
    () => scopes
      .filter(s => (granularity === 'language' ? s.type === null : s.type !== null))
      .filter(s => s.pool.overdue.length > 0 || plans[scopeKey(s.pairKey, s.type)])
      .sort((a, b) => b.pool.overdue.length - a.pool.overdue.length),
    [scopes, granularity, plans],
  )

  // A plan on the other granularity still governs real sessions, so hiding it entirely would be a lie.
  const hiddenPlans = useMemo(
    () => scopes.filter(s =>
      (granularity === 'language' ? s.type !== null : s.type === null) && plans[scopeKey(s.pairKey, s.type)],
    ).length,
    [scopes, granularity, plans],
  )

  if (scopes.every(s => s.pool.overdue.length === 0) && Object.keys(plans).length === 0) return null

  return (
    <div className="space-y-3" data-tour="catch-up">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium text-ink">Catch up</h2>
        <div className="flex rounded-full border border-line/15 overflow-hidden text-xs">
          {(['language', 'type'] as const).map(g => (
            <button
              key={g}
              onClick={() => { setGranularity(g); setPicking(null) }}
              className={`px-3 py-1 transition-colors ${
                granularity === g ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink'
              }`}
            >
              {g === 'language' ? 'By language' : 'By card type'}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-card border border-line/10 bg-surface-deep overflow-hidden">
        {visible.length === 0 && (
          <p className="px-4 py-4 text-sm text-ink-faint">
            {granularity === 'language'
              ? 'No language is behind right now.'
              : 'No card type is behind right now.'}
          </p>
        )}

        {visible.map(s => {
          const key     = scopeKey(s.pairKey, s.type)
          const plan    = plans[key]
          const overdue = s.pool.overdue.length
          const lapsed  = s.pool.overdue.filter(isLapsed).length
          const inflow  = inflowFor(s.pairKey, s.type)
          const label   = `${langName(s.source)} → ${langName(s.target)}`

          const quota = plan
            ? catchUpQuota({ overdue, dueToday: s.pool.dueToday.length, targetDate: plan.targetDate, today })
            : null

          return (
            <div key={key} className="border-b border-line/10 last:border-b-0">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink truncate">{label}</div>
                  <div className="text-xs text-ink-faint">
                    {s.type ? `${TYPE_LABEL[s.type]} · ` : ''}
                    {overdue > 0 ? `${overdue.toLocaleString()} behind` : 'caught up'}
                    {lapsed > 0 ? ` · ${lapsed.toLocaleString()} deeply lapsed` : ''}
                  </div>
                </div>

                {quota ? (
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="text-sm text-ink font-medium">{quota.quota.toLocaleString()} today</div>
                      <div className="text-xs text-ink-faint">
                        {quota.pastTarget
                          ? 'past target — finishing the rest'
                          : `${quota.fromToday.toLocaleString()} due + ${quota.fromBacklog.toLocaleString()} backlog · ${quota.daysRemaining}d left`}
                      </div>
                    </div>
                    <button
                      className="text-xs text-ink-faint hover:text-danger transition-colors"
                      onClick={() => onSave(key, null)}
                      title="Cancel this catch-up plan"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn-ghost text-xs px-3 py-1.5 shrink-0"
                    onClick={() => { setPicking(picking === key ? null : key); setCustom('') }}
                  >
                    {picking === key ? 'Cancel' : 'Plan'}
                  </button>
                )}
              </div>

              {picking === key && (
                <div className="px-4 pb-4 pt-1 bg-surface-deep/60 space-y-2">
                  <p className="text-xs text-ink-faint">Be caught up in…</p>
                  <div className="flex flex-wrap gap-2">
                    {PRESET_DAYS.map(d => {
                      const p = previewCatchUp({
                        overdue, lapsed, inflowPerDay: inflow, days: d, msPerAnswer: s.msPerReview,
                      })
                      return (
                        <button
                          key={d}
                          onClick={() => { onSave(key, addDays(today, d)); setPicking(null) }}
                          className="flex-1 min-w-[8.5rem] rounded-card border border-line/15 px-3 py-2 text-left hover:border-accent/50 hover:bg-surface-raised transition-colors"
                        >
                          <div className="text-sm text-ink">{d} days</div>
                          <div className="text-xs text-ink-faint">
                            {p.perDay.toLocaleString()}/day
                            {p.minutesPerDay != null && ` · ${fmtMinutes(p.minutesPerDay)}`}
                          </div>
                          {p.lapsedFinishesInDays > d && (
                            <div className="text-xs text-warning mt-0.5">
                              lapsed tail ~{Number.isFinite(p.lapsedFinishesInDays) ? p.lapsedFinishesInDays : '∞'}d
                            </div>
                          )}
                        </button>
                      )
                    })}
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="date"
                      value={custom}
                      min={addDays(today, 1)}
                      onChange={e => setCustom(e.target.value)}
                      className="input text-xs py-1.5 px-2 w-auto"
                    />
                    <button
                      className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                      disabled={!custom || daysBetween(today, custom) < 1}
                      onClick={() => { onSave(key, custom); setPicking(null) }}
                    >
                      Use this date
                    </button>
                    {custom && daysBetween(today, custom) >= 1 && (() => {
                      const p = previewCatchUp({
                        overdue, lapsed, inflowPerDay: inflow,
                        days: daysBetween(today, custom), msPerAnswer: s.msPerReview,
                      })
                      return (
                        <span className="text-xs text-ink-faint">
                          {p.perDay.toLocaleString()}/day
                          {p.minutesPerDay != null && ` · ${fmtMinutes(p.minutesPerDay)}`}
                        </span>
                      )
                    })()}
                  </div>

                  {lapsed > 0 && (
                    <p className="text-xs text-ink-faint pt-1">
                      {`Sessions stay at most a quarter relearning, so the ${lapsed.toLocaleString()} deeply lapsed cards are paced rather than crammed — a tail longer than your target is flagged above.`}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {hiddenPlans > 0 && (
        <p className="text-xs text-ink-faint">
          {`${hiddenPlans} active plan${hiddenPlans === 1 ? '' : 's'} on the other grouping — switch above to see ${hiddenPlans === 1 ? 'it' : 'them'}.`}
        </p>
      )}
    </div>
  )
}
