'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import type { CardSide } from '@/domain'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { setAudioPlaybackRate, setAudioVolume, setAudioSourceDefault, setAudioSourceByLanguage } from '@/lib/speak'
import { SupabaseLadderRepository } from '@/lib/data/ladders'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { resolveEffectiveLadder } from '@/lib/ladder'
import { reviewRung, applyWindow, initialClimbState, type ClimbState, type RungAttemptOutcome, type IntervalRange } from '@/engine/ladderEngine'
import { pickNextCard, rungReshowMs, type QueueItem } from '@/lib/ladderSession'
import { prefetchAudio } from '@/lib/distractors'
import { snapDueAtToStartOfDay } from '@/lib/dates'
import { initialCardState } from '@/engine/pipeline'
import { LadderStudyCard } from '@/components/ladder/LadderStudyCard'
import { UndoFab } from '@/components/session/UndoFab'
import { CardEditModal } from '@/components/CardEditModal'
import type { Card, CardChoices, Deck, Ladder, RungType } from '@/domain'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'

const RUNG_LABEL: Record<RungType, string> = {
  mcq: 'Recognize', typing: 'Type', self_graded: 'Recall', dictation: 'Dictation',
}

/** What set of cards this ladder session covers. Decks in a folder / pair share a
 *  language pair, so they share one ladder — only the per-card deck varies. */
export type LadderScope =
  | { kind: 'deck';   deckId: string }
  | { kind: 'folder'; folderId: string }
  | { kind: 'all';    source: string; target: string }

function backHref(scope: LadderScope): string {
  if (scope.kind === 'deck')   return `/study/${scope.deckId}`
  if (scope.kind === 'folder') return `/library/${scope.folderId}`
  return `/library?source=${scope.source}&target=${scope.target}`
}

export function LadderStudy({ scope }: { scope: LadderScope }) {
  const category = useSearchParams().get('category') // 'new' | 'learning' | null
  const [userId, setUserId] = useState<string | null>(null)
  const [decksById, setDecksById] = useState<Map<string, Deck>>(new Map())
  const [deckByCard, setDeckByCard] = useState<Map<string, string>>(new Map())
  const [ladder, setLadder] = useState<Ladder | null>(null)
  const [cardsById, setCardsById] = useState<Map<string, Card>>(new Map())
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [states, setStates] = useState<Map<string, ClimbState>>(new Map())
  const [graduated, setGraduated] = useState(0)
  const [answered, setAnswered] = useState(0)
  const [paused, setPaused] = useState(false)
  const [pauseKind, setPauseKind] = useState<'round' | 'lastcard'>('round')
  const [hasMore, setHasMore] = useState(false)
  const progressPctRef = useRef(0)
  const startStepsRef  = useRef(0)
  const tzRef          = useRef('UTC')
  const turnoverRef    = useRef(0)
  const [loading, setLoading] = useState(true)
  const [infoOpen, setInfoOpen] = useState(false)
  const [overrides, setOverrides] = useState<Map<string, Set<string>>>(new Map())
  const [undoStack, setUndoStack] = useState<Array<{
    cardId: string; prevClimb: ClimbState | undefined; prevQueueItem: QueueItem | undefined
    wasGraduated: boolean; prevAnswered: number; prevPaused: boolean
  }>>([])

  // The deck a given card belongs to (for climb-save, grading, distractors).
  const deckFor = useCallback((cardId: string): Deck | undefined => {
    const dId = deckByCard.get(cardId)
    return dId ? decksById.get(dId) : undefined
  }, [deckByCard, decksById])

  const handleOverrideAnswer = useCallback((cardId: string, answerSide: CardSide, answerText: string, accept: boolean) => {
    if (!userId) return
    const key = `${cardId}:${answerSide}`
    setOverrides(prev => {
      const next = new Map(prev)
      const set  = new Set(next.get(key) ?? [])
      if (accept) set.add(answerText); else set.delete(answerText)
      next.set(key, set)
      return next
    })
    const repo = new SupabaseTypedAnswerOverrideRepository()
    const op = accept ? repo.add(userId, cardId, answerSide, answerText) : repo.remove(userId, cardId, answerSide, answerText)
    op.catch(err => console.error('Failed to save typed-answer override:', err))
  }, [userId])

  const handleChoiceEdit = useCallback(async (cardId: string, answerSide: CardSide, originalChoice: string, newText: string, isCorrect: boolean) => {
    const cardRepo = new SupabaseCardRepository()
    const card = cardsById.get(cardId)
    if (!card) return
    let updated: Card
    if (isCorrect) {
      updated = await cardRepo.update(cardId, answerSide === 'front' ? { front: newText } : { back: newText })
    } else {
      const existing = card.choices ?? { front: [], back: [] }
      const pool = existing[answerSide] ?? []
      const newPool = !newText ? pool.filter(d => d !== originalChoice) : pool.map(d => d === originalChoice ? newText : d)
      updated = await cardRepo.update(cardId, { choices: { ...existing, [answerSide]: newPool } })
    }
    setCardsById(prev => new Map(prev).set(cardId, updated))
  }, [cardsById])

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      const uid = session.user.id; setUserId(uid)

      // ── Resolve which decks this scope covers ──
      const deckRepo = new SupabaseDeckRepository()
      let decks: Deck[] = []
      if (scope.kind === 'deck') {
        const d = await deckRepo.get(scope.deckId)
        if (d) decks = [d]
      } else if (scope.kind === 'all') {
        decks = (await deckRepo.list(uid)).filter(d => d.sourceLanguage === scope.source && d.targetLanguage === scope.target)
      } else {
        // Folder (including nested subfolders).
        const [allDecks, folders] = await Promise.all([deckRepo.list(uid), new SupabaseFolderRepository().list(uid)])
        const wanted = new Set([scope.folderId])
        let grew = true
        while (grew) {
          grew = false
          for (const f of folders) {
            if (f.parentId && wanted.has(f.parentId) && !wanted.has(f.id)) { wanted.add(f.id); grew = true }
          }
        }
        decks = allDecks.filter(d => d.folderId && wanted.has(d.folderId))
      }
      if (decks.length === 0) { setLoading(false); return }
      setDecksById(new Map(decks.map(d => [d.id, d])))

      // ── Merge cards across decks (tracking each card's deck) ──
      const cardRepo = new SupabaseCardRepository()
      const stateRepo = new SupabaseCardStateRepository()
      const perDeck = await Promise.all(decks.map(async d => ({
        deck: d,
        cards: await cardRepo.listByDeck(d.id),
        states: await stateRepo.listByDeck(uid, d.id),
      })))
      const allCards: Card[] = []
      const cardDeck = new Map<string, string>()
      const gradSet = new Set<string>()
      const learningStateSet = new Set<string>()
      for (const { deck, cards, states: cs } of perDeck) {
        for (const c of cards) { if (!cardDeck.has(c.id)) { allCards.push(c); cardDeck.set(c.id, deck.id) } }
        for (const s of cs) {
          if (s.reviewDirection === 'reverse') continue
          if (s.graduated) gradSet.add(s.cardId); else learningStateSet.add(s.cardId)
        }
      }
      setCardsById(new Map(allCards.map(c => [c.id, c])))
      setDeckByCard(cardDeck)

      // Persisted typed-answer overrides.
      const overrideRows = await new SupabaseTypedAnswerOverrideRepository().listForUser(uid)
      const overrideMap = new Map<string, Set<string>>()
      for (const o of overrideRows) {
        const key = `${o.cardId}:${o.answerSide}`
        const set = overrideMap.get(key) ?? new Set<string>()
        set.add(o.answerText); overrideMap.set(key, set)
      }
      setOverrides(overrideMap)

      // One ladder for the whole scope (decks share a pair).
      const primary = decks[0]!
      const ladderRepo = new SupabaseLadderRepository()
      const [pair, def] = await Promise.all([ladderRepo.getForPair(uid, primary.sourceLanguage, primary.targetLanguage), ladderRepo.getDefault(uid)])
      const effLadder = resolveEffectiveLadder(pair, def)
      setLadder(effLadder)

      const climb = await new SupabaseLadderClimbRepository().listForCards(uid, allCards.map(c => c.id))

      const shuffle = <T,>(a: T[]) => a.sort(() => Math.random() - 0.5)
      const learning: string[] = []
      const fresh: string[] = []
      const reconciled = new Map(climb)
      for (const c of allCards) {
        if (gradSet.has(c.id)) continue
        const cl = climb.get(c.id)
        if (cl && !cl.graduated) { learning.push(c.id); continue }
        const alreadyLearning = learningStateSet.has(c.id)
        if (cl || alreadyLearning) reconciled.set(c.id, initialClimbState())
        ;(alreadyLearning ? learning : fresh).push(c.id)
      }
      setStates(reconciled)

      // Audio + timezone prefs. Per-deck intake caps only apply to single-deck scope.
      const prefsRepo = new SupabaseDeckPreferencesRepository()
      const prefs = scope.kind === 'deck' ? await prefsRepo.get(uid, scope.deckId) : null
      setAudioPlaybackRate(prefs?.audioSpeed ?? 1)
      setAudioVolume(prefs?.audioVolume ?? 1)
      const audioPref = await createClient().from('profiles').select('audio_source_default, audio_source_by_language, timezone, day_turnover_hour').eq('user_id', uid).single()
      setAudioSourceDefault(audioPref.data?.audio_source_default as string | null)
      setAudioSourceByLanguage(audioPref.data?.audio_source_by_language as Record<string, string> | null)
      tzRef.current       = (audioPref.data?.timezone as string | null) ?? 'UTC'
      turnoverRef.current = (audioPref.data?.day_turnover_hour as number | null) ?? 0

      let q: string[]
      if (category === 'new')          q = shuffle(fresh)
      else if (category === 'learning') q = shuffle(learning)
      else {
        const cap = prefs?.cardsPerSession ?? null
        if (cap != null && cap > 0) {
          if (prefs!.learningBatchMode) {
            q = learning.length > 0 ? shuffle(learning) : shuffle(fresh).slice(0, cap)
          } else {
            q = [...shuffle(learning), ...shuffle(fresh)].slice(0, cap)
          }
        } else {
          const newLimit = prefs ? prefsRepo.effectiveDailyLimit(prefs) : 20
          q = [...shuffle(learning), ...shuffle(fresh).slice(0, Math.max(0, newLimit))]
        }
      }
      const items: QueueItem[] = q.map(cardId => ({ cardId, readyAt: 0, ratedAt: 0 }))
      const ladderLen0 = Math.max(1, effLadder.rungs.length)
      startStepsRef.current = items.reduce((s, it) => s + Math.min(reconciled.get(it.cardId)?.rungIndex ?? 0, ladderLen0), 0)
      progressPctRef.current = 0
      setAnswered(0); setPaused(false)
      setQueue(items); setTotal(items.length)
      setHasMore((fresh.length + learning.length) > items.length)
      setCurrentId(pickNextCard(items, Date.now())?.cardId ?? null)
      setLoading(false)

      const qSet = new Set(q)
      void prefetchAudio(
        allCards.filter(c => qSet.has(c.id)).map(c => ({ card: c, sourceLanguage: c.sourceLanguage })),
        (cardId, audioData) => setCardsById(prev => {
          const c = prev.get(cardId)
          return c ? new Map(prev).set(cardId, { ...c, audioData, audioGenerated: true }) : prev
        }),
      )
    })()
  }, [scope, category])

  const currentCard = currentId ? cardsById.get(currentId) : undefined
  const currentClimb = currentId ? applyWindow(states.get(currentId) ?? initialClimbState(), Date.now()) : null
  const currentRung = ladder && currentClimb ? ladder.rungs[currentClimb.rungIndex] : undefined
  const currentDeck = currentId ? deckFor(currentId) : undefined

  function onChoicesCached(cardId: string, choices: CardChoices) {
    setCardsById(prev => { const c = prev.get(cardId); if (!c) return prev; return new Map(prev).set(cardId, { ...c, choices }) })
  }

  async function graduate(cardId: string, target: IntervalRange | null, native: IntervalRange | null) {
    if (!userId) return
    const deck = deckFor(cardId)
    const repo = new SupabaseCardStateRepository()
    const now = new Date()
    const due = (days: number) =>
      snapDueAtToStartOfDay(new Date(now.getTime() + days * DAY_MS).toISOString(), tzRef.current, turnoverRef.current)
    const base = initialCardState(userId, cardId, deck?.pipelineId ?? DEFAULT_PIPELINE_ID)
    const tDays = target?.min ?? 1
    const nDays = native?.min ?? 1
    await repo.upsert({ ...base, graduated: true, graduatedAt: now.toISOString(), reps: 1, lastRating: 'good', lastReviewedAt: now.toISOString(),
      reviewDirection: 'forward', intervalDays: tDays, scheduledIntervalDays: tDays, typedIntervalDays: tDays, dueAt: due(tDays), typedDueAt: due(tDays) })
    await repo.upsert({ ...base, graduated: true, graduatedAt: now.toISOString(), reps: 1, lastRating: 'good', lastReviewedAt: now.toISOString(),
      reviewDirection: 'reverse', intervalDays: nDays, scheduledIntervalDays: nDays, recallIntervalDays: nDays, dueAt: due(nDays), recallDueAt: due(nDays) })
  }

  async function onOutcome(outcome: RungAttemptOutcome) {
    if (!userId || !ladder || !currentId || !currentClimb) return
    const now = Date.now()
    const res = reviewRung(ladder, currentClimb, outcome, now)
    setUndoStack(prev => [...prev.slice(-19), {
      cardId: currentId, prevClimb: states.get(currentId), prevQueueItem: queue.find(e => e.cardId === currentId),
      wasGraduated: res.state.graduated, prevAnswered: answered, prevPaused: paused,
    }])
    await new SupabaseLadderClimbRepository().save(userId, currentId, deckByCard.get(currentId) ?? '', res.state).catch(console.error)
    setStates(prev => new Map(prev).set(currentId, res.state))

    let nextQueue: QueueItem[]
    if (res.state.graduated) {
      await graduate(currentId, res.state.targetInterval, res.state.nativeInterval)
      setGraduated(g => g + 1)
      nextQueue = queue.filter(e => e.cardId !== currentId)
    } else {
      const rung = ladder.rungs[currentClimb.rungIndex]!
      const delay = rungReshowMs(rung, res, ladder.betweenRungWaitSeconds ?? 180)
      nextQueue = queue.map(e => e.cardId === currentId
        ? { cardId: currentId, readyAt: delay > 0 ? now + delay : 0, ratedAt: delay > 0 ? now : 0 }
        : e)
    }
    setQueue(nextQueue)
    const nextId = pickNextCard(nextQueue, now, currentId)?.cardId ?? null
    setCurrentId(nextId)

    const nextAnswered = answered + 1
    setAnswered(nextAnswered)
    // When only the just-rated card is left, pickNextCard has no other card to switch to
    // and re-shows it immediately — which reads as "the rating didn't register". Break to a
    // short interstitial so the rating clearly lands before the card comes back.
    if (nextId && !res.state.graduated && nextQueue.length === 1) { setPauseKind('lastcard'); setPaused(true) }
    else if (nextId && total > 0 && nextAnswered % total === 0) { setPauseKind('round'); setPaused(true) }
  }

  const handleUndo = useCallback(async () => {
    const entry = undoStack[undoStack.length - 1]
    if (!entry || !userId) return
    setUndoStack(prev => prev.slice(0, -1))
    const { cardId, prevClimb, prevQueueItem, wasGraduated, prevAnswered, prevPaused } = entry
    const fallbackItem: QueueItem = prevQueueItem ?? { cardId, readyAt: 0, ratedAt: 0 }
    const climbRepo = new SupabaseLadderClimbRepository()
    if (prevClimb) {
      await climbRepo.save(userId, cardId, deckByCard.get(cardId) ?? '', prevClimb).catch(console.error)
      setStates(prev => new Map(prev).set(cardId, prevClimb))
    } else {
      await climbRepo.remove(userId, cardId).catch(console.error)
      setStates(prev => { const m = new Map(prev); m.delete(cardId); return m })
    }
    if (wasGraduated) {
      const stateRepo = new SupabaseCardStateRepository()
      await stateRepo.delete(userId, cardId, 'forward').catch(() => {})
      await stateRepo.delete(userId, cardId, 'reverse').catch(() => {})
      setGraduated(g => Math.max(0, g - 1))
      setQueue(prev => prev.some(e => e.cardId === cardId) ? prev : [...prev, fallbackItem])
    } else {
      setQueue(prev => prev.map(e => e.cardId === cardId ? fallbackItem : e))
    }
    setAnswered(prevAnswered)
    setPaused(prevPaused)
    setCurrentId(cardId)
  }, [undoStack, userId, deckByCard])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); void handleUndo() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleUndo])

  function handleRepeat() {
    if (!currentId) return
    const now = Date.now()
    const waitMs = (ladder?.betweenRungWaitSeconds ?? 180) * 1000
    const nextQueue = queue.map(e => e.cardId === currentId
      ? { cardId: currentId, readyAt: waitMs > 0 ? now + waitMs : 0, ratedAt: waitMs > 0 ? now : 0 }
      : e)
    setQueue(nextQueue)
    setCurrentId(pickNextCard(nextQueue, now, currentId)?.cardId ?? null)
  }

  const back = backHref(scope)

  if (loading) return <p className="p-6 text-sm text-ink-faint">Loading…</p>
  if (decksById.size === 0 || !ladder) return <p className="p-6 text-sm text-danger">Nothing to study here.</p>

  if (!currentCard || !currentRung || !currentClimb || !currentDeck) {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-6">
        <UndoFab show={undoStack.length > 0} onUndo={() => void handleUndo()} />
        <h1 className="text-xl font-semibold text-ink">Session complete</h1>
        <p className="text-ink-muted">{graduated > 0 ? `Graduated ${graduated} card${graduated === 1 ? '' : 's'}.` : 'Nothing to learn right now.'}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <a href={back} className="btn-ghost">Back</a>
          {hasMore && <button onClick={() => window.location.reload()} className="btn-primary">Continue</button>}
        </div>
      </div>
    )
  }

  if (paused) {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-6">
        <UndoFab show={undoStack.length > 0} onUndo={() => void handleUndo()} />
        <h1 className="text-xl font-semibold text-ink">{pauseKind === 'lastcard' ? 'Answer saved' : 'Round complete'}</h1>
        <p className="text-ink-muted">
          {pauseKind === 'lastcard'
            ? 'Just this last card left — keep going to see it again.'
            : `${graduated}/${total} card${total === 1 ? '' : 's'} graduated so far. Keep going?`}
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <a href={back} className="btn-ghost">Back</a>
          <button onClick={() => setPaused(false)} className="btn-primary">Continue</button>
        </div>
      </div>
    )
  }

  const ladderLen = Math.max(1, ladder.rungs.length)
  const stepsDone = graduated * ladderLen + queue.reduce((sum, e) => sum + Math.min(states.get(e.cardId)?.rungIndex ?? 0, ladderLen), 0)
  const totalSteps = total * ladderLen
  const remaining = Math.max(1, totalSteps - startStepsRef.current)
  const rawPct = ((stepsDone - startStepsRef.current) / remaining) * 100
  progressPctRef.current = Math.max(progressPctRef.current, Math.max(0, rawPct))
  const pct = Math.round(progressPctRef.current)

  // Distractors come from the current card's own deck.
  const curDeckCards = [...cardsById.values()].filter(c => deckByCard.get(c.id) === currentDeck.id)

  return (
    <div className="space-y-8 max-w-2xl mx-auto">
      <div className="relative flex items-center justify-between">
        <a href={back} className="text-sm text-ink-muted hover:text-ink">✕ End session</a>
        <div className="absolute left-1/2 -translate-x-1/2 text-xs text-ink-muted">{pct}% · {graduated}/{total} graduated</div>
        <div className="text-xs text-ink-muted">Rung {currentClimb.rungIndex + 1} · {RUNG_LABEL[currentRung.type]}</div>
      </div>
      <div className="h-1 bg-surface-raised rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      {category && (
        <p className="text-xs text-accent text-center">
          {category === 'new' ? 'Studying unlearned cards.' : 'Studying cards still in the learning pipeline.'}
        </p>
      )}

      <UndoFab show={undoStack.length > 0} onUndo={() => void handleUndo()} />
      <LadderStudyCard
        key={`${currentId}:${currentClimb.rungIndex}`}
        card={currentCard} rung={currentRung} deckCards={curDeckCards} deckName={currentDeck.name}
        sourceLanguage={currentDeck.sourceLanguage} targetLanguage={currentDeck.targetLanguage} gradingSettings={currentDeck.gradingSettings}
        overrides={overrides} onOverrideAnswer={handleOverrideAnswer} onChoiceEdit={handleChoiceEdit}
        onCardEdit={async (id, side, newText) => {
          const cardRepo = new SupabaseCardRepository()
          const existing = cardsById.get(id)
          if (!existing) return
          if (!newText) {
            await cardRepo.softDelete(id)
            setCardsById(prev => { const m = new Map(prev); m.delete(id); return m })
            setQueue(q => q.filter(x => x.cardId !== id))
            if (currentId === id) setCurrentId(pickNextCard(queue.filter(x => x.cardId !== id), Date.now())?.cardId ?? null)
            return
          }
          if (newText === (side === 'front' ? existing.front : existing.back)) return
          const patch = side === 'front'
            ? { front: newText, audioGenerated: false as const, audioData: null, choices: null }
            : { back: newText, choices: null }
          const updated = await cardRepo.update(id, patch)
          setCardsById(prev => new Map(prev).set(id, updated))
        }}
        onRepeat={handleRepeat}
        onOutcome={onOutcome} onChoicesCached={onChoicesCached} onInfo={() => setInfoOpen(true)}
      />

      {infoOpen && userId && (
        <CardEditModal
          card={currentCard} state={undefined} userId={userId} deckId={currentDeck.id}
          deckCards={curDeckCards} sourceLanguage={currentDeck.sourceLanguage} targetLanguage={currentDeck.targetLanguage}
          onSave={async (id, front, back) => {
            await new SupabaseCardRepository().update(id, { front, back })
            setCardsById(prev => { const c = prev.get(id); return c ? new Map(prev).set(id, { ...c, front, back }) : prev })
          }}
          onCardChange={c => setCardsById(prev => new Map(prev).set(c.id, c))}
          onStateChange={() => {}}
          onDelete={cid => { setCardsById(prev => { const m = new Map(prev); m.delete(cid); return m }); setQueue(q => q.filter(x => x.cardId !== cid)); if (currentId === cid) setCurrentId(pickNextCard(queue.filter(x => x.cardId !== cid), Date.now())?.cardId ?? null); setInfoOpen(false) }}
          onClose={() => setInfoOpen(false)}
          initialShowStats
        />
      )}
    </div>
  )
}
