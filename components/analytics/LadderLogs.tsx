'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseLadderEventRepository } from '@/lib/data/ladderEvents'
import { groupSessions, type SessionSummary } from '@/lib/ladderLog'
import { langName, langFlag } from '@/lib/languages'
import { LadderReplay } from './LadderReplay'

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
function fmtWhen(epoch: number): string {
  const d = new Date(epoch)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function LadderLogs() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const { data: { session } } = await createClient().auth.getSession()
        if (!session) return
        const events = await new SupabaseLadderEventRepository().listForUser(session.user.id)
        setSessions(groupSessions(events))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  return (
    <div className="panel p-5 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">Logs</h2>
        <p className="text-xs text-ink-faint">Every learning-ladder session, with how long it took, time spent per card, and a replay of your cards climbing the ladder.</p>
      </div>

      {error && <p className="text-sm text-danger">Couldn&apos;t load logs: {error}</p>}
      {!sessions && !error && <p className="text-sm text-ink-faint">Loading…</p>}
      {sessions && sessions.length === 0 && (
        <p className="text-sm text-ink-faint">No ladder sessions logged yet — study some cards from the ladder and they&apos;ll show up here.</p>
      )}

      <div className="divide-y divide-line/5">
        {sessions?.map(s => {
          const open = openId === s.sessionId
          const pair = s.source ? `${langFlag(s.source)} ${langName(s.source)} → ${s.target ? langName(s.target) : ''}` : 'Ladder session'
          return (
            <div key={s.sessionId} className="py-2">
              <button onClick={() => setOpenId(open ? null : s.sessionId)}
                className="w-full flex items-center justify-between gap-3 text-left hover:bg-surface/40 rounded-lg px-2 py-1.5 transition-colors">
                <div className="min-w-0">
                  <div className="text-sm text-ink flex items-center gap-2">
                    <span className="text-ink-faint">{open ? '▾' : '▸'}</span>
                    <span className="truncate">{pair}</span>
                  </div>
                  <div className="text-xs text-ink-faint pl-5">{fmtWhen(s.start)}</div>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  <span className="text-ink-muted">{s.cardCount} card{s.cardCount === 1 ? '' : 's'}</span>
                  {s.graduatedCount > 0 && <span className="text-success">{s.graduatedCount} graduated</span>}
                  <span className="chip">{fmtDuration(s.activeMs)} active</span>
                </div>
              </button>

              {open && (
                <div className="pl-2 pr-2 pt-3 space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <Stat label="Attempts" value={String(s.attempts)} />
                    <Stat label="Active time" value={fmtDuration(s.activeMs)} />
                    <Stat label="Elapsed" value={fmtDuration(s.wallMs)} />
                    <Stat label="Avg / card" value={fmtDuration(s.cardCount ? s.activeMs / s.cardCount : 0)} />
                  </div>

                  <LadderReplay session={s} />

                  {/* Per-card breakdown */}
                  <div className="rounded-lg border border-line/10 overflow-hidden">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-wider text-ink-faint bg-surface/40">
                      <span>Card</span><span>Attempts</span><span>Time</span><span>Reached</span>
                    </div>
                    <div className="max-h-56 overflow-y-auto divide-y divide-line/5">
                      {s.cards.map(c => (
                        <div key={c.cardId} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-1.5 text-xs items-center">
                          <span className="text-ink truncate">{c.label}</span>
                          <span className="text-ink-muted text-center">{c.attempts}</span>
                          <span className="text-ink-muted tabular-nums">{fmtDuration(c.activeMs)}</span>
                          <span className={c.graduated ? 'text-success' : 'text-ink-muted'}>{c.graduated ? '✓ Grad' : `Rung ${c.maxRung + 1}`}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line/10 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="text-sm text-ink font-medium">{value}</div>
    </div>
  )
}
