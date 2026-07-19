'use client'

/**
 * DueNowLogs — the "Due Now" side of Analytics → Logs: a list of your Due Now review sessions, each
 * expandable into an ORBIT replay (OrbitReplay). Reviews come from `review_events` (review_mode='due');
 * a card's orbit radius uses its CURRENT interval from card_states (accurate for recent sessions).
 */
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { groupDueSessions, type DueSession, type RawDueEvent } from '@/lib/dueNowLog'
import { langName, langFlag } from '@/lib/languages'
import { OrbitReplay } from './OrbitReplay'

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
function fmtWhen(epoch: number): string {
  const d = new Date(epoch)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function DueNowLogs() {
  const [sessions, setSessions] = useState<DueSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) return
        const uid = session.user.id
        const since = new Date(Date.now() - 120 * 86_400_000).toISOString()  // last ~4 months

        const { data: evs } = await supabase.from('review_events')
          .select('card_id, rating, reviewed_at, response_ms, review_direction, source_language, target_language')
          .eq('user_id', uid).eq('review_mode', 'due').gte('reviewed_at', since)
          .order('reviewed_at', { ascending: true }).limit(4000)

        const raw: RawDueEvent[] = (evs ?? []).map(e => ({
          cardId: e.card_id as string,
          rating: (e.rating as string | null) ?? 'good',
          at: new Date(e.reviewed_at as string).getTime(),
          ms: (e.response_ms as number | null) ?? 0,
          direction: (e.review_direction as string) === 'reverse' ? 'reverse' : 'forward',
          source: (e.source_language as string | null) ?? null,
          target: (e.target_language as string | null) ?? null,
        }))
        const grouped = groupDueSessions(raw)

        // Enrich each card with its front (label) + current interval (orbit radius).
        const cardIds = [...new Set(raw.map(r => r.cardId))]
        const frontById = new Map<string, string>()
        const intervalById = new Map<string, number>()
        if (cardIds.length > 0) {
          const [cardsRes, statesRes] = await Promise.all([
            supabase.from('cards').select('id, front').in('id', cardIds),
            supabase.from('card_states').select('card_id, interval_days, scheduled_interval_days').eq('user_id', uid).eq('review_direction', 'forward').in('card_id', cardIds),
          ])
          for (const r of cardsRes.data ?? []) frontById.set(r.id as string, r.front as string)
          for (const r of statesRes.data ?? []) intervalById.set(r.card_id as string, (r.scheduled_interval_days as number | null) ?? (r.interval_days as number | null) ?? 1)
        }
        for (const s of grouped) for (const c of s.cards) {
          c.label = frontById.get(c.cardId) ?? '—'
          c.intervalDays = intervalById.get(c.cardId) ?? 1
        }

        setSessions(grouped)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  return (
    <div className="panel p-5 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">Due Now logs</h2>
        <p className="text-xs text-ink-faint">Every Due Now review session as an orbit movie — watch each card get flung out to its new review interval, coloured by how you rated it.</p>
      </div>

      {error && <p className="text-sm text-danger">Couldn&apos;t load logs: {error}</p>}
      {!sessions && !error && <p className="text-sm text-ink-faint">Loading…</p>}
      {sessions && sessions.length === 0 && (
        <p className="text-sm text-ink-faint">No Due Now reviews logged yet — review some graduated cards and they&apos;ll show up here.</p>
      )}

      <div className="divide-y divide-line/5">
        {sessions?.map(s => {
          const open = openId === s.sessionId
          const src = s.cards[0]?.source
          const pair = src ? `${langFlag(src)} ${langName(src)} → ${s.cards[0]?.target ? langName(s.cards[0]!.target!) : ''}` : 'Due Now session'
          return (
            <div key={s.sessionId} className="py-2">
              <button onClick={() => setOpenId(open ? null : s.sessionId)}
                className="w-full flex items-center justify-between gap-3 text-left hover:bg-surface/40 rounded-lg px-2 py-1.5 transition-colors">
                <div className="min-w-0">
                  <div className="text-sm text-ink flex items-center gap-2"><span className="text-ink-faint">{open ? '▾' : '▸'}</span><span className="truncate">{pair}</span></div>
                  <div className="text-xs text-ink-faint pl-5">{fmtWhen(s.start)}</div>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  <span className="text-ink-muted">{s.cardCount} card{s.cardCount === 1 ? '' : 's'}</span>
                  {s.againCount > 0 && <span className="text-danger">{s.againCount} lapse{s.againCount === 1 ? '' : 's'}</span>}
                  <span className="chip">{fmtDuration(s.activeMs)}</span>
                </div>
              </button>

              {open && (
                <div className="pl-2 pr-2 pt-3 space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <Stat label="Cards" value={String(s.cardCount)} />
                    <Stat label="Reviews" value={String(s.reviewCount)} />
                    <Stat label="Lapses" value={String(s.againCount)} />
                    <Stat label="Active time" value={fmtDuration(s.activeMs)} />
                  </div>
                  <OrbitReplay session={s} />
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
