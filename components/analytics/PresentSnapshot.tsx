'use client'

/**
 * PresentSnapshot — the "Present" tab of Analytics: today at a glance.
 *   1. The five card-status counters (Unlearned / Learning / Graduated / Due Now / Dormant), each
 *      clickable to reveal the cards in that bucket across all decks.
 *   2. Today's per-language goal progress (mirrors the Study dashboard).
 *   3. Time tracking — time spent on Lexify today, and a projected time-to-finish split into clearing
 *      today's Due Now reviews and learning the remaining new-word goal.
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildEnabledTracksMap, trackEnabled } from '@/lib/sessionLimits'
import { getToday, localDateWithTurnover } from '@/lib/dates'
import { langName } from '@/lib/languages'
import { routes } from '@/lib/routes'
import type { Card, Deck, LanguagePair } from '@/domain'

type Category = 'new' | 'learning' | 'graduated' | 'due' | 'dormant'
interface CardEntry { card: Card; deckId: string; deckName: string; source: string; target: string }

const DAY_MS = 86_400_000
const DEFAULT_DUE_MS = 8_000     // fallback per-review time if we have no timing history
const DEFAULT_LEARN_MS = 90_000  // fallback per-new-card learning time

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
function fmtDuration(ms: number): string {
  if (ms <= 0) return '—'
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 1) return '<1 min'
  const h = Math.floor(totalMin / 60), m = totalMin % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m} min`
}

interface Data {
  lists: Record<Category, CardEntry[]>
  counts: Record<Category, number>
  goals: { key: string; label: string; goal: number; done: number }[]
  timeTodayMs: number
  projDueMs: number
  projNewMs: number
  remainingNew: number
}

export function PresentSnapshot() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<Category | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())  // `${deckId}:${cardId}`
  const [langFilter, setLangFilter] = useState<string | null>(null) // `${source}|${target}`
  const [copied, setCopied] = useState(false)

  function openCategory(key: Category) {
    setActive(prev => prev === key ? null : key)
    setSelected(new Set()); setLangFilter(null); setCopied(false)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setError('Not signed in'); return }
        const uid = session.user.id

        const { data: profile } = await supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', uid).single()
        const tz = (profile?.timezone as string | null) ?? 'UTC'
        const turnover = (profile?.day_turnover_hour as number | null) ?? 0
        const today = getToday(tz, turnover)
        const todayWeekday = new Date(today + 'T12:00:00Z').getUTCDay()
        const now = Date.now()

        const [decks, pairs, paramRows] = await Promise.all([
          new SupabaseDeckRepository().list(uid),
          new SupabaseLanguagePairRepository().list(uid),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
        ])
        const deckById = new Map(decks.map(d => [d.id, d]))
        const enabledMap = buildEnabledTracksMap(paramRows)   // for track-aware Due Now (matches the dashboard)
        const isDue = (dateStr: string | null | undefined) => !!dateStr && new Date(dateStr).toLocaleDateString('en-CA', { timeZone: tz }) <= today

        // Per-deck cards + states + climb → status buckets.
        const cardRepo = new SupabaseCardRepository()
        const stateRepo = new SupabaseCardStateRepository()
        const climbRepo = new SupabaseLadderClimbRepository()
        const lists: Record<Category, CardEntry[]> = { new: [], learning: [], graduated: [], due: [], dormant: [] }

        await Promise.all(decks.map(async (deck: Deck) => {
          const [cards, states] = await Promise.all([cardRepo.listByDeck(deck.id), stateRepo.listByDeck(uid, deck.id)])
          const climb = await climbRepo.listForCards(uid, cards.map(c => c.id)).catch(() => new Map())
          const fwd = states.filter(s => s.reviewDirection !== 'reverse')
          const stateMap = new Map(fwd.map(s => [s.cardId, s]))
          const en = enabledMap.get(`${deck.sourceLanguage}|${deck.targetLanguage}`)
          // Track-aware Due Now — a card due only on a DISABLED track doesn't count (mirrors the dashboard).
          const prodEnabled = trackEnabled(en, 'typed', false) || trackEnabled(en, 'smart', false)
          const prodDue   = (s: typeof states[number]) => !s.dormant && prodEnabled && (s.smartDueAt ? isDue(s.smartDueAt) : s.typedDueAt ? isDue(s.typedDueAt) : isDue(s.dueAt))
          const recallDue = (s: typeof states[number]) => !s.dormant && trackEnabled(en, 'recall', false) && isDue(s.recallDueAt)
          const reverseDue = (r: typeof states[number]) => trackEnabled(en, 'recall', true) && stateMap.get(r.cardId)?.graduated === true
            && !stateMap.get(r.cardId)?.dormant && !r.dormant && isDue(r.recallDueAt ?? r.dueAt)
          const entry = (card: Card): CardEntry => ({ card, deckId: deck.id, deckName: deck.name, source: deck.sourceLanguage, target: deck.targetLanguage })
          for (const card of cards) {
            const s = stateMap.get(card.id)
            const cl = climb.get(card.id)
            if (s?.dormant) { lists.dormant.push(entry(card)); continue }
            if (s?.graduated) {
              lists.graduated.push(entry(card))
              const due = prodDue(s) || recallDue(s)
                || states.some(r => r.cardId === card.id && r.reviewDirection === 'reverse' && reverseDue(r))
              if (due) lists.due.push(entry(card))
              continue
            }
            if ((cl && cl.rungIndex >= 1 && !cl.graduated) || (s && !s.graduated && (s.reps > 0 || s.currentStepOrder > 0))) lists.learning.push(entry(card))
            else lists.new.push(entry(card))
          }
        }))
        const counts = { new: lists.new.length, learning: lists.learning.length, graduated: lists.graduated.length, due: lists.due.length, dormant: lists.dormant.length }

        // ── Today's goals + how many new words graduated today (per pair) ──
        const since14 = new Date(now - 14 * DAY_MS).toISOString()
        const [gradsRes, ladderRes, dueRes] = await Promise.all([
          supabase.from('card_states').select('graduated_at, accelerated_mode, cards(source_language, target_language)')
            .eq('user_id', uid).eq('graduated', true).neq('review_direction', 'reverse').not('graduated_at', 'is', null).gte('graduated_at', since14),
          supabase.from('ladder_events').select('created_at, duration_ms').eq('user_id', uid).gte('created_at', since14),
          supabase.from('review_events').select('reviewed_at, response_ms').eq('user_id', uid).eq('review_mode', 'due').gte('reviewed_at', since14).order('reviewed_at', { ascending: false }).limit(600),
        ])

        const gradToday = new Map<string, number>()
        let grad14 = 0
        for (const row of (gradsRes.data ?? [])) {
          const r = row as unknown as { graduated_at: string; accelerated_mode: string | null; cards: { source_language: string; target_language: string } | null }
          if (!r.graduated_at || !r.cards) continue
          if (r.accelerated_mode === 'import_known' || r.accelerated_mode === 'bulk_known') continue
          grad14++
          if (localDateWithTurnover(r.graduated_at, tz, turnover) !== today) continue
          const key = `${r.cards.source_language}|${r.cards.target_language}`
          gradToday.set(key, (gradToday.get(key) ?? 0) + 1)
        }

        const goals = pairs
          .map((p: LanguagePair) => {
            const key = `${p.sourceLanguage}|${p.targetLanguage}`
            const goal = (p.goals?.[String(todayWeekday)] as number | undefined) ?? 0
            return { key, label: `${langName(p.sourceLanguage)} → ${langName(p.targetLanguage)}`, goal, done: gradToday.get(key) ?? 0 }
          })
          .filter(g => g.goal > 0)
        const remainingNew = goals.reduce((sum, g) => sum + Math.max(0, g.goal - g.done), 0)

        // ── Time today + projections ──
        let ladderTodayMs = 0, ladder14Ms = 0
        for (const e of (ladderRes.data ?? [])) {
          const ms = (e.duration_ms as number | null) ?? 0
          ladder14Ms += ms
          if (localDateWithTurnover(e.created_at as string, tz, turnover) === today) ladderTodayMs += ms
        }
        let dueTodayMs = 0
        const dueSamples: number[] = []
        for (const e of (dueRes.data ?? [])) {
          const ms = (e.response_ms as number | null) ?? 0
          if (ms > 0) dueSamples.push(ms)
          if (localDateWithTurnover(e.reviewed_at as string, tz, turnover) === today) dueTodayMs += ms
        }
        const avgDueMs = median(dueSamples) ?? DEFAULT_DUE_MS
        const avgLearnMs = grad14 > 0 && ladder14Ms > 0 ? ladder14Ms / grad14 : DEFAULT_LEARN_MS

        if (!cancelled) setData({
          lists, counts, goals,
          timeTodayMs: ladderTodayMs + dueTodayMs,
          projDueMs: counts.due * avgDueMs,
          projNewMs: remainingNew * avgLearnMs,
          remainingNew,
        })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  const CATS = useMemo(() => ([
    { key: 'new'       as Category, label: 'Unlearned', color: 'text-ink-muted',   border: 'border-ink-faint', desc: 'Not yet started'  },
    { key: 'learning'  as Category, label: 'Learning',  color: 'text-warning',     border: 'border-warning',   desc: 'In pipeline'      },
    { key: 'graduated' as Category, label: 'Graduated', color: 'text-success',     border: 'border-success',   desc: 'Long-term review' },
    { key: 'due'       as Category, label: 'Due Now',   color: 'text-accent-soft', border: 'border-accent',    desc: 'Ready to review'  },
    { key: 'dormant'   as Category, label: 'Dormant',   color: 'text-ink',         border: 'border-line/70',   desc: 'Paused — manual'  },
  ]), [])

  if (error) return <p className="text-sm text-danger">Couldn&apos;t load: {error}</p>
  if (!data) return <p className="text-sm text-ink-faint">Loading today…</p>

  const list = active ? data.lists[active] : []
  const keyOf = (e: CardEntry) => `${e.deckId}:${e.card.id}`
  const pairKeys = [...new Set(list.map(e => `${e.source}|${e.target}`))]
  const shown = langFilter ? list.filter(e => `${e.source}|${e.target}` === langFilter) : list
  const allShownSelected = shown.length > 0 && shown.every(e => selected.has(keyOf(e)))
  const selectedCount = list.filter(e => selected.has(keyOf(e))).length

  const toggleOne = (e: CardEntry) => setSelected(prev => {
    const n = new Set(prev); const k = keyOf(e); n.has(k) ? n.delete(k) : n.add(k); return n
  })
  const toggleSelectAll = () => setSelected(prev => {
    const n = new Set(prev)
    if (allShownSelected) shown.forEach(e => n.delete(keyOf(e)))
    else shown.forEach(e => n.add(keyOf(e)))
    return n
  })
  const copySelected = () => {
    const chosen = list.filter(e => selected.has(keyOf(e)))
    const text = chosen.map(e => `${e.card.front}\t${e.card.back}`).join('\n')
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }

  return (
    <div className="space-y-6">
      {/* 1. Card counters — clickable */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {CATS.map(({ key, label, color, border, desc }) => {
          const isActive = active === key
          return (
            <button key={key} onClick={() => openCategory(key)}
              className={`panel border-t-2 ${border} space-y-1 text-center w-full transition-colors ${isActive ? 'bg-surface-raised ring-1 ring-ink/10' : 'hover:bg-surface-raised/50'}`}>
              <div className={`text-2xl font-semibold ${color}`}>{data.counts[key]}</div>
              <div className="text-xs font-medium text-ink">{label}</div>
              <div className="text-xs text-ink-faint">{desc}</div>
            </button>
          )
        })}
      </div>

      {active && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-medium text-ink-muted uppercase tracking-wider">
              {CATS.find(c => c.key === active)?.label} — {shown.length} card{shown.length !== 1 ? 's' : ''}
            </h3>
            <div className="flex items-center gap-3 text-xs">
              <button onClick={toggleSelectAll} className="text-ink-muted hover:text-ink">{allShownSelected ? 'Deselect all' : 'Select all'}</button>
              <button onClick={copySelected} disabled={selectedCount === 0} className="text-accent hover:text-accent-soft disabled:opacity-40">
                {copied ? 'Copied ✓' : `Copy${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
              </button>
              <button onClick={() => setActive(null)} className="text-accent hover:text-accent-soft">Close ✕</button>
            </div>
          </div>

          {/* Language filter */}
          {pairKeys.length > 1 && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              <button onClick={() => setLangFilter(null)}
                className={`px-2 py-0.5 rounded-full border ${langFilter === null ? 'bg-accent/20 border-accent text-ink' : 'border-line/15 text-ink-muted hover:text-ink'}`}>All</button>
              {pairKeys.map(pk => { const [s, t] = pk.split('|'); return (
                <button key={pk} onClick={() => setLangFilter(pk)}
                  className={`px-2 py-0.5 rounded-full border ${langFilter === pk ? 'bg-accent/20 border-accent text-ink' : 'border-line/15 text-ink-muted hover:text-ink'}`}>
                  {langName(s!)} → {langName(t!)}
                </button>
              )})}
            </div>
          )}

          {shown.length === 0 ? (
            <div className="panel text-ink-muted text-sm text-center py-6">No cards in this category.</div>
          ) : (
            <div className="panel divide-y divide-line/5 p-0 overflow-hidden max-h-96 overflow-y-auto">
              {shown.map(e => (
                <div key={keyOf(e)} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-raised/50 transition-colors">
                  <input type="checkbox" className="accent-accent shrink-0 w-4 h-4" checked={selected.has(keyOf(e))} onChange={() => toggleOne(e)} />
                  <Link href={routes.deck(e.deckId, { card: e.card.id })} className="flex items-center justify-between gap-4 min-w-0 flex-1">
                    <div className="flex gap-6 text-sm min-w-0">
                      <span className="text-ink font-medium w-36 truncate shrink-0">{e.card.front}</span>
                      <span className="text-ink-muted truncate">{e.card.back}</span>
                    </div>
                    <span className="text-xs text-ink-faint hidden sm:block shrink-0 ml-2">{langName(e.source)} → {langName(e.target)} · {e.deckName}</span>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 2. Today's goals */}
      {data.goals.length > 0 && (
        <div className="panel space-y-3">
          <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Today&apos;s goals</h2>
          {data.goals.map(g => {
            const pct = Math.min(100, Math.round((g.done / g.goal) * 100))
            const done = g.done >= g.goal
            return (
              <div key={g.key} className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink">{g.label}</span>
                  <span className={done ? 'text-success font-medium' : 'text-ink-muted'}>{g.done}/{g.goal}{done ? ' ✓' : ''}</span>
                </div>
                <div className="h-1.5 rounded-full bg-line/10 overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${done ? 'bg-success' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 3. Time tracking */}
      <div className="panel space-y-4">
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Time today</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-ink">{fmtDuration(data.timeTodayMs)}</span>
          <span className="text-xs text-ink-faint">spent on Lexify so far today</span>
        </div>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div className="rounded-lg border border-line/10 p-3">
            <div className="text-lg font-semibold text-accent-soft">{data.counts.due === 0 ? '0 min' : `~${fmtDuration(data.projDueMs)}`}</div>
            <div className="text-xs text-ink-faint mt-0.5">{data.counts.due === 0 ? 'Due Now reviews all done today ✓' : "to clear today's Due Now reviews"}</div>
          </div>
          <div className="rounded-lg border border-line/10 p-3">
            <div className="text-lg font-semibold text-warning">{data.remainingNew === 0 ? '0 min' : `~${fmtDuration(data.projNewMs)}`}</div>
            <div className="text-xs text-ink-faint mt-0.5">{data.remainingNew === 0 ? "Today's new-word goals met ✓" : `to learn ${data.remainingNew} new word${data.remainingNew === 1 ? '' : 's'} toward today's goals`}</div>
          </div>
        </div>
        <p className="text-[11px] text-ink-faint">Projections use your recent pace — median time per Due Now review and average time to learn a new word over the last 14 days.</p>
      </div>
    </div>
  )
}
