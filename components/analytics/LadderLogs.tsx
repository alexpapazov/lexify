'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseLadderEventRepository } from '@/lib/data/ladderEvents'
import { groupSessions, type SessionSummary } from '@/lib/ladderLog'
import { reconstructEvents, type ClimbRecord } from '@/lib/ladderReconstruct'
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
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) return
        const events = await new SupabaseLadderEventRepository().listForUser(session.user.id)
        const grouped = groupSessions(events)
        const loggedCardIds = new Set(events.map(e => e.cardId))

        // Reconstruct sessions that predate event logging from surviving climb rung-histories.
        const [climbRes, deckRes] = await Promise.all([
          supabase.from('ladder_climb').select('card_id, deck_id, state, updated_at'),
          supabase.from('decks').select('id, source_language, target_language'),
        ])
        const deckPair = new Map((deckRes.data ?? []).map(d => [d.id as string, { s: d.source_language as string | null, t: d.target_language as string | null }]))
        const orphanClimbs = (climbRes.data ?? []).filter(r => {
          const st = r.state as { rungHistory?: number[] } | null
          return (st?.rungHistory?.length ?? 0) > 1 && !loggedCardIds.has(r.card_id as string)
        })

        // Fetch current fronts for every card we'll show (logged + orphan).
        const allCardIds = [...new Set([...loggedCardIds, ...orphanClimbs.map(r => r.card_id as string)])]
        const frontById = new Map<string, string>()
        if (allCardIds.length > 0) {
          const { data } = await supabase.from('cards').select('id, front').in('id', allCardIds)
          for (const r of data ?? []) frontById.set(r.id as string, r.front as string)
        }
        for (const s of grouped) for (const c of s.cards) c.label = frontById.get(c.cardId) ?? c.label

        // A card's true graduation status lives in card_states (the climb flag can be stale if it
        // graduated via a non-ladder path or a glitch). Use it so graduated cards jump to GRAD.
        const gradByCard = new Set<string>()
        const orphanIds = orphanClimbs.map(r => r.card_id as string)
        if (orphanIds.length > 0) {
          const { data } = await supabase.from('card_states')
            .select('card_id').eq('review_direction', 'forward').eq('graduated', true).in('card_id', orphanIds)
          for (const r of data ?? []) gradByCard.add(r.card_id as string)
        }

        let reconstructed: SessionSummary[] = []
        if (orphanClimbs.length > 0) {
          const records: ClimbRecord[] = orphanClimbs
            .filter(r => frontById.has(r.card_id as string)) // skip deleted cards; the movie still shows the rest
            .map(r => {
              const st = r.state as { rungHistory?: number[]; graduated?: boolean }
              const pair = deckPair.get(r.deck_id as string)
              return {
                cardId: r.card_id as string,
                front: frontById.get(r.card_id as string) ?? '—',
                source: pair?.s ?? null, target: pair?.t ?? null,
                rungHistory: st.rungHistory ?? [],
                graduated: !!st.graduated || gradByCard.has(r.card_id as string),
                updatedAtMs: new Date(r.updated_at as string).getTime(),
              }
            })
          reconstructed = groupSessions(reconstructEvents(records)).map(s => ({ ...s, reconstructed: true }))
        }

        setSessions([...grouped, ...reconstructed].sort((a, b) => b.start - a.start))
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
                    {s.reconstructed && <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-line/20 text-ink-faint">reconstructed</span>}
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
                  {s.reconstructed && (
                    <p className="text-[11px] text-ink-faint">
                      Rebuilt from each card&apos;s rung history (this session predates event logging) — the climb is real,
                      but there are no per-attempt times or rating colours.
                    </p>
                  )}
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
