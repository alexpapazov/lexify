'use client'

/**
 * components/settings/CatchUpPanel.tsx — "you're 1,693 behind" turned into a schedule.
 *
 * A sibling of Redistribute, and the same KIND of thing: a one-shot action that rewrites due dates.
 * Pick a language (or one card type within it) and a date to be level again by, and the overdue cards
 * are dealt out across the days between — highest deferral damage first, relearning paced evenly.
 *
 * ── Why it moves real due dates ───────────────────────────────────────────────
 * Because a plan that only capped the session queue would leave every OTHER surface still shouting
 * 1,693 — the "Coming up" chart, the deck counts, the Study all due button. Moving the dates makes
 * all of them honest for free.
 *
 * It is safe to do precisely because these dates are already in the PAST. FSRS measures elapsed time
 * from `lastReviewedAt`, never from `dueAt` (`engine/dueNow.ts`), so difficulty and stability are
 * untouched and each review is scored exactly as it would have been. Future due dates are never
 * moved — those encode an interval the scheduler actually chose.
 *
 * ── Nothing is stored ─────────────────────────────────────────────────────────
 * There is no plan record and no migration. The new due dates ARE the plan. Fall behind again and you
 * run it again, exactly like Redistribute.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildEnabledTracksMap, buildRetentionMap, retentionFor } from '@/lib/sessionLimits'
import { buildCatchUpPools, emptyPool, rescheduleOverdueTracks, candidateKey } from '@/lib/catchUpPools'
import { assignBacklogDays, previewCatchUp, isLapsed, scopeKey, scopeDirection, addDays, daysBetween, type CatchUpType, type CatchUpCandidate } from '@/lib/catchUp'
import { buildPaceSamples, pace, type PaceSamples, type PaceRow } from '@/lib/reviewPace'
import { isDueByLocalDate } from '@/lib/dueStatus'
import { chunk } from '@/lib/mapLimit'
import { getToday } from '@/lib/dates'
import { langName } from '@/lib/languages'
import type { CardState, Deck } from '@/domain'

const PRESET_DAYS = [3, 7, 14, 30]

// These label the card-type filter, which spans languages, so they use the app's abstract direction
// vocabulary (matching the "Study all due" popover's hints) rather than naming languages. When a
// single language IS selected the heading resolves this into a concrete arrow via `scopeDirection`,
// which is the only place a language name and an arrow appear together.
const TYPE_LABEL: Record<CatchUpType, string> = {
  typing:    'Typing',
  sgForward: 'Self-graded · native → target',
  sgReverse: 'Self-graded · target → native',
}

/**
 * One overdue review, tagged with everything the filters slice on. A FLAT list rather than a tree of
 * scopes: the two filters are independent, so "all my typing cards across every language" has to be
 * as expressible as "everything Bulgarian" or one specific combination of the two. Grouping the data
 * by language up front is what made card type silently language-scoped before.
 */
interface Entry {
  pairKey:   string
  source:    string
  target:    string
  type:      CatchUpType
  candidate: CatchUpCandidate
  /** Measured seconds-per-review for this exact bucket, for the minutes estimate. */
  msPerReview: number
}

const ALL = 'all' as const
type LangFilter = typeof ALL | string
type TypeFilter = typeof ALL | CatchUpType

const TYPES: CatchUpType[] = ['typing', 'sgForward', 'sgReverse']

function fmtMinutes(mins: number): string {
  if (mins < 60) return `~${Math.round(mins)} min`
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m === 0 ? `~${h} hr` : `~${h} hr ${m} min`
}

/**
 * Defined at module scope, not inside the panel. A component declared inside a render is a NEW
 * component type on every render, so React unmounts and remounts its whole subtree each keystroke.
 */
function Pill({ active, count, disabled, children, onClick }: {
  active:    boolean
  count:     number
  disabled:  boolean
  children:  React.ReactNode
  onClick:   () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-xs px-3 py-1.5 rounded-full border transition-colors disabled:opacity-50 ${
        active
          ? 'border-accent/50 bg-accent/15 text-accent'
          : 'border-line/15 text-ink-faint hover:text-ink hover:border-line/30'
      }`}
    >
      {children}
      <span className="ml-1.5 opacity-70">{count.toLocaleString()}</span>
    </button>
  )
}

export default function CatchUpPanel({ userId, timezone, turnoverHour }: {
  userId:       string
  timezone:     string
  turnoverHour: number
}) {
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<Entry[]>([])
  const [langs,   setLangs]   = useState<Array<{ pairKey: string; label: string }>>([])
  const [lang,    setLang]    = useState<LangFilter>(ALL)
  const [type,    setType]    = useState<TypeFilter>(ALL)
  const [picking, setPicking] = useState(false)
  const [custom,  setCustom]  = useState('')
  const [busy,    setBusy]    = useState(false)
  const [msg,     setMsg]     = useState<{ ok: boolean; text: string } | null>(null)

  /** Everything the panel needs, kept so the write can patch rows without re-fetching. */
  const [ctx, setCtx] = useState<{
    statesByKey:  Map<string, CardState>
    forwardByCard: Map<string, CardState>
    deckPair:     Map<string, string>
    tracks:       ReturnType<typeof buildEnabledTracksMap>
    inflow:       Map<string, number>
    today:        string
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const today = getToday(timezone, turnoverHour)
      const [decks, states, paramRows] = await Promise.all([
        new SupabaseDeckRepository().list(userId),
        new SupabaseCardStateRepository().listAllForUser(userId),
        new SupabaseUserSchedulerParamsRepository().listForUser(userId),
      ])
      const supabase = createClient()
      const paceRows = await supabase
        .from('review_events')
        .select('response_ms, reviewed_at, source_language, target_language, review_direction, was_typed')
        .eq('user_id', userId)
        .not('response_ms', 'is', null)
        .order('reviewed_at', { ascending: false })
        .limit(1000)
        .then((r: { data: PaceRow[] | null }) => r.data ?? [], () => [] as PaceRow[])
      const paceSamples: PaceSamples = buildPaceSamples(paceRows, Date.now())

      const tracks    = buildEnabledTracksMap(paramRows)
      const retention = buildRetentionMap(paramRows)
      const thresholdByPair = new Map(paramRows
        .filter(r => r.answerField === 'forward_typed')
        .map(r => [`${r.sourceLanguage}|${r.targetLanguage}`, r.smartTypingThresholdDays ?? 20] as const))

      // A card's pair comes from its deck; states carry no language of their own.
      const deckIdByCard = await new SupabaseCardRepository().deckIdsByCard(decks.map((d: Deck) => d.id))
      const deckPairById = new Map(decks.map((d: Deck) => [d.id, `${d.sourceLanguage}|${d.targetLanguage}`]))
      const deckPair = new Map<string, string>()
      for (const [cardId, deckId] of deckIdByCard) {
        const pair = deckPairById.get(deckId)
        if (pair) deckPair.set(cardId, pair)
      }

      const forwardByCard = new Map<string, CardState>()
      const statesByKey   = new Map<string, CardState>()
      for (const st of states) {
        statesByKey.set(candidateKey(st), st)
        if (st.reviewDirection !== 'reverse') forwardByCard.set(st.cardId, st)
      }

      const rows = states
        .map(state => ({ pairKey: deckPair.get(state.cardId) ?? '', state }))
        .filter(r => r.pairKey !== '')

      const retentionByPair = new Map([...deckPairById.values()].map(pk => {
        const [src, tgt] = pk.split('|') as [string, string]
        return [pk, retentionFor(retention, src, tgt, 'forward_typed')] as const
      }))

      const pools = buildCatchUpPools({
        rows, forwardByCard, tracksByPair: tracks, thresholdByPair, retentionByPair,
        tz: timezone, today, now: Date.now(),
      })

      // Already-scheduled arrivals per day, so the spread levels against them instead of piling on.
      const inflow = new Map<string, number>()
      for (const st of states) {
        if (!st.graduated || st.dormant) continue
        for (const d of [st.smartDueAt ?? st.typedDueAt ?? st.dueAt, st.recallDueAt]) {
          if (!d || isDueByLocalDate(d, timezone, today)) continue    // past-due is backlog, not load
          const day = new Date(d).toLocaleDateString('en-CA', { timeZone: timezone })
          inflow.set(day, (inflow.get(day) ?? 0) + 1)
        }
      }

      const pairKeys = [...new Set([...deckPairById.values()])]
      // Disambiguate only when two pairs share a learned language (es|en and es|fr), so the common
      // case stays a plain "Spanish".
      const sourceCounts = new Map<string, number>()
      for (const pk of pairKeys) {
        const src = pk.split('|')[0]!
        sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1)
      }

      const nextEntries: Entry[] = []
      for (const pairKey of pairKeys) {
        const [source, target] = pairKey.split('|') as [string, string]
        for (const t of TYPES) {
          const pool = pools.get(scopeKey(pairKey, t)) ?? emptyPool()
          if (pool.overdue.length === 0) continue
          const msPerReview = pace(
            paceSamples, source, target,
            t === 'sgReverse' ? 'reverse' : 'forward',
            t === 'typing',
          )
          for (const candidate of pool.overdue) {
            nextEntries.push({ pairKey, source, target, type: t, candidate, msPerReview })
          }
        }
      }
      setEntries(nextEntries)
      setLangs(pairKeys
        .filter(pk => nextEntries.some(e => e.pairKey === pk))
        .map(pk => {
          const [src, tgt] = pk.split('|') as [string, string]
          return {
            pairKey: pk,
            label: (sourceCounts.get(src) ?? 0) > 1
              ? `${langName(src)} (${langName(tgt)})`
              : langName(src),
          }
        })
        .sort((a, b) => a.label.localeCompare(b.label)))
      setCtx({ statesByKey, forwardByCard, deckPair, tracks, inflow, today })
    } catch (err) {
      console.error('Catch-up load failed:', err)
      setMsg({ ok: false, text: 'Could not read your backlog. Please try again.' })
    } finally {
      setLoading(false)
    }
  }, [userId, timezone, turnoverHour])

  useEffect(() => { void load() }, [load])

  // ── The selection ───────────────────────────────────────────────────────────
  // Both filters are independent and either may be "all", so a selection is just a predicate over
  // the flat entry list. That is what makes language-only, type-only and both-at-once all reachable.
  const selected = useMemo(
    () => entries.filter(e => (lang === ALL || e.pairKey === lang) && (type === ALL || e.type === type)),
    [entries, lang, type],
  )

  /** Facet counts: each filter is counted with the OTHER filter applied, so the pills stay truthful. */
  const langCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of entries) {
      if (type !== ALL && e.type !== type) continue
      m.set(e.pairKey, (m.get(e.pairKey) ?? 0) + 1)
    }
    return m
  }, [entries, type])

  const typeCounts = useMemo(() => {
    const m = new Map<CatchUpType, number>()
    for (const e of entries) {
      if (lang !== ALL && e.pairKey !== lang) continue
      m.set(e.type, (m.get(e.type) ?? 0) + 1)
    }
    return m
  }, [entries, lang])

  const overdue = selected.length
  const lapsed  = useMemo(() => selected.filter(e => isLapsed(e.candidate)).length, [selected])
  const msPerReview = useMemo(
    () => (selected.length === 0 ? 0 : selected.reduce((t, e) => t + e.msPerReview, 0) / selected.length),
    [selected],
  )

  /** What the current selection is called. Only names a direction when one language and one type. */
  const selectionLabel = useMemo(() => {
    const langPart = lang === ALL ? null : langs.find(l => l.pairKey === lang)
    if (langPart && type !== ALL) {
      const [src, tgt] = lang.split('|') as [string, string]
      const dir = scopeDirection(src, tgt, type)
      return `${langName(dir.from)} → ${langName(dir.to)} · ${TYPE_LABEL[type]}`
    }
    if (langPart) return `${langPart.label} · all card types`
    if (type !== ALL) return `${TYPE_LABEL[type]} · all languages`
    return 'Everything overdue'
  }, [lang, type, langs])

  async function spread(targetDate: string) {
    if (busy || !ctx || selected.length === 0) return
    setBusy(true)
    setMsg(null)
    try {
      const days = Math.max(1, daysBetween(ctx.today, targetDate))
      const result = assignBacklogDays({
        overdue: selected.map(e => e.candidate), today: ctx.today, days, existingLoad: ctx.inflow,
      })

      // ── Liveness re-check: ONE catch-up per card ──────────────────────────
      // The selection was computed at load time, which may be minutes old — another tab, an earlier
      // spread in this session, or reviews done in between can all have moved a card already. Re-read
      // the rows and let `rescheduleOverdueTracks` re-judge each one: it refuses anything no longer
      // overdue, so a card an earlier plan already placed can never be dealt a second date.
      // Same pattern as `planDedupeDeletions` re-checking liveness at apply time.
      const repo  = new SupabaseCardStateRepository()
      const fresh = await repo.listAllForUser(userId)
      const freshByKey     = new Map(fresh.map(st => [candidateKey(st), st]))
      const freshForwards  = new Map(
        fresh.filter(st => st.reviewDirection !== 'reverse').map(st => [st.cardId, st]))

      const updates: CardState[] = []
      let alreadyPlanned = 0
      for (const [key, day] of result.assignments) {
        const state = freshByKey.get(key)
        if (!state) { alreadyPlanned++; continue }
        const patch = rescheduleOverdueTracks(state, day, {
          tracks: ctx.tracks.get(ctx.deckPair.get(state.cardId) ?? ''),
          tz: timezone, today: ctx.today,
          forwardState: freshForwards.get(state.cardId),
        })
        if (patch) updates.push({ ...state, ...patch })
        else alreadyPlanned++
      }

      if (updates.length === 0) {
        setMsg({
          ok: false,
          text: alreadyPlanned > 0
            ? 'Nothing to move — every one of those cards is already on a catch-up schedule.'
            : 'Nothing to move — those cards are already scheduled.',
        })
        await load()
        return
      }
      // Chunked: `upsertBatch` sends one request, and a wide selection can be several hundred full
      // rows. Chunking here rather than in the repo leaves Redistribute's path untouched.
      for (const part of chunk(updates, 200)) await repo.upsertBatch(part)

      const perDay = Math.round(updates.length / days)
      const skipped = alreadyPlanned > 0
        ? ` ${alreadyPlanned.toLocaleString()} were left alone — already on a catch-up schedule.`
        : ''
      setMsg({
        ok: true,
        text: `Spread ${updates.length.toLocaleString()} card${updates.length === 1 ? '' : 's'} over ${days} day${days === 1 ? '' : 's'} — about ${perDay.toLocaleString()} a day on top of what was already scheduled.${skipped}`,
      })
      setPicking(false)
      await load()
    } catch (err) {
      console.error('Catch-up spread failed:', err)
      setMsg({ ok: false, text: 'Something went wrong. Please try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {msg && <p className={`text-sm ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</p>}

      {loading ? (
        <p className="text-sm text-ink-faint">Reading your backlog…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing is overdue — you are caught up.</p>
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-faint w-20 shrink-0">Language</span>
              <Pill active={lang === ALL} disabled={busy}
                count={entries.filter(e => type === ALL || e.type === type).length}
                onClick={() => { setLang(ALL); setPicking(false) }}>All</Pill>
              {langs.map(l => (
                <Pill key={l.pairKey} active={lang === l.pairKey} disabled={busy}
                  count={langCounts.get(l.pairKey) ?? 0}
                  onClick={() => { setLang(l.pairKey); setPicking(false) }}>{l.label}</Pill>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-faint w-20 shrink-0">Card type</span>
              <Pill active={type === ALL} disabled={busy}
                count={entries.filter(e => lang === ALL || e.pairKey === lang).length}
                onClick={() => { setType(ALL); setPicking(false) }}>All</Pill>
              {TYPES.map(t => (
                <Pill key={t} active={type === t} disabled={busy} count={typeCounts.get(t) ?? 0}
                  onClick={() => { setType(t); setPicking(false) }}>{TYPE_LABEL[t]}</Pill>
              ))}
            </div>
          </div>

          <div className="rounded-card border border-line/10 bg-surface-deep overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm text-ink truncate">{selectionLabel}</div>
                <div className="text-xs text-ink-faint">
                  {overdue === 0
                    ? 'nothing overdue in this selection'
                    : `${overdue.toLocaleString()} overdue${lapsed > 0 ? ` · ${lapsed.toLocaleString()} deeply lapsed` : ''}`}
                </div>
              </div>
              <button
                className="text-sm border border-line/20 text-ink-muted hover:text-ink hover:border-line/40 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                disabled={busy || overdue === 0}
                onClick={() => { setPicking(v => !v); setCustom('') }}
              >
                {picking ? 'Cancel' : 'Catch up'}
              </button>
            </div>

            {picking && overdue > 0 && (
              <div className="px-4 pb-4 pt-1 bg-surface-deep/60 space-y-2 border-t border-line/10">
                <p className="text-xs text-ink-faint">Be caught up in…</p>
                <div className="flex flex-wrap gap-2">
                  {PRESET_DAYS.map(d => {
                    const p = previewCatchUp({
                      overdue, lapsed, inflowPerDay: 0, days: d, msPerAnswer: msPerReview,
                    })
                    return (
                      <button
                        key={d}
                        disabled={busy}
                        onClick={() => void spread(addDays(ctx!.today, d))}
                        className="flex-1 min-w-[8.5rem] rounded-card border border-line/15 px-3 py-2 text-left hover:border-accent/50 hover:bg-surface-raised transition-colors disabled:opacity-50"
                      >
                        <div className="text-sm text-ink">{d} days</div>
                        <div className="text-xs text-ink-faint">
                          {`+${p.fromBacklog.toLocaleString()}/day`}
                          {p.minutesPerDay != null && ` · ${fmtMinutes(p.minutesPerDay)}`}
                        </div>
                      </button>
                    )
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <input
                    type="date"
                    value={custom}
                    min={addDays(ctx!.today, 1)}
                    onChange={e => setCustom(e.target.value)}
                    className="input text-xs py-1.5 px-2 w-auto"
                  />
                  <button
                    className="text-sm border border-line/20 text-ink-muted hover:text-ink hover:border-line/40 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={busy || !custom || daysBetween(ctx!.today, custom) < 1}
                    onClick={() => void spread(custom)}
                  >
                    Use this date
                  </button>
                  {busy && <span className="text-xs text-ink-faint">Rescheduling…</span>}
                </div>

                <p className="text-xs text-ink-faint pt-1">
                  {`The cards you'd lose most by putting off go on the earliest days${lapsed > 0 ? `, and the ${lapsed.toLocaleString()} deeply lapsed ones are spread evenly so no day turns into a wall of relearning` : ''}. Days that already have reviews scheduled get a smaller share.`}
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
