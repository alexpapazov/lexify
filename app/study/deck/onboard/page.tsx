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
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { descendantDeckIds } from '@/lib/folderStats'
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
import { EditableAnswerText } from '@/components/session/EditableAnswerText'
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

interface QueueItem { card: Card; deck: Deck }

/**
 * Per-deck scheduling context. A folder-scoped queue can span decks with different language pairs
 * (different enabled tracks and retention targets) and different pipelines, so none of this can live
 * in a single ref the way it did when the page was deck-only.
 */
interface DeckCtx {
  pipelineId: string
  prodTrack:  'smart' | 'typed'
  retention:  { production: number; reverse: number }
}

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
  const params   = useSearchParams()
  const deckId   = params.get('deck') ?? ''
  // Folder mode: rate the pending queue across every deck under the folder. When the folder was being
  // viewed in a language-pair context, `source`/`target` keep the queue to that pair's decks.
  const folderId   = params.get('folder') ?? ''
  const pairSource = params.get('source')
  const pairTarget = params.get('target')

  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
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
  const ctxRef        = useRef<Map<string, DeckCtx>>(new Map())
  const todayRef      = useRef<string>('')

  useEffect(() => {
    if (!deckId && !folderId) { setError('No deck specified.'); setLoading(false); return }
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

        // The decks in scope: the single deck, or every deck under the folder (kept to the pair the
        // folder was being viewed in, when there is one). Library order, so the queue reads top-down.
        const loadScopeDecks = async (): Promise<Deck[]> => {
          if (!folderId) {
            const deckRow = await new SupabaseDeckRepository().get(deckId)
            return deckRow ? [deckRow] : []
          }
          const [folders, decks] = await Promise.all([
            new SupabaseFolderRepository().list(uid),
            new SupabaseDeckRepository().list(uid),
          ])
          const inScope = new Set(descendantDeckIds(folderId, folders, decks))
          return decks.filter(d => inScope.has(d.id) &&
            (!pairSource || !pairTarget || (d.sourceLanguage === pairSource && d.targetLanguage === pairTarget)))
        }

        const [scopeDecks, paramRows, pipeline, profile] = await Promise.all([
          loadScopeDecks(),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
          new SupabasePipelineRepository().getDefault(),
          loadProfile(),
        ])
        if (cancelled) return
        if (scopeDecks.length === 0) {
          setError(folderId ? 'Folder not found (or it has no decks).' : 'Deck not found.')
          setLoading(false)
          return
        }

        const deckIds = scopeDecks.map(d => d.id)
        const [rows, cardsByDeck] = await Promise.all([
          new SupabaseCardOnboardingRepository().listForDecks(uid, deckIds),
          new SupabaseCardRepository().listForDecks(deckIds),
        ])
        if (cancelled) return

        // Deck list order within each deck, decks in library order — matches how the ladder feeds
        // cards (not the order the queue rows were written).
        const pendingByDeck = new Map<string, Set<string>>()
        for (const r of rows) {
          if (r.band !== null) continue
          let set = pendingByDeck.get(r.deckId)
          if (!set) { set = new Set(); pendingByDeck.set(r.deckId, set) }
          set.add(r.cardId)
        }
        const items: QueueItem[] = scopeDecks.flatMap(deck => {
          const pending = pendingByDeck.get(deck.id)
          if (!pending) return []
          return (cardsByDeck.get(deck.id) ?? [])
            .filter(c => pending.has(c.id))
            .map(card => ({ card, deck }))
        })

        const tracksByPair = buildEnabledTracksMap(paramRows)
        const retention    = buildRetentionMap(paramRows)
        const ctx = new Map<string, DeckCtx>()
        for (const d of scopeDecks) {
          // Which production column the card's due date belongs in. Neither track enabled → write the
          // typed lane, matching ladder graduation; the card is ghosted until a track is turned on.
          const prodTrack = activeProductionTrack(tracksByPair.get(`${d.sourceLanguage}|${d.targetLanguage}`)) ?? 'typed'
          ctx.set(d.id, {
            pipelineId: d.pipelineId || pipeline.id,
            prodTrack,
            retention: {
              production: retentionFor(retention, d.sourceLanguage, d.targetLanguage,
                prodTrack === 'smart' ? 'forward_smart' : 'forward_typed'),
              reverse: retentionFor(retention, d.sourceLanguage, d.targetLanguage, 'reverse_recall'),
            },
          })
        }
        ctxRef.current = ctx

        // Never fall back to UTC — see the "getToday owns what day it is" trap in CLAUDE.md.
        const tz = profile?.timezone || deviceTimeZone()
        todayRef.current = getToday(tz, Number(profile?.day_turnover_hour ?? 0))

        startRef.current = new Date()
        loadRef.current = await seedOnboardLoad(uid, startRef.current, LOAD_HORIZON_DAYS, stateRepo)
        if (cancelled) return

        setQueue(items)
        setAlreadyRated(rows.length - rows.filter(r => r.band === null).length)
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load the onboarding queue.')
        setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [deckId, folderId, pairSource, pairTarget])

  /**
   * Builds the two card_states rows a known card graduates with — production and recognition,
   * mirroring how the ladder graduates a card (`LadderStudy.graduate`). Each direction claims its own
   * day from the shared load map, so a card's two reviews don't land together.
   */
  const buildStates = useCallback((deckId: string, cardId: string, band: Exclude<OnboardingBand, 1>): CardState[] => {
    const ctx    = ctxRef.current.get(deckId)!   // every queue item's deck was given a ctx at load
    const now    = new Date()
    const nowIso = now.toISOString()
    const window = { ...bandWindow(band), center: ONBOARD_BANDS[band].center }

    const make = (direction: 'forward' | 'reverse'): CardState => {
      const offset    = claimSpreadDay(loadRef.current, window)
      const dueAt     = onboardDueIso(startRef.current, offset)
      const retention = direction === 'forward' ? ctx.retention.production : ctx.retention.reverse
      const { difficulty, stability } = onboardMemoryState(band, offset, retention)
      const base = initialCardState(userIdRef.current, cardId, ctx.pipelineId)
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
          ? (ctx.prodTrack === 'smart'
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
        await new SupabaseCardStateRepository().upsertBatch(buildStates(item.deck.id, item.card.id, band))
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
   * Deletes the card outright — "this shouldn't be in my deck at all".
   *
   * The card already exists in the database by this point (the create flow writes them before rating
   * starts), so this soft-deletes it AND removes the queue row. The row has to go explicitly:
   * `softDelete` only sets `deleted_at`, so the FK cascade never fires and the deck would keep
   * offering "Finish onboarding" for a card that can never appear again.
   *
   * Removes the item rather than advancing past it, so the counter's total shrinks — a deleted card
   * was never part of the work.
   */
  const deleteCard = useCallback(async () => {
    const item = queue[index]
    if (!item || busy) return
    setBusy(true)
    try {
      await new SupabaseCardRepository().softDelete(item.card.id)
      await new SupabaseCardOnboardingRepository().remove(userIdRef.current, item.card.id)
      setQueue(q => q.filter((_, i) => i !== index))
      setLastRated(null)   // undo can't reach past a deletion
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that card.')
    } finally {
      setBusy(false)
    }
  }, [queue, index, busy])

  /**
   * Double-click-to-edit on either side, same affordance (and same persistence rules) as the ladder's
   * `onCardEdit`: changing the FRONT invalidates the generated audio and distractors, changing the
   * back only the distractors. An empty submission means "delete", matching EditableAnswerText's
   * contract everywhere else in the app.
   */
  const editCard = useCallback(async (side: 'front' | 'back', newText: string) => {
    const item = queue[index]
    if (!item) return
    if (!newText) { void deleteCard(); return }
    if (newText === (side === 'front' ? item.card.front : item.card.back)) return
    try {
      const updated = await new SupabaseCardRepository().update(item.card.id, side === 'front'
        ? { front: newText, audioGenerated: false as const, audioData: null, choices: null }
        : { back: newText, choices: null })
      setQueue(q => q.map((it, i) => i === index ? { card: updated, deck: it.deck } : it))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that edit.')
    }
  }, [queue, index, deleteCard])

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

  // Where "done" / "finish later" / errors lead back to: the folder in folder mode, else the deck.
  const backHref = folderId
    ? routes.library(folderId, { source: pairSource, target: pairTarget })
    : deckId ? routes.deck(deckId) : '/study'
  const backNoun = folderId ? 'folder' : 'deck'

  if (error) {
    return (
      <div className="max-w-md mx-auto pt-16 space-y-4 text-center">
        <p className="text-danger text-sm">{error}</p>
        <Link href={backHref} className="btn-ghost inline-block">Back to {backNoun}</Link>
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
          {`${total} word${total !== 1 ? 's' : ''} rated. The ones you didn’t know are waiting in the learning pipeline; the rest are scheduled.`}
        </p>
        <div className="flex justify-center gap-3">
          <Link href={backHref} className="btn-primary">Go to {backNoun}</Link>
          {lastRated && (
            <button className="btn-ghost" disabled={busy} onClick={() => void undo()}>Undo last</button>
          )}
        </div>
      </div>
    )
  }

  const { card, deck } = queue[index]!

  return (
    <div className="space-y-8 pb-12 max-w-2xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">How well do you know this?</h1>
          <p className="text-xs text-ink-faint mt-0.5">
            {langNativeName(deck.sourceLanguage)}: {deck.name}
          </p>
        </div>
        <span className="text-sm text-ink-muted tabular-nums">{done} / {total}</span>
      </div>

      <div className="h-1 rounded-full bg-surface overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
      </div>

      <div className="panel relative py-10 text-center space-y-3">
        <button
          onClick={() => void deleteCard()}
          disabled={busy}
          title="Delete this card — it won't be added to the deck"
          className="absolute top-3 right-3 p-2 rounded-lg text-ink-faint hover:text-danger hover:bg-danger/5 transition-colors disabled:opacity-50"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
            <path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>

        {/* Double-click either side to correct the card in place — same affordance as the ladder. */}
        <div className="px-12">
          <EditableAnswerText
            text={displayText(card.front)}
            onEdit={t => void editCard('front', t)}
            className="text-3xl font-semibold text-ink break-words"
          />
        </div>
        <div className="px-12">
          <EditableAnswerText
            text={displayText(card.back)}
            onEdit={t => void editCard('back', t)}
            className="text-lg text-ink-muted break-words"
          />
        </div>
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
        <Link href={backHref} className="ml-auto hover:text-ink transition-colors">
          Finish later
        </Link>
      </div>
    </div>
  )
}
