'use client'

/**
 * SyncConflictModal — resolves card-state conflicts surfaced when going back online. For each card
 * that was studied BOTH offline and on another device since download, it shows a device-vs-cloud diff
 * of the key study fields and lets the user pick which version to keep (per card, or in bulk).
 */
import { useState } from 'react'
import type { CardState } from '@/domain'
import type { CardStateConflict, ConflictChoice } from '@/lib/offline/sync'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** The handful of study fields worth showing in a conflict diff. */
function summarize(s: CardState): { label: string; value: string }[] {
  return [
    { label: 'Due',        value: fmtDate(s.dueAt) },
    { label: 'Interval',   value: `${s.intervalDays.toFixed(1)}d` },
    { label: 'Reviews',    value: String(s.reps) },
    { label: 'Lapses',     value: String(s.lapses) },
    { label: 'Last rating', value: s.lastRating ?? '—' },
    { label: 'Graduated',  value: s.graduated ? 'yes' : 'no' },
    { label: 'Dormant',    value: s.dormant ? 'yes' : 'no' },
    { label: 'Difficulty', value: s.difficulty != null ? s.difficulty.toFixed(1) : '—' },
    { label: 'Stability',  value: s.stability != null ? s.stability.toFixed(1) : '—' },
    { label: 'Reviewed',   value: fmtDate(s.lastReviewedAt) },
  ]
}

export function SyncConflictModal({
  conflicts, onResolve, onDefer,
}: {
  conflicts: CardStateConflict[]
  onResolve: (choices: Map<string, ConflictChoice>) => void
  onDefer: () => void
}) {
  const [choices, setChoices] = useState<Map<string, ConflictChoice>>(
    () => new Map(conflicts.map(c => [c.key, 'device' as ConflictChoice])),
  )
  const [busy, setBusy] = useState(false)

  const setOne = (key: string, choice: ConflictChoice) => setChoices(prev => new Map(prev).set(key, choice))
  const setAll = (choice: ConflictChoice) => setChoices(new Map(conflicts.map(c => [c.key, choice])))

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
      <div className="bg-surface-deep border border-line/10 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b border-line/10">
          <h2 className="text-lg font-semibold text-ink">Sync conflicts</h2>
          <p className="text-xs text-ink-faint mt-1">
            {conflicts.length} card{conflicts.length === 1 ? '' : 's'} changed both on this device (offline) and elsewhere.
            Pick which version to keep.
          </p>
          <div className="flex gap-2 mt-3">
            <button onClick={() => setAll('device')} className="btn-ghost text-xs py-1">Keep all device</button>
            <button onClick={() => setAll('cloud')}  className="btn-ghost text-xs py-1">Keep all cloud</button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-3 space-y-4">
          {conflicts.map(c => {
            const choice = choices.get(c.key) ?? 'device'
            const dev = summarize(c.device)
            const cloud = summarize(c.cloud)
            return (
              <div key={c.key} className="rounded-lg border border-line/10 p-3">
                <div className="text-sm text-ink font-medium">{c.front} <span className="text-ink-faint">· {c.back}</span>
                  <span className="text-xs text-ink-faint ml-2">({c.direction})</span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  {(['device', 'cloud'] as ConflictChoice[]).map(side => {
                    const rows = side === 'device' ? dev : cloud
                    const other = side === 'device' ? cloud : dev
                    const selected = choice === side
                    return (
                      <button
                        key={side}
                        onClick={() => setOne(c.key, side)}
                        className={`text-left rounded-md border p-2 transition-colors ${selected ? 'border-accent bg-accent/5' : 'border-line/10 hover:border-line/20'}`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-ink-muted uppercase tracking-wide">{side === 'device' ? 'This device' : 'Cloud'}</span>
                          {selected && <span className="text-[10px] text-accent font-semibold">KEEP</span>}
                        </div>
                        <dl className="text-xs space-y-0.5">
                          {rows.map((r, i) => {
                            const differs = other[i]?.value !== r.value
                            return (
                              <div key={r.label} className="flex justify-between gap-2">
                                <dt className="text-ink-faint">{r.label}</dt>
                                <dd className={differs ? 'text-ink font-medium' : 'text-ink-muted'}>{r.value}</dd>
                              </div>
                            )
                          })}
                        </dl>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div className="px-5 py-4 border-t border-line/10 flex justify-between items-center gap-3">
          <button onClick={onDefer} disabled={busy} className="text-xs text-ink-faint hover:text-ink">Decide later</button>
          <button
            onClick={() => { setBusy(true); onResolve(choices) }}
            disabled={busy}
            className="btn-primary text-sm disabled:opacity-50"
          >
            {busy ? 'Applying…' : 'Apply & finish sync'}
          </button>
        </div>
      </div>
    </div>
  )
}
