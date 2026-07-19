'use client'

/**
 * DayDetailModal — detailed breakdown for one study day: total active time, Due Now time split by
 * language + direction (each expandable to the individual cards, their rating sequence, and where
 * they landed), and the cards learned that day (filterable by language, each linking to its deck).
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { langName } from '@/lib/languages'
import { localDateWithTurnover } from '@/lib/dates'
import { displayText } from '@/lib/cardText'
import { routes } from '@/lib/routes'

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—'   // no timing data (e.g. older days recorded before timing shipped)
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}
const addDays = (dateStr: string, n: number) =>
  new Date(new Date(dateStr + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)
function fullDate(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
const RATING_CHIP: Record<string, string> = {
  again: 'bg-danger/20 text-danger',
  hard:  'bg-orange-500/20 text-orange-400',
  good:  'bg-success/20 text-success',
  easy:  'bg-accent/20 text-accent-soft',
}

interface ReviewRow { rating: string; wasCorrect: boolean }
interface DueCard { cardId: string; front: string; back: string; deckId: string | null; deckName: string | null; reviews: ReviewRow[]; intervalDays: number | null }
interface DueGroup { key: string; source: string; target: string; direction: 'forward' | 'reverse'; count: number; ms: number; cards: DueCard[] }
interface LearnedCard { cardId: string; front: string; back: string; source: string; deckId: string | null; deckName: string | null }
interface AutoCard extends LearnedCard { accelerated: boolean }

export function DayDetailModal({ date, tz, turnover, minDate, maxDate, onClose }: { date: string; tz: string; turnover: number; minDate: string | null; maxDate: string; onClose: () => void }) {
  const [viewDate, setViewDate] = useState(date)
  const [loading, setLoading] = useState(true)
  const [learned, setLearned] = useState<LearnedCard[]>([])
  const [auto, setAuto] = useState<AutoCard[]>([])
  const [groups, setGroups] = useState<DueGroup[]>([])
  const [totalMs, setTotalMs] = useState(0)
  const [dueMs, setDueMs] = useState(0)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [langFilter, setLangFilter] = useState<string | null>(null)

  const canPrev = !minDate || viewDate > minDate
  const canNext = viewDate < maxDate

  useEffect(() => {
    setLoading(true); setOpenGroup(null); setLangFilter(null)
    ;(async () => {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setLoading(false); return }
      const uid = session.user.id
      const qStart = new Date(new Date(viewDate + 'T00:00:00Z').getTime() - 86400000).toISOString()
      const qEnd   = new Date(new Date(viewDate + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString()
      const onDay = (ts: string) => localDateWithTurnover(ts, tz, turnover) === viewDate

      const [gradsRes, revsRes, ladRes] = await Promise.all([
        supabase.from('card_states')
          .select('card_id, graduated_at, accelerated_mode, cards(front, back, source_language, target_language)')
          .eq('user_id', uid).eq('graduated', true).neq('review_direction', 'reverse')
          .gte('graduated_at', qStart).lte('graduated_at', qEnd),
        supabase.from('review_events')
          .select('card_id, reviewed_at, response_ms, review_direction, source_language, target_language, rating, was_correct')
          .eq('user_id', uid).eq('review_mode', 'due')
          .gte('reviewed_at', qStart).lte('reviewed_at', qEnd).order('reviewed_at', { ascending: true }),
        supabase.from('ladder_events').select('created_at, duration_ms').eq('user_id', uid)
          .gte('created_at', qStart).lte('created_at', qEnd),
      ])

      // Which cards do we need fronts / decks / intervals for?
      const reviewRows = (revsRes.data ?? []).filter(r => onDay(r.reviewed_at as string))
      const dayGrads = (gradsRes.data ?? []).filter(g => onDay(g.graduated_at as string))
      const learnedRows = dayGrads.filter(g => ((g.accelerated_mode as string | null) ?? 'none') === 'none')
      const autoRows    = dayGrads.filter(g => ((g.accelerated_mode as string | null) ?? 'none') !== 'none')
      const reviewedIds = [...new Set(reviewRows.map(r => r.card_id as string))]
      const allIds = [...new Set([...reviewedIds, ...dayGrads.map(g => g.card_id as string)])]

      const [cardsRes, linksRes, statesRes] = await Promise.all([
        allIds.length ? supabase.from('cards').select('id, front, back').in('id', allIds) : Promise.resolve({ data: [] as { id: string; front: string; back: string }[] }),
        allIds.length ? supabase.from('deck_cards').select('card_id, decks(id, name)').in('card_id', allIds) : Promise.resolve({ data: [] as unknown[] }),
        reviewedIds.length ? supabase.from('card_states').select('card_id, interval_days').eq('user_id', uid).eq('review_direction', 'forward').in('card_id', reviewedIds) : Promise.resolve({ data: [] as { card_id: string; interval_days: number }[] }),
      ])
      const cardById = new Map((cardsRes.data ?? []).map(c => [c.id as string, c as { id: string; front: string; back: string }]))
      const deckByCard = new Map<string, { id: string; name: string }>()
      for (const l of (linksRes.data ?? []) as unknown as { card_id: string; decks: { id: string; name: string; deleted_at?: string | null } | null }[]) {
        if (l.decks && !deckByCard.has(l.card_id)) deckByCard.set(l.card_id, { id: l.decks.id, name: l.decks.name })
      }
      const intervalByCard = new Map((statesRes.data ?? []).map(s => [s.card_id as string, s.interval_days as number]))

      const toCard = (g: { card_id: unknown; cards: unknown }): LearnedCard => {
        const c = g.cards as unknown as { front: string; back: string; source_language: string } | null
        const deck = deckByCard.get(g.card_id as string)
        return { cardId: g.card_id as string, front: displayText(c?.front ?? ''), back: displayText(c?.back ?? ''), source: c?.source_language ?? '?', deckId: deck?.id ?? null, deckName: deck?.name ?? null }
      }
      // Cards learned (ladder) vs auto-graduated (skipped the ladder)
      const learnedCards: LearnedCard[] = learnedRows.map(toCard)
      const autoCards: AutoCard[] = autoRows.map(g => ({ ...toCard(g), accelerated: (g.accelerated_mode as string) === 'import_known' }))

      // Due Now groups → cards → review sequences
      const gmap = new Map<string, DueGroup>()
      const cardInGroup = new Map<string, DueCard>()
      let reviewMs = 0
      for (const r of reviewRows) {
        const ms = (r.response_ms as number | null) ?? 0
        reviewMs += ms
        const dir = (r.review_direction as string) === 'reverse' ? 'reverse' : 'forward'
        const src = (r.source_language as string | null) ?? '?'
        const tgt = (r.target_language as string | null) ?? '?'
        const gkey = `${src}|${tgt}|${dir}`
        let g = gmap.get(gkey)
        if (!g) { g = { key: gkey, source: src, target: tgt, direction: dir, count: 0, ms: 0, cards: [] }; gmap.set(gkey, g) }
        g.count++; g.ms += ms
        const ckey = `${gkey}|${r.card_id}`
        let dc = cardInGroup.get(ckey)
        if (!dc) {
          const c = cardById.get(r.card_id as string)
          const deck = deckByCard.get(r.card_id as string)
          dc = { cardId: r.card_id as string, front: displayText(c?.front ?? ''), back: displayText(c?.back ?? ''), deckId: deck?.id ?? null, deckName: deck?.name ?? null, reviews: [], intervalDays: intervalByCard.get(r.card_id as string) ?? null }
          cardInGroup.set(ckey, dc)
          g.cards.push(dc)
        }
        dc.reviews.push({ rating: (r.rating as string | null) ?? 'good', wasCorrect: !!r.was_correct })
      }

      let ladderMs = 0
      for (const e of ladRes.data ?? []) { if (onDay(e.created_at as string)) ladderMs += (e.duration_ms as number | null) ?? 0 }

      setLearned(learnedCards)
      setAuto(autoCards)
      setGroups([...gmap.values()].sort((a, b) => b.ms - a.ms))
      setDueMs(reviewMs)
      setTotalMs(reviewMs + ladderMs)
      setLoading(false)
    })()
  }, [viewDate, tz, turnover])

  const learnedLangs = useMemo(() => [...new Set(learned.map(c => c.source))], [learned])
  const shownLearned = langFilter ? learned.filter(c => c.source === langFilter) : learned

  return (
    <div className="fixed inset-0 z-[80] bg-surface-deep flex flex-col">
      <div className="px-4 sm:px-6 py-3 border-b border-line/10 flex items-center justify-between gap-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <button onClick={onClose} className="text-sm text-ink-muted hover:text-ink shrink-0">← Analytics</button>
        <div className="flex items-center gap-2 sm:gap-3">
          <button onClick={() => canPrev && setViewDate(addDays(viewDate, -1))} disabled={!canPrev} className="text-ink-muted hover:text-ink disabled:opacity-25 text-lg px-1">←</button>
          <h2 className="text-sm sm:text-base font-semibold text-ink text-center min-w-[9rem] sm:min-w-[13rem]">{fullDate(viewDate)}</h2>
          <button onClick={() => canNext && setViewDate(addDays(viewDate, 1))} disabled={!canNext} className="text-ink-muted hover:text-ink disabled:opacity-25 text-lg px-1">→</button>
        </div>
        <div className="w-[4.5rem] shrink-0" />
      </div>

      <div className="overflow-y-auto flex-1 px-4 sm:px-6 py-6 max-w-2xl mx-auto w-full space-y-6 pb-[calc(env(safe-area-inset-bottom)+2rem)]">
          {loading ? <p className="text-sm text-ink-faint">Loading…</p> : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg border border-line/10 p-3 text-center">
                  <div className="text-xl font-semibold text-success">{learned.length}</div>
                  <div className="text-xs text-ink-faint mt-0.5">Cards learned</div>
                </div>
                <div className="rounded-lg border border-line/10 p-3 text-center">
                  <div className="text-xl font-semibold text-accent-soft">{auto.length}</div>
                  <div className="text-xs text-ink-faint mt-0.5">Auto-graduated</div>
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

              {/* Due Now reviews — expandable per group */}
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wider">Due Now reviews</h3>
                {groups.length === 0 ? <p className="text-sm text-ink-faint">No Due Now reviews this day.</p> : (
                  <div className="rounded-lg border border-line/10 divide-y divide-line/5">
                    {groups.map(g => {
                      const open = openGroup === g.key
                      return (
                        <div key={g.key}>
                          <button onClick={() => setOpenGroup(open ? null : g.key)} className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-raised/40 transition-colors text-left">
                            <span className="text-ink">
                              {langName(g.source)} → {langName(g.target)}
                              <span className="text-ink-faint text-xs ml-2">{g.direction === 'reverse' ? 'recognition' : 'production'}</span>
                            </span>
                            <span className="text-ink-muted text-xs shrink-0">{g.count} · {fmtDuration(g.ms)} {open ? '▲' : '▼'}</span>
                          </button>
                          {open && (
                            <div className="bg-surface-deep/60 divide-y divide-line/5">
                              {g.cards.map(c => {
                                const right = c.reviews.filter(r => r.wasCorrect).length
                                const inner = (
                                  <div className="px-4 py-2 space-y-1">
                                    <div className="flex items-center justify-between gap-2 text-sm">
                                      <span className="text-ink truncate">{c.front} <span className="text-ink-faint">→ {c.back}</span></span>
                                      {c.deckId && <span className="text-accent-soft text-xs shrink-0">{c.deckName ?? 'deck'} ↗</span>}
                                    </div>
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      {c.reviews.map((r, i) => (
                                        <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded ${RATING_CHIP[r.rating] ?? 'bg-line/10 text-ink-muted'}`}>{r.rating}</span>
                                      ))}
                                      <span className="text-[11px] text-ink-faint ml-1">{right}/{c.reviews.length} right{c.intervalDays != null ? ` · now ${c.intervalDays}d` : ''}</span>
                                    </div>
                                  </div>
                                )
                                return c.deckId
                                  ? <Link key={c.cardId} href={routes.deck(c.deckId, { card: c.cardId })} className="block hover:bg-surface-raised/40 transition-colors">{inner}</Link>
                                  : <div key={c.cardId}>{inner}</div>
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Cards learned — filterable by language, linked to deck */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wider">Cards learned ({shownLearned.length})</h3>
                  {learnedLangs.length > 1 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      <button onClick={() => setLangFilter(null)} className={`text-[11px] px-2 py-0.5 rounded-full ${!langFilter ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}>All</button>
                      {learnedLangs.map(l => (
                        <button key={l} onClick={() => setLangFilter(l)} className={`text-[11px] px-2 py-0.5 rounded-full ${langFilter === l ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}>{langName(l)}</button>
                      ))}
                    </div>
                  )}
                </div>
                {shownLearned.length === 0 ? <p className="text-sm text-ink-faint">No new cards graduated this day.</p> : (
                  <div className="rounded-lg border border-line/10 divide-y divide-line/5">
                    {shownLearned.map(c => {
                      const inner = (
                        <div className="flex items-center gap-3 px-3 py-2 text-sm">
                          <span className="font-medium text-ink truncate max-w-[40%]">{c.front}</span>
                          <span className="text-ink-faint">→</span>
                          <span className="text-ink-muted truncate flex-1">{c.back}</span>
                          {c.deckId && <span className="text-accent-soft text-xs shrink-0">{c.deckName ?? 'deck'} ↗</span>}
                        </div>
                      )
                      return c.deckId
                        ? <Link key={c.cardId} href={routes.deck(c.deckId, { card: c.cardId })} className="block hover:bg-surface-raised/50 transition-colors">{inner}</Link>
                        : <div key={c.cardId}>{inner}</div>
                    })}
                  </div>
                )}
              </div>

              {/* Auto-graduated that day (skipped the ladder) */}
              {auto.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wider">Auto-graduated ({auto.length})</h3>
                  <div className="rounded-lg border border-line/10 divide-y divide-line/5">
                    {auto.map(c => {
                      const inner = (
                        <div className="flex items-center gap-3 px-3 py-2 text-sm">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${c.accelerated ? 'bg-accent/20 text-accent-soft' : 'bg-line/10 text-ink-muted'}`}>{c.accelerated ? 'Accelerated' : 'Auto'}</span>
                          <span className="font-medium text-ink truncate max-w-[35%]">{c.front}</span>
                          <span className="text-ink-faint">→</span>
                          <span className="text-ink-muted truncate flex-1">{c.back}</span>
                          {c.deckId && <span className="text-accent-soft text-xs shrink-0">{c.deckName ?? 'deck'} ↗</span>}
                        </div>
                      )
                      return c.deckId
                        ? <Link key={c.cardId} href={routes.deck(c.deckId, { card: c.cardId })} className="block hover:bg-surface-raised/50 transition-colors">{inner}</Link>
                        : <div key={c.cardId}>{inner}</div>
                    })}
                  </div>
                </div>
              )}
            </>
          )}
      </div>
    </div>
  )
}
