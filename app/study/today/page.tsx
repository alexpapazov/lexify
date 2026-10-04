'use client'

/**
 * /study/today — the "Today" tab (2026-10-04, v1 for critique): one page that answers "what does
 * the scheduler owe me today, and how do I want to clear it?"
 *
 * Layout: a day-progress bar (done vs due, segmented per category), then ONE ROW PER POOL —
 * typed production, self-graded forward, reverse recall, new words — each with a per-launch MODE
 * picker (the Settings → Due Now defaults seed it; the last pick per row is remembered locally),
 * an optional language scope, and a Start button that launches the EXISTING sessions (`?cloze=1`,
 * `routes.express`, ladder pages — nothing new behind the buttons). Restricted modes surface
 * their exclusions on the row ("182 of 195 playable as matching"), and everything no special mode
 * can take aggregates into the dashed "Normal review only" bucket at the bottom. Extras
 * (Practice / Journal — schedule-neutral) sit below the line.
 *
 * Counts come from `deckDuePools` (lib/todayPools.ts), the SAME classification the dashboard's
 * due picker uses; matching eligibility comes from `buildExpressPool`, what the express page
 * actually serves. "Done today" = today's `review_events` (mode 'due'), bucketed by the
 * turnover-aware local day.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildEnabledTracksMap, type EnabledTracks } from '@/lib/sessionLimits'
import { deckDuePools } from '@/lib/todayPools'
import { buildExpressPool } from '@/lib/expressReview'
import { forwardStateMap } from '@/lib/cardStateMap'
import { climbInProgress } from '@/lib/climbProgress'
import { getToday, localDateWithTurnover } from '@/lib/dates'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { langFlag, langName } from '@/lib/languages'
import { routes } from '@/lib/routes'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import type { Card, CardState } from '@/domain'

const MODES_KEY = 'lexify-today-modes'

type ForwardMode = 'normal' | 'cloze'
type ReverseMode = 'normal' | 'matching'
interface RowModes { typed: ForwardMode; sg: ForwardMode; reverse: ReverseMode }

interface PairPools {
  source: string
  target: string
  typing: CardState[]
  sgForward: CardState[]
  reverse: CardState[]
}

/** "All languages" + each pair with cards in this row's pool. */
function ScopeSelect({ pairs, value, onChange, pick }: {
  pairs: PairPools[]
  value: string           // 'all' or 'src|tgt'
  onChange: (v: string) => void
  pick: (p: PairPools) => number
}) {
  const withCards = pairs.filter(p => pick(p) > 0)
  if (withCards.length <= 1) return null
  return (
    <select className="input py-1 text-xs w-auto" value={value} onChange={e => onChange(e.target.value)}>
      <option value="all">All languages</option>
      {withCards.map(p => (
        <option key={`${p.source}|${p.target}`} value={`${p.source}|${p.target}`}>
          {langFlag(p.source)} {langName(p.source)} ({pick(p)})
        </option>
      ))}
    </select>
  )
}

function ModePill({ active, onClick, children, disabled, title }: {
  active: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean; title?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`px-3 py-1.5 text-xs transition-colors ${disabled ? 'text-ink-faint/50 cursor-not-allowed'
        : active ? 'bg-accent/15 text-accent font-medium' : 'text-ink-muted hover:text-ink'}`}>
      {children}
    </button>
  )
}

export default function TodayPage() {
  const offline = useOfflineMode()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [cards, setCards] = useState<Card[]>([])
  const [states, setStates] = useState<CardState[]>([])
  const [pairPools, setPairPools] = useState<PairPools[]>([])
  const [tracksByPair, setTracksByPair] = useState<Map<string, EnabledTracks>>(new Map())
  const [learningByPair, setLearningByPair] = useState<Map<string, number>>(new Map())
  const [done, setDone] = useState({ typed: 0, sg: 0, reverse: 0 })
  const [tzToday, setTzToday] = useState<{ tz: string; today: string }>({ tz: 'UTC', today: '' })

  const [modes, setModes] = useState<RowModes>({ typed: 'normal', sg: 'normal', reverse: 'normal' })
  const [scopes, setScopes] = useState({ typed: 'all', sg: 'all', reverse: 'all' })

  useEffect(() => {
    if (offline) return
    ;(async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.push('/auth'); return }
        const uid = session.user.id

        const [allCards, allStates, climb, paramRows, profileRes, dueModesRes] = await Promise.all([
          new SupabaseCardRepository().listAllForUser(uid),
          new SupabaseCardStateRepository().listAllForUser(uid),
          new SupabaseLadderClimbRepository().listAllForUser(uid).catch(() => new Map()),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
          supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', uid).maybeSingle(),
          // Settings → Due Now defaults seed the pickers (guarded — migration 124 landmine).
          supabase.from('profiles').select('forward_cloze, reverse_matching').eq('user_id', uid).maybeSingle(),
        ])

        const tz = (profileRes.data?.timezone as string | null) ?? deviceTimeZone()
        const turnover = (profileRes.data?.day_turnover_hour as number | null) ?? 0
        const today = getToday(tz, turnover)
        setTzToday({ tz, today })

        const enabledMap = buildEnabledTracksMap(paramRows)
        setTracksByPair(enabledMap)
        const thresholds = new Map<string, number>()
        for (const r of paramRows) {
          if (r.answerField === 'forward_typed') thresholds.set(`${r.sourceLanguage}|${r.targetLanguage}`, r.smartTypingThresholdDays)
        }

        // Group by language pair (enabled tracks + threshold are per pair, so decks don't matter).
        const liveCards = allCards.filter(c => !c.deletedAt)
        const cardsByPair = new Map<string, Card[]>()
        for (const c of liveCards) {
          const key = `${c.sourceLanguage}|${c.targetLanguage}`
          const arr = cardsByPair.get(key)
          if (arr) arr.push(c); else cardsByPair.set(key, [c])
        }
        const statesByCard = new Map<string, CardState[]>()
        for (const s of allStates) {
          const arr = statesByCard.get(s.cardId)
          if (arr) arr.push(s); else statesByCard.set(s.cardId, [s])
        }
        const fwdMap = forwardStateMap(allStates.filter(s => s.reviewDirection !== 'reverse'))

        const pools: PairPools[] = []
        const learning = new Map<string, number>()
        for (const [key, pairCards] of cardsByPair) {
          const [source, target] = key.split('|') as [string, string]
          const pairStates = pairCards.flatMap(c => statesByCard.get(c.id) ?? [])
          const p = deckDuePools({
            states: pairStates, forwardMap: fwdMap, tracks: enabledMap.get(key),
            smartThresholdDays: thresholds.get(key) ?? 20, tz, today,
          })
          if (p.typing.length + p.sgForward.length + p.reverse.length > 0) {
            pools.push({ source, target, ...p })
          }
          const n = pairCards.filter(c => {
            const s = fwdMap.get(c.id)
            return climbInProgress((climb as Map<string, unknown>).get(c.id)) || (!!s && !s.graduated)
          }).length
          if (n > 0) learning.set(key, n)
        }
        pools.sort((a, b) => (b.typing.length + b.sgForward.length + b.reverse.length) - (a.typing.length + a.sgForward.length + a.reverse.length))
        setPairPools(pools)
        setLearningByPair(learning)
        setCards(liveCards)
        setStates(allStates)

        // Done today: due-mode review events bucketed into the turnover-aware local day.
        const since = new Date(Date.now() - 40 * 3600 * 1000).toISOString()
        const { data: events } = await supabase.from('review_events')
          .select('review_direction, was_typed, reviewed_at')
          .eq('user_id', uid).eq('review_mode', 'due').gte('reviewed_at', since)
        let dTyped = 0, dSg = 0, dReverse = 0
        for (const e of (events ?? []) as { review_direction: string | null; was_typed: boolean | null; reviewed_at: string }[]) {
          if (localDateWithTurnover(e.reviewed_at, tz, turnover) !== today) continue
          if (e.review_direction === 'reverse') dReverse++
          else if (e.was_typed) dTyped++
          else dSg++
        }
        setDone({ typed: dTyped, sg: dSg, reverse: dReverse })

        // Mode pickers: last local pick wins; otherwise the Settings → Due Now defaults.
        const dm = dueModesRes.data as { forward_cloze?: boolean | null; reverse_matching?: boolean | null } | null
        const defaults: RowModes = {
          typed: dm?.forward_cloze ? 'cloze' : 'normal',
          sg: dm?.forward_cloze ? 'cloze' : 'normal',
          reverse: dm?.reverse_matching ? 'matching' : 'normal',
        }
        try {
          const stored = JSON.parse(localStorage.getItem(MODES_KEY) ?? 'null') as Partial<RowModes> | null
          setModes({ ...defaults, ...(stored ?? {}) })
        } catch { setModes(defaults) }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [offline, router])

  const setMode = (patch: Partial<RowModes>) => setModes(prev => {
    const next = { ...prev, ...patch }
    try { localStorage.setItem(MODES_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    return next
  })

  const sum = (pick: (p: PairPools) => number, scope: string) =>
    pairPools.filter(p => scope === 'all' || `${p.source}|${p.target}` === scope).reduce((s, p) => s + pick(p), 0)

  const typedDue = sum(p => p.typing.length, 'all')
  const sgDue = sum(p => p.sgForward.length, 'all')
  const reverseDue = sum(p => p.reverse.length, 'all')

  // Matching eligibility for the CURRENT reverse scope — what the express page will actually serve.
  const expressInfo = useMemo(() => {
    const [source, target] = scopes.reverse === 'all' ? [null, null] : (scopes.reverse.split('|') as [string, string])
    const { pool, skippedAmbiguous } = buildExpressPool(cards, states, { source, target, tracksByPair, tz: tzToday.tz, today: tzToday.today })
    const scoped = pairPools.filter(p => scopes.reverse === 'all' || `${p.source}|${p.target}` === scopes.reverse)
    const relearn = scoped.reduce((n, p) => n + p.reverse.filter(s => s.relearning || s.relearningStep > 0).length, 0)
    return { playable: pool.length, duplicates: skippedAmbiguous, relearn }
  }, [cards, states, tracksByPair, tzToday, scopes.reverse, pairPools])

  const lockedCount = useMemo(() => {
    const { skippedAmbiguous } = buildExpressPool(cards, states, { source: null, target: null, tracksByPair, tz: tzToday.tz, today: tzToday.today })
    const relearnAll = pairPools.reduce((n, p) => n + p.reverse.filter(s => s.relearning || s.relearningStep > 0).length, 0)
    return skippedAmbiguous + relearnAll
  }, [cards, states, tracksByPair, tzToday, pairPools])

  const doneTotal = done.typed + done.sg + done.reverse
  const grandTotal = typedDue + sgDue + reverseDue + doneTotal
  const pct = (n: number) => grandTotal > 0 ? (n / grandTotal) * 100 : 0

  const pairQuery = (scope: string) => scope === 'all' ? '' : `&source=${scope.split('|')[0]}&target=${scope.split('|')[1]}`
  const launchForward = (present: 'typing' | 'selfgraded', scope: string, mode: ForwardMode) => {
    const dir = present === 'selfgraded' ? '&dir=forward' : ''
    router.push(`/study/all/session?category=due&present=${present}${dir}${pairQuery(scope)}${mode === 'cloze' ? '&cloze=1' : ''}`)
  }
  const launchReverse = (scope: string, mode: ReverseMode) => {
    if (mode === 'matching') {
      const [source, target] = scope === 'all' ? [undefined, undefined] : scope.split('|')
      router.push(routes.express(source && target ? { source, target } : {}))
    } else {
      router.push(`/study/all/session?category=due&present=selfgraded&dir=reverse${pairQuery(scope)}`)
    }
  }

  if (offline) return <OfflineUnavailable feature="Today" />
  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading today…</div>

  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const learningTotal = [...learningByPair.values()].reduce((a, b) => a + b, 0)

  const rowShell = 'panel space-y-3'
  const pillGroup = 'flex rounded-lg border border-line/15 overflow-hidden'

  return (
    <div className="space-y-5 max-w-2xl mx-auto pb-12">
      {/* ── Header + day progress ── */}
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Today</h1>
          <p className="text-sm text-ink-muted mt-1">{dateLabel} · {typedDue + sgDue + reverseDue} reviews due{learningTotal > 0 ? ` · ${learningTotal} words mid-climb` : ''}</p>
        </div>
        <span className="text-sm text-ink-muted shrink-0">{doneTotal} / {grandTotal} done</span>
      </div>
      <div>
        <div className="h-2.5 rounded-full bg-surface-raised overflow-hidden flex">
          <div className="h-full bg-accent" style={{ width: `${pct(done.typed)}%` }} />
          <div className="h-full bg-accent/50" style={{ width: `${pct(done.sg)}%` }} />
          <div className="h-full bg-success/80" style={{ width: `${pct(done.reverse)}%` }} />
        </div>
        <div className="flex gap-4 text-[11px] text-ink-faint mt-1.5 flex-wrap">
          <span><span className="inline-block w-2 h-2 rounded-sm bg-accent mr-1" />Typed {done.typed}</span>
          <span><span className="inline-block w-2 h-2 rounded-sm bg-accent/50 mr-1" />Self-graded {done.sg}</span>
          <span><span className="inline-block w-2 h-2 rounded-sm bg-success/80 mr-1" />Reverse {done.reverse}</span>
          <span className="ml-auto">{grandTotal > 0 ? Math.round((doneTotal / grandTotal) * 100) : 0}% of today</span>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

      {/* ── Typed production ── */}
      <div className={rowShell}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-ink">Typed production <span className="text-xs text-ink-faint font-normal">· native → target</span></p>
            <p className="text-xs text-ink-muted mt-0.5">
              {typedDue} due{typedDue > 0 && <> · {pairPools.filter(p => p.typing.length > 0).map(p => `${langFlag(p.source)} ${p.typing.length}`).join(' · ')}</>}
            </p>
          </div>
          {done.typed > 0 && <span className="chip text-xs shrink-0">{done.typed} done</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={pillGroup}>
            <ModePill active={modes.typed === 'normal'} onClick={() => setMode({ typed: 'normal' })}>Normal</ModePill>
            <ModePill active={modes.typed === 'cloze'} onClick={() => setMode({ typed: 'cloze' })}>📝 Cloze</ModePill>
          </div>
          <ScopeSelect pairs={pairPools} value={scopes.typed} onChange={v => setScopes(s => ({ ...s, typed: v }))} pick={p => p.typing.length} />
          <button className="btn-primary text-sm px-5 ml-auto disabled:opacity-40" disabled={sum(p => p.typing.length, scopes.typed) === 0}
            onClick={() => launchForward('typing', scopes.typed, modes.typed)}>Start →</button>
        </div>
      </div>

      {/* ── Self-graded forward ── */}
      <div className={rowShell}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-ink">Self-graded <span className="text-xs text-ink-faint font-normal">· native → target</span></p>
            <p className="text-xs text-ink-muted mt-0.5">
              {sgDue} due{sgDue > 0 && <> · {pairPools.filter(p => p.sgForward.length > 0).map(p => `${langFlag(p.source)} ${p.sgForward.length}`).join(' · ')}</>}
            </p>
          </div>
          {done.sg > 0 && <span className="chip text-xs shrink-0">{done.sg} done</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={pillGroup}>
            <ModePill active={modes.sg === 'normal'} onClick={() => setMode({ sg: 'normal' })}>Normal</ModePill>
            <ModePill active={modes.sg === 'cloze'} onClick={() => setMode({ sg: 'cloze' })}>📝 Cloze</ModePill>
          </div>
          <ScopeSelect pairs={pairPools} value={scopes.sg} onChange={v => setScopes(s => ({ ...s, sg: v }))} pick={p => p.sgForward.length} />
          <button className="btn-primary text-sm px-5 ml-auto disabled:opacity-40" disabled={sum(p => p.sgForward.length, scopes.sg) === 0}
            onClick={() => launchForward('selfgraded', scopes.sg, modes.sg)}>Start →</button>
        </div>
      </div>

      {/* ── Reverse recall ── */}
      <div className={rowShell}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-ink">Reverse recall <span className="text-xs text-ink-faint font-normal">· target → native</span></p>
            <p className="text-xs text-ink-muted mt-0.5">
              {reverseDue} due{reverseDue > 0 && <> · {pairPools.filter(p => p.reverse.length > 0).map(p => `${langFlag(p.source)} ${p.reverse.length}`).join(' · ')}</>}
            </p>
          </div>
          {done.reverse > 0 && <span className="chip text-xs shrink-0">{done.reverse} done</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={pillGroup}>
            <ModePill active={modes.reverse === 'normal'} onClick={() => setMode({ reverse: 'normal' })}>Normal</ModePill>
            <ModePill active={modes.reverse === 'matching'} onClick={() => setMode({ reverse: 'matching' })}>⚡ Matching</ModePill>
            <ModePill active={false} disabled onClick={() => {}} title="Planned — stories woven from your due words">📖 Story</ModePill>
          </div>
          <ScopeSelect pairs={pairPools} value={scopes.reverse} onChange={v => setScopes(s => ({ ...s, reverse: v }))} pick={p => p.reverse.length} />
          <button className="btn-primary text-sm px-5 ml-auto disabled:opacity-40" disabled={sum(p => p.reverse.length, scopes.reverse) === 0}
            onClick={() => launchReverse(scopes.reverse, modes.reverse)}>Start →</button>
        </div>
        {modes.reverse === 'matching' && sum(p => p.reverse.length, scopes.reverse) > 0 && (
          <p className="text-[11px] text-ink-faint">
            {expressInfo.playable} of {sum(p => p.reverse.length, scopes.reverse)} playable as matching
            {expressInfo.relearn + expressInfo.duplicates > 0 && <> — {expressInfo.relearn + expressInfo.duplicates} need a normal review
              {' '}({[expressInfo.relearn > 0 ? `${expressInfo.relearn} relearning` : null, expressInfo.duplicates > 0 ? `${expressInfo.duplicates} duplicate meanings` : null].filter(Boolean).join(', ')})</>}
          </p>
        )}
      </div>

      {/* ── New words ── */}
      <div className={rowShell}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-ink">New words <span className="text-xs text-ink-faint font-normal">· ladder / pathway</span></p>
            <p className="text-xs text-ink-muted mt-0.5">
              {learningTotal > 0 ? `${learningTotal} mid-climb` : 'Nothing mid-climb — start fresh words from a deck'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {[...learningByPair.entries()].map(([key, n]) => {
            const [source, target] = key.split('|') as [string, string]
            return (
              <Link key={key} href={`/study/ladder/all?source=${source}&target=${target}`}
                className="text-xs px-3 py-1.5 rounded-lg border border-line/15 text-ink-muted hover:text-ink hover:border-line/30 transition-colors">
                {langFlag(source)} Learn {langName(source)} ({n})
              </Link>
            )
          })}
          {learningByPair.size === 0 && <Link href="/library" className="btn-ghost text-sm">Open Library</Link>}
        </div>
      </div>

      {/* ── Normal-review-only bucket ── */}
      {lockedCount > 0 && (
        <div className="rounded-card border border-dashed border-line/25 px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-ink-muted">Normal review only — {lockedCount} card{lockedCount === 1 ? '' : 's'}</p>
            <p className="text-xs text-ink-faint mt-0.5">Relearning and duplicate-meaning cards that matching can't take — they're included in any normal reverse session.</p>
          </div>
          <button className="btn-ghost text-sm shrink-0" onClick={() => launchReverse('all', 'normal')}>Review</button>
        </div>
      )}

      {/* ── Extras ── */}
      <div>
        <p className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold mb-2">Extras — never touch your schedule</p>
        <div className="grid grid-cols-2 gap-2.5">
          <Link href="/practice" className="panel py-2.5 px-3.5 text-sm text-ink-muted hover:text-ink transition-colors">🎯 Practice</Link>
          <Link href="/study/journal" className="panel py-2.5 px-3.5 text-sm text-ink-muted hover:text-ink transition-colors">✍️ Journal</Link>
        </div>
      </div>
    </div>
  )
}
