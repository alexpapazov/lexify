'use client'

/**
 * DayDetailModal — a detailed breakdown for one study day: total active time, time spent clearing Due
 * Now cards split by language + direction, and the list of cards learned (graduated) that day with
 * links to open each in its deck. Data is fetched on open for just this day.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { langName } from '@/lib/languages'
import { localDateWithTurnover } from '@/lib/dates'
import { displayText } from '@/lib/cardText'
import { routes } from '@/lib/routes'

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function fullDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

interface LearnedCard { cardId: string; front: string; back: string; source: string; target: string; deckId: string | null }
interface DueGroup { source: string; target: string; direction: 'forward' | 'reverse'; count: number; ms: number }

export function DayDetailModal({ date, tz, turnover, onClose }: { date: string; tz: string; turnover: number; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [learned, setLearned] = useState<LearnedCard[]>([])
  const [dueGroups, setDueGroups] = useState<DueGroup[]>([])
  const [totalMs, setTotalMs] = useState(0)
  const [dueMs, setDueMs] = useState(0)

  useEffect(() => {
    ;(async () => {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setLoading(false); return }
      const uid = session.user.id
      // Over-fetch ±1–2 days so turnover / timezone bucketing is covered, then filter to this day.
      const qStart = new Date(new Date(date + 'T00:00:00Z').getTime() - 86400000).toISOString()
      const qEnd   = new Date(new Date(date + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString()
      const onDay = (ts: string) => localDateWithTurnover(ts, tz, turnover) === date

      const [gradsRes, revsRes, ladRes] = await Promise.all([
        supabase.from('card_states')
          .select('card_id, graduated_at, cards(front, back, source_language, target_language)')
          .eq('user_id', uid).eq('graduated', true).neq('review_direction', 'reverse')
          .gte('graduated_at', qStart).lte('graduated_at', qEnd),
        supabase.from('review_events')
          .select('reviewed_at, response_ms, review_direction, source_language, target_language')
          .eq('user_id', uid).eq('review_mode', 'due')
          .gte('reviewed_at', qStart).lte('reviewed_at', qEnd),
        supabase.from('ladder_events')
          .select('created_at, duration_ms')
          .eq('user_id', uid)
          .gte('created_at', qStart).lte('created_at', qEnd),
      ])

      // Cards learned (graduated) that day
      const cards: LearnedCard[] = []
      const ids: string[] = []
      for (const g of gradsRes.data ?? []) {
        if (!onDay(g.graduated_at as string)) continue
        const c = g.cards as unknown as { front: string; back: string; source_language: string; target_language: string } | null
        if (!c) continue
        cards.push({ cardId: g.card_id as string, front: displayText(c.front), back: displayText(c.back), source: c.source_language, target: c.target_language, deckId: null })
        ids.push(g.card_id as string)
      }
      if (ids.length) {
        const { data: links } = await supabase.from('deck_cards').select('card_id, deck_id').in('card_id', ids)
        const deckByCard = new Map<string, string>()
        for (const l of links ?? []) if (!deckByCard.has(l.card_id as string)) deckByCard.set(l.card_id as string, l.deck_id as string)
        for (const c of cards) c.deckId = deckByCard.get(c.cardId) ?? null
      }

      // Due Now reviews → time by language + direction
      const groups = new Map<string, DueGroup>()
      let reviewMs = 0
      for (const r of revsRes.data ?? []) {
        if (!onDay(r.reviewed_at as string)) continue
        const ms = (r.response_ms as number | null) ?? 0
        reviewMs += ms
        const dir = (r.review_direction as string) === 'reverse' ? 'reverse' : 'forward'
        const src = (r.source_language as string | null) ?? '?'
        const tgt = (r.target_language as string | null) ?? '?'
        const key = `${src}|${tgt}|${dir}`
        let grp = groups.get(key)
        if (!grp) { grp = { source: src, target: tgt, direction: dir, count: 0, ms: 0 }; groups.set(key, grp) }
        grp.count++; grp.ms += ms
      }

      // Ladder (learning) time
      let ladderMs = 0
      for (const e of ladRes.data ?? []) {
        if (!onDay(e.created_at as string)) continue
        ladderMs += (e.duration_ms as number | null) ?? 0
      }

      setLearned(cards)
      setDueGroups([...groups.values()].sort((a, b) => b.ms - a.ms))
      setDueMs(reviewMs)
      setTotalMs(reviewMs + ladderMs)
      setLoading(false)
    })()
  }, [date, tz, turnover])

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-surface-deep border border-line/10 rounded-xl max-w-lg w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-line/10 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-ink">{fullDate(date)}</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink text-lg leading-none">✕</button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
          {loading ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : (
            <>
              {/* Summary counters */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-line/10 p-3 text-center">
                  <div className="text-xl font-semibold text-success">{learned.length}</div>
                  <div className="text-xs text-ink-faint mt-0.5">Cards learned</div>
                </div>
                <div className="rounded-lg border border-line/10 p-3 text-center">
                  <div className="text-xl font-semibold text-ink">{fmtDuration(totalMs)}</div>
                  <div className="text-xs text-ink-faint mt-0.5">Active study</div>
                </div>
                <div className="rounded-lg border border-line/10 p-3 text-center">
                  <div className="text-xl font-semibold text-ink">{fmtDuration(dueMs)}</div>
                  <div className="text-xs text-ink-faint mt-0.5">Due-now time</div>
                </div>
              </div>

              {/* Due Now time by language + direction */}
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wider">Due Now reviews</h3>
                {dueGroups.length === 0 ? (
                  <p className="text-sm text-ink-faint">No Due Now reviews this day.</p>
                ) : (
                  <div className="rounded-lg border border-line/10 divide-y divide-line/5">
                    {dueGroups.map(g => (
                      <div key={`${g.source}|${g.target}|${g.direction}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <span className="text-ink">
                          {langName(g.source)} → {langName(g.target)}
                          <span className="text-ink-faint text-xs ml-2">{g.direction === 'reverse' ? 'recognition' : 'production'}</span>
                        </span>
                        <span className="text-ink-muted text-xs shrink-0">{g.count} · {fmtDuration(g.ms)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Cards learned list */}
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wider">Cards learned ({learned.length})</h3>
                {learned.length === 0 ? (
                  <p className="text-sm text-ink-faint">No new cards graduated this day.</p>
                ) : (
                  <div className="rounded-lg border border-line/10 divide-y divide-line/5">
                    {learned.map(c => {
                      const inner = (
                        <div className="flex items-center gap-3 px-3 py-2 text-sm">
                          <span className="font-medium text-ink truncate max-w-[45%]">{c.front}</span>
                          <span className="text-ink-faint">→</span>
                          <span className="text-ink-muted truncate flex-1">{c.back}</span>
                          {c.deckId && <span className="text-accent-soft text-xs shrink-0">Open ↗</span>}
                        </div>
                      )
                      return c.deckId
                        ? <Link key={c.cardId} href={routes.deck(c.deckId, { card: c.cardId })} className="block hover:bg-surface-raised/50 transition-colors">{inner}</Link>
                        : <div key={c.cardId}>{inner}</div>
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
