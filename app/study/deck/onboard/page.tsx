'use client'

/**
 * Vocabulary onboarding — the confidence-rating screen.
 *
 * Shows one card at a time with BOTH sides visible (this isn't a test — the learner is reporting what
 * they already know) and four bands: don't know / recognize / know / know cold. See
 * `engine/onboarding.ts` for what each band means and `features/Vocabulary Onboarding.md` for the flow.
 *
 * Reached two ways, both landing here:
 *   - straight from Create, after the accuracy pass and duplicate drop;
 *   - from a deck's "Finish onboarding" button, resuming a queue left half-rated.
 *
 * Every press persists immediately (the onboarding row, plus the card_states for bands 2–4), so
 * quitting a 1000-word sitting loses nothing. Due dates are spread from a load map seeded ONCE at
 * mount, so a rating costs no extra query while still levelling against everything already scheduled.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { routes } from '@/lib/routes'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabasePipelineRepository } from '@/lib/data/pipelines'
import { SupabaseCardOnboardingRepository } from '@/lib/data/cardOnboarding'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildEnabledTracksMap, buildRetentionMap, retentionFor, activeProductionTrack } from '@/lib/sessionLimits'
import { initialCardState } from '@/engine/pipeline'
import { seedOnboardLoad, claimSpreadDay, onboardDueIso } from '@/engine/density'
import { ONBOARD_BANDS, BAND_LABELS, bandGraduates, bandWindow, onboardMemoryState } from '@/engine/onboarding'
import { getToday } from '@/lib/dates'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { displayText } from '@/lib/cardText'
import { langNativeName } from '@/lib/languages'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import type { Card, CardState, Deck, OnboardingBand } from '@/domain'

/** The furthest any band can schedule — the horizon the due-load map has to cover. */
const LOAD_HORIZON_DAYS = ONBOARD_BANDS[4].max

const BAND_ORDER: OnboardingBand[] = [1, 2, 3, 4]

/** Colour per band, coldest (don't know) to warmest (know cold). */
const BAND_STYLE: Record<OnboardingBand, string> = {
  1: 'border-danger/40 hover:border-danger hover:bg-danger/5',
  2: 'border-warning/40 hover:border-warning hover:bg-warning/5',
  3: 'border-accent/40 hover:border-accent hover:bg-accent/5',
  4: 'border-success/40 hover:border-success hover:bg-success/5',
}

interface QueueItem { card: Card }

export default function OnboardPage() {
  const offline = useOfflineMode()
  if (offline) return <OfflineUnavailable feature="Vocabulary onboarding" />
  return (
    <Suspense fallback={<div className="text-ink-muted pt-16 text-center">Loading…</div>}>
      <OnboardInner />
    </Suspense>
  )
}

function OnboardInner() {
  const deckId = useSearchParams().get('deck') ?? ''

  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [deck,    setDeck]    = useState<Deck | null>(null)
  const [queue,   setQueue]   = useState<QueueItem[]>([])
  const [index,   setIndex]   = useState(0)
  /** Cards rated before this sitting — so the counter reads against the whole queue, not this visit. */
  const [alreadyRated, setAlreadyRated] = useState(0)
  const [busy,    setBusy]    = useState(false)
  /** The last rating, for one-step undo. */
  const [lastRated, setLastRated] = useState<{ cardId: string; band: OnboardingBand } | null>(null)

  const userIdRef     = useRef<string>('')
  const loadRef       = useRef<Map<number, number>>(new Map())
  const startRef      = useRef<Date>(new Date())
  const pipelineRef   = useRef<string>('')
  const retentionRef  = useRef<{ production: number; reverse: number }>({ production: 0.9, reverse: 0.9 })
  const prodTrackRef  = useRef<'smart' | 'typed'>('typed')
  const todayRef      = useRef<string>('')

  useEffect(() => {
    if (!deckId) { setError('No deck specified.'); setLoading(false); return }
    let cancelled = false

    void (async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setError('Please sign in.'); setLoading(false); return }
        const uid = session.user.id
        userIdRef.current = uid

        const stateRepo = new SupabaseCardStateRepository()
        // Everything keyed on the user id fires at once; only the load-map seed and the card fetch
        // depend on earlier results.
        const loadProfile = async (): Promise<{ timezone: string | null; day_turnover_hour: number | null } | null> => {
          try {
            const { data } = await supabase.from('profiles')
              .select('timezone, day_turnover_hour').eq('id', uid).maybeSingle()
            return data as { timezone: string | null; day_turnover_hour: number | null } | null
          } catch { return null }   // never block onboarding on the profile read; device tz is fine
        }

        const [deckRow, rows, paramRows, pipeline, profile] = await Promise.all([
          new SupabaseDeckRepository().get(deckId),
          new SupabaseCardOnboardingRepository().listForDeck(uid, deckId),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
          new SupabasePipelineRepository().getDefault(),
          loadProfile(),
        ])
        if (cancelled) return
        if (!deckRow) { setError('Deck not found.'); setLoading(false); return }

        const pending = rows.filter(r => r.band === null)
        const cardsByDeck = await new SupabaseCardRepository().listForDecks([deckId])
        if (cancelled) return
        const byId = new Map((cardsByDeck.get(deckId) ?? []).map(c => [c.id, c]))

        // Deck list order, not the order the rows were written — matches how the ladder feeds cards.
        const items: QueueItem[] = pending
          .map(r => byId.get(r.cardId))
          .filter((c): c is Card => c != null)
          .map(card => ({ card }))

        const tracks    = buildEnabledTracksMap(paramRows).get(`${deckRow.sourceLanguage}|${deckRow.targetLanguage}`)
        const retention = buildRetentionMap(paramRows)
        // Which production column the card's due date belongs in. Neither track enabled → write the
        // typed lane, matching ladder graduation; the card is ghosted until a track is turned on.
        const prodTrack = activeProductionTrack(tracks) ?? 'typed'
        prodTrackRef.current = prodTrack
        retentionRef.current = {
          production: retentionFor(retention, deckRow.sourceLanguage, deckRow.targetLanguage,
            prodTrack === 'smart' ? 'forward_smart' : 'forward_typed'),
          reverse: retentionFor(retention, deckRow.sourceLanguage, deckRow.targetLanguage, 'reverse_recall'),
        }
        pipelineRef.current = deckRow.pipelineId || pipeline.id

        // Never fall back to UTC — see the "getToday owns what day it is" trap in CLAUDE.md.
        const tz = profile?.timezone || deviceTimeZone()
        todayRef.current = getToday(tz, Number(profile?.day_turnover_hour ?? 0))

        startRef.current = new Date()
        loadRef.current = await seedOnboardLoad(uid, startRef.current, LOAD_HORIZON_DAYS, stateRepo)
        if (cancelled) return

        setDeck(deckRow)
        setQueue(items)
        setAlreadyRated(rows.length - pending.length)
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load the onboarding queue.')
        setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [deckId])

  /**
   * Builds the two card_states rows a known card graduates with — production and recognition,
   * mirroring how the ladder graduates a card (`LadderStudy.graduate`). Each direction claims its own
   * day from the shared load map, so a card's two reviews don't land together.
   */
  const buildStates = useCallback((cardId: string, band: Exclude<OnboardingBand, 1>): CardState[] => {
    const now    = new Date()
    const nowIso = now.toISOString()
    const window = { ...bandWindow(band), center: ONBOARD_BANDS[band].center }

    const make = (direction: 'forward' | 'reverse'): CardState => {
      const offset    = claimSpreadDay(loadRef.current, window)
      const dueAt     = onboardDueIso(startRef.current, offset)
      const retention = direction === 'forward' ? retentionRef.current.production : retentionRef.current.reverse
      const { difficulty, stability } = onboardMemoryState(band, offset, retention)
      const base = initialCardState(userIdRef.current, cardId, pipelineRef.current)
      return {
        ...base,
        reviewDirection: direction,
        graduated:       true,
        graduatedAt:     nowIso,
        // No review has happened — reps stays 0 and lastReviewedAt null, so the first real review
        // computes its elapsed time from the schedule rather than from a fake review that never
        // happened, and analytics don't count a self-rating as a review.
        introducedDate:  todayRef.current || base.introducedDate,
        difficulty,
        stability,
        intervalDays:          offset,
        scheduledIntervalDays: offset,
        dueAt,
        ...(direction === 'forward'
          ? (prodTrackRef.current === 'smart'
              ? { smartIntervalDays: offset, smartDueAt: dueAt }
              : { typedIntervalDays: offset, typedDueAt: dueAt })
          : { recallIntervalDays: offset, recallDueAt: dueAt }),
        // Excluded from daily goals: onboarding is self-assessment, not study. 'bulk_known' keeps
        // normal FSRS scheduling (unlike 'import_known', which rides the accelerated multiplier).
        acceleratedMode: 'bulk_known',
      }
    }

    return [make('forward'), make('reverse')]
  }, [])

  const rate = useCallback(async (band: OnboardingBand) => {
    const item = queue[index]
    if (!item || busy) return
    setBusy(true)
    try {
      if (bandGraduates(band)) {
        await new SupabaseCardStateRepository().upsertBatch(buildStates(item.card.id, band))
      }
      await new SupabaseCardOnboardingRepository().rate(userIdRef.current, item.card.id, band)
      setLastRated({ cardId: item.card.id, band })
      setIndex(i => i + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that rating.')
    } finally {
      setBusy(false)
    }
  }, [queue, index, busy, buildStates])

  /**
   * Undoes the previous rating: clears any schedule it wrote and re-queues it.
   *
   * The day it claimed is deliberately NOT returned to the load map — the map only has to stop cards
   * from piling up, and an un-returned day biases the next card away from a slot that is now free.
   * That's a rounding error across a session and much simpler than tracking claims per card.
   */
  const undo = useCallback(async () => {
    if (!lastRated || busy || index === 0) return
    setBusy(true)
    try {
      const repo = new SupabaseCardStateRepository()
      if (bandGraduates(lastRated.band)) {
        await repo.delete(userIdRef.current, lastRated.cardId, 'forward')
        await repo.delete(userIdRef.current, lastRated.cardId, 'reverse')
      }
      await new SupabaseCardOnboardingRepository().unrate(userIdRef.current, lastRated.cardId)
      setLastRated(null)
      setIndex(i => Math.max(0, i - 1))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not undo that rating.')
    } finally {
      setBusy(false)
    }
  }, [lastRated, busy, index])

  // Keys 1–4 rate; U undoes. Ignored while a save is in flight so a held key can't double-rate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key >= '1' && e.key <= '4') { e.preventDefault(); void rate(Number(e.key) as OnboardingBand) }
      else if (e.key.toLowerCase() === 'u') { e.preventDefault(); void undo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rate, undo])

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  if (error) {
    return (
      <div className="max-w-md mx-auto pt-16 space-y-4 text-center">
        <p className="text-danger text-sm">{error}</p>
        <Link href={deckId ? routes.deck(deckId) : '/study'} className="btn-ghost inline-block">Back to deck</Link>
      </div>
    )
  }

  const total = queue.length + alreadyRated
  const done  = index + alreadyRated

  if (index >= queue.length) {
    return (
      <div className="max-w-md mx-auto pt-16 space-y-4 text-center">
        <h1 className="text-2xl font-semibold text-ink">Onboarding complete</h1>
        <p className="text-ink-muted text-sm">
          {total} word{total !== 1 ? 's' : ''} rated. The ones you didn&apos;t know are waiting in the
          learning pipeline; the rest are scheduled.
        </p>
        <div className="flex justify-center gap-3">
          <Link href={routes.deck(deckId)} className="btn-primary">Go to deck</Link>
          {lastRated && (
            <button className="btn-ghost" disabled={busy} onClick={() => void undo()}>Undo last</button>
          )}
        </div>
      </div>
    )
  }

  const card = queue[index]!.card

  return (
    <div className="space-y-8 pb-12">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">How well do you know this?</h1>
          {deck && (
            <p className="text-xs text-ink-faint mt-0.5">
              {langNativeName(deck.sourceLanguage)}: {deck.name}
            </p>
          )}
        </div>
        <span className="text-sm text-ink-muted tabular-nums">{done} / {total}</span>
      </div>

      <div className="h-1 rounded-full bg-surface overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
      </div>

      <div className="panel py-10 text-center space-y-3">
        <p className="text-3xl font-semibold text-ink break-words">{displayText(card.front)}</p>
        <p className="text-lg text-ink-muted break-words">{displayText(card.back)}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {BAND_ORDER.map(band => (
          <button
            key={band}
            disabled={busy}
            onClick={() => void rate(band)}
            className={`rounded-lg border bg-surface px-4 py-3 text-left transition-colors disabled:opacity-50 ${BAND_STYLE[band]}`}
          >
            <span className="flex items-center gap-2">
              <span className="text-xs text-ink-faint tabular-nums">{band}</span>
              <span className="text-sm font-medium text-ink">{BAND_LABELS[band].title}</span>
            </span>
            <span className="block text-xs text-ink-muted mt-0.5 pl-6">{BAND_LABELS[band].detail}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-4 text-xs text-ink-faint">
        <span>Press 1–4 to rate, U to undo</span>
        {lastRated && (
          <button className="text-accent hover:text-accent-soft transition-colors" disabled={busy}
            onClick={() => void undo()}>
            Undo last
          </button>
        )}
        <Link href={routes.deck(deckId)} className="ml-auto hover:text-ink transition-colors">
          Finish later
        </Link>
      </div>
    </div>
  )
}
