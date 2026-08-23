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
import { buildCatchUpPools, emptyPool, rescheduleOverdueTracks, candidateKey, type ScopePool } from '@/lib/catchUpPools'
import { assignBacklogDays, previewCatchUp, isLapsed, scopeKey, addDays, daysBetween, type CatchUpType } from '@/lib/catchUp'
import { buildPaceSamples, paceForMix, type PaceSamples, type PaceRow } from '@/lib/reviewPace'
import { isDueByLocalDate } from '@/lib/dueStatus'
import { chunk } from '@/lib/mapLimit'
import { getToday } from '@/lib/dates'
import { langName } from '@/lib/languages'
import type { CardState, Deck } from '@/domain'

const PRESET_DAYS = [3, 7, 14, 30]

const TYPE_LABEL: Record<CatchUpType, string> = {
  typing:    'Typing',
  sgForward: 'Self-graded · native → target',
  sgReverse: 'Self-graded · target → native',
}

interface Scope {
  pairKey: string
  source:  string
  target:  string
  type:    CatchUpType | null
  pool:    ScopePool
  msPerReview: number
}

function fmtMinutes(mins: number): string {
  if (mins < 60) return `~${Math.round(mins)} min`
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m === 0 ? `~${h} hr` : `~${h} hr ${m} min`
}

export default function CatchUpPanel({ userId, timezone, turnoverHour }: {
  userId:       string
  timezone:     string
  turnoverHour: number
}) {
  const [loading, setLoading]   = useState(true)
  const [scopes,  setScopes]    = useState<Scope[]>([])
  const [byType,  setByType]    = useState(false)
  const [picking, setPicking]   = useState<string | null>(null)
  const [custom,  setCustom]    = useState('')
  const [busy,    setBusy]      = useState(false)
  const [msg,     setMsg]       = useState<{ ok: boolean; text: string } | null>(null)

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
      const next: Scope[] = []
      for (const pairKey of pairKeys) {
        const [source, target] = pairKey.split('|') as [string, string]
        for (const type of [null, 'typing', 'sgForward', 'sgReverse'] as (CatchUpType | null)[]) {
          const pool = pools.get(scopeKey(pairKey, type)) ?? emptyPool()
          if (pool.overdue.length === 0) continue
          const mix = (['typing', 'sgForward', 'sgReverse'] as CatchUpType[])
            .filter(t => !type || t === type)
            .map(t => {
              const p = pools.get(scopeKey(pairKey, t))
              return {
                dir: (t === 'sgReverse' ? 'reverse' : 'forward') as 'forward' | 'reverse',
                typed: t === 'typing',
                count: (p?.overdue.length ?? 0) + (p?.dueToday.length ?? 0),
              }
            })
          next.push({
            pairKey, source, target, type, pool,
            msPerReview: paceForMix(paceSamples, source, target, mix),
          })
        }
      }
      next.sort((a, b) => b.pool.overdue.length - a.pool.overdue.length)
      setScopes(next)
      setCtx({ statesByKey, forwardByCard, deckPair, tracks, inflow, today })
    } catch (err) {
      console.error('Catch-up load failed:', err)
      setMsg({ ok: false, text: 'Could not read your backlog. Please try again.' })
    } finally {
      setLoading(false)
    }
  }, [userId, timezone, turnoverHour])

  useEffect(() => { void load() }, [load])

  const visible = useMemo(
    () => scopes.filter(s => (byType ? s.type !== null : s.type === null)),
    [scopes, byType],
  )

  async function spread(scope: Scope, targetDate: string) {
    if (busy || !ctx) return
    setBusy(true)
    setMsg(null)
    try {
      const days = Math.max(1, daysBetween(ctx.today, targetDate))
      const result = assignBacklogDays({
        overdue: scope.pool.overdue, today: ctx.today, days, existingLoad: ctx.inflow,
      })

      const updates: CardState[] = []
      for (const [key, day] of result.assignments) {
        const state = ctx.statesByKey.get(key)
        if (!state) continue
        const patch = rescheduleOverdueTracks(state, day, {
          tracks: ctx.tracks.get(ctx.deckPair.get(state.cardId) ?? ''),
          tz: timezone, today: ctx.today,
          forwardState: ctx.forwardByCard.get(state.cardId),
        })
        if (patch) updates.push({ ...state, ...patch })
      }

      if (updates.length === 0) {
        setMsg({ ok: false, text: 'Nothing to move — those cards are already scheduled.' })
        return
      }
      // Chunked: `upsertBatch` sends one request, and a language-wide backlog can be several hundred
      // full rows. Chunking here rather than in the repo leaves Redistribute's path untouched.
      const repo = new SupabaseCardStateRepository()
      for (const part of chunk(updates, 200)) await repo.upsertBatch(part)
      const perDay = Math.round(updates.length / days)
      setMsg({
        ok: true,
        text: `Spread ${updates.length.toLocaleString()} card${updates.length === 1 ? '' : 's'} over ${days} day${days === 1 ? '' : 's'} — about ${perDay.toLocaleString()} a day on top of what was already scheduled.`,
      })
      setPicking(null)
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
      ) : scopes.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing is overdue — you are caught up.</p>
      ) : (
        <>
          <div className="flex rounded-full border border-line/15 overflow-hidden text-xs w-fit">
            {([false, true] as const).map(v => (
              <button
                key={String(v)}
                onClick={() => { setByType(v); setPicking(null) }}
                className={`px-3 py-1 transition-colors ${
                  byType === v ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink'
                }`}
              >
                {v ? 'By card type' : 'By language'}
              </button>
            ))}
          </div>

          <div className="rounded-card border border-line/10 bg-surface-deep overflow-hidden">
            {visible.map(s => {
              const key     = scopeKey(s.pairKey, s.type)
              const overdue = s.pool.overdue.length
              const lapsed  = s.pool.overdue.filter(isLapsed).length
              return (
                <div key={key} className="border-b border-line/10 last:border-b-0">
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm text-ink truncate">{langName(s.source)} → {langName(s.target)}</div>
                      <div className="text-xs text-ink-faint">
                        {s.type ? `${TYPE_LABEL[s.type]} · ` : ''}
                        {`${overdue.toLocaleString()} overdue`}
                        {lapsed > 0 ? ` · ${lapsed.toLocaleString()} deeply lapsed` : ''}
                      </div>
                    </div>
                    <button
                      className="text-sm border border-line/20 text-ink-muted hover:text-ink hover:border-line/40 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 shrink-0"
                      disabled={busy}
                      onClick={() => { setPicking(picking === key ? null : key); setCustom('') }}
                    >
                      {picking === key ? 'Cancel' : 'Catch up'}
                    </button>
                  </div>

                  {picking === key && (
                    <div className="px-4 pb-4 pt-1 bg-surface-deep/60 space-y-2">
                      <p className="text-xs text-ink-faint">Be caught up in…</p>
                      <div className="flex flex-wrap gap-2">
                        {PRESET_DAYS.map(d => {
                          const p = previewCatchUp({
                            overdue, lapsed, inflowPerDay: 0, days: d, msPerAnswer: s.msPerReview,
                          })
                          return (
                            <button
                              key={d}
                              disabled={busy}
                              onClick={() => void spread(s, addDays(ctx!.today, d))}
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
                          onClick={() => void spread(s, custom)}
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
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
