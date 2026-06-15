'use client'

/**
 * Folder-scoped study session — pulls due/new cards from every deck inside
 * a folder (including nested subfolders). Same engine as the all-decks
 * session, just with a folder-scoped queue-builder.
 */

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }        from '@/lib/data/decks'
import { SupabaseCardRepository }        from '@/lib/data/cards'
import { SupabaseCardStateRepository }   from '@/lib/data/cardStates'
import { SupabaseReviewEventRepository } from '@/lib/data/reviewEvents'
import { SupabasePipelineRepository }    from '@/lib/data/pipelines'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { SupabaseCardConfusionRepository }   from '@/lib/data/cardConfusions'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import type { CardSide } from '@/domain'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { descendantDeckIds } from '@/lib/folderStats'
import { progressAfterReview, initialCardState } from '@/engine/pipeline'
import { classifyWrongAnswer, isDifferentWordMistake } from '@/engine/grading'
import { smoothDueDate } from '@/engine/density'
import { scheduleNext, classifyReviewMode } from '@/engine/scheduler'
import { decideProductionMode, type ProductionMode } from '@/engine/productionMode'
import type { Card, CardState, Pipeline, Rating, GradingSettings, Folder, CardConfusion } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS, DEFAULT_GRADING_SETTINGS } from '@/domain'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { TypingMode } from '@/components/session/TypingMode'
import { MultipleChoiceMode } from '@/components/session/MultipleChoiceMode'
import { prefetchChoices, promoteConfusionDistractors, type PrefetchItem, type ConfusionPromotionItem } from '@/lib/distractors'

/** How many slots ahead a graduated card is re-queued after starting the 10-minute relearn loop. */
const RELEARN_REQUEUE_OFFSET = 3

interface SessionCard {
  card:            Card
  state:           CardState
  pipeline:        Pipeline
  gradingSettings: GradingSettings
  deckName:        string
  deckCards:       Card[]
  sourceLanguage:  string
  targetLanguage:  string
  /** For graduated cards: whether this review should use typed or self-graded production. Null pre-graduation. */
  productionMode:  ProductionMode | null
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

export default function FolderSessionPage() {
  const router   = useRouter()
  const params   = useParams()
  const folderId = params.folderId as string
  const supabase = createClient()
  const [queue,      setQueue]      = useState<SessionCard[]>([])
  const [index,      setIndex]      = useState(0)
  const [loading,    setLoading]    = useState(true)
  const [userId,     setUserId]     = useState('')
  const [done,       setDone]       = useState(false)
  const [folder,     setFolder]     = useState<Folder | null>(null)
  const [answerError, setAnswerError] = useState<string | null>(null)
  const [submitting,  setSubmitting]  = useState(false)
  /** Persisted typed-answer overrides, keyed by `${cardId}:${answerSide}` -> set of accepted normalized answers. */
  const [overrides,   setOverrides]   = useState<Map<string, Set<string>>>(new Map())

  const handleOverrideAnswer = useCallback((cardId: string, answerSide: CardSide, answerText: string, accept: boolean) => {
    const repo = new SupabaseTypedAnswerOverrideRepository()
    const key  = `${cardId}:${answerSide}`
    setOverrides(prev => {
      const next = new Map(prev)
      const set  = new Set(next.get(key) ?? [])
      if (accept) set.add(answerText)
      else set.delete(answerText)
      next.set(key, set)
      return next
    })
    const op = accept ? repo.add(userId, cardId, answerSide, answerText) : repo.remove(userId, cardId, answerSide, answerText)
    op.catch(err => console.error('Failed to save typed-answer override:', err))
  }, [userId])

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/auth'); return }
      setUserId(session.user.id)

      const existingOverrides = await new SupabaseTypedAnswerOverrideRepository().listForUser(session.user.id)
      const overrideMap = new Map<string, Set<string>>()
      for (const o of existingOverrides) {
        const key = `${o.cardId}:${o.answerSide}`
        const set = overrideMap.get(key) ?? new Set<string>()
        set.add(o.answerText)
        overrideMap.set(key, set)
      }
      setOverrides(overrideMap)

      const deckRepo     = new SupabaseDeckRepository()
      const cardRepo     = new SupabaseCardRepository()
      const stateRepo    = new SupabaseCardStateRepository()
      const pipelineRepo = new SupabasePipelineRepository()
      const prefRepo     = new SupabaseDeckPreferencesRepository()
      const folderRepo   = new SupabaseFolderRepository()

      const [allDecks, allFolders, pipeline, thisFolder] = await Promise.all([
        deckRepo.list(session.user.id),
        folderRepo.list(session.user.id),
        pipelineRepo.getDefault(),
        folderRepo.get(folderId),
      ])
      setFolder(thisFolder)

      const deckIds = new Set(descendantDeckIds(folderId, allFolders, allDecks))
      const decks   = allDecks.filter(d => deckIds.has(d.id))

      const now   = new Date()
      const today = now.toISOString().slice(0, 10)
      const allCards: SessionCard[] = []

      for (const deck of decks) {
        const [cards, states, prefs] = await Promise.all([
          cardRepo.listByDeck(deck.id),
          stateRepo.listByDeck(session.user.id, deck.id),
          prefRepo.get(session.user.id, deck.id),
        ])

        const stateMap = new Map(states.map(s => [s.cardId, s]))
        const cardsPerSession = prefs?.cardsPerSession ?? null

        let newCardBudget: number
        if (cardsPerSession && cardsPerSession > 0) {
          const inPipelineTotal = states.filter(s => !s.graduated).length
          newCardBudget = Math.max(0, Math.min(cardsPerSession, cards.length) - inPipelineTotal)
        } else {
          const dailyLimit = Math.min(
            prefs ? prefRepo.effectiveDailyLimit(prefs) : DEFAULT_DAILY_NEW_CARDS,
            cards.length,
          )
          const introducedToday = states.filter(s => s.introducedDate === today).length
          newCardBudget = Math.max(0, dailyLimit - introducedToday)
        }

        for (const card of cards) {
          const state = stateMap.get(card.id)

          const common = {
            card,
            pipeline,
            gradingSettings: deck.gradingSettings,
            deckName:        deck.name,
            deckCards:       cards,
            sourceLanguage:  deck.sourceLanguage,
            targetLanguage:  deck.targetLanguage,
          }

          if (!state) {
            // New card — only include if under daily limit
            if (newCardBudget <= 0) continue
            newCardBudget--
            allCards.push({ ...common, state: initialCardState(session.user.id, card.id, pipeline.id), productionMode: null })
          } else if (!state.graduated) {
            // In pipeline — always include
            allCards.push({ ...common, state, productionMode: null })
          } else if (state.dueAt && new Date(state.dueAt) <= now) {
            // Graduated and due
            allCards.push({ ...common, state, productionMode: decideProductionMode(state, now) })
          }
        }
      }

      if (allCards.length === 0) { setDone(true); setLoading(false); return }

      // Shuffle all seen cards; keep new cards in order at the start
      const newCards  = allCards.filter(c => !c.state.lastReviewedAt)
      const seenCards = shuffle(allCards.filter(c => c.state.lastReviewedAt))
      const finalQueue = [...newCards, ...seenCards]
      setQueue(finalQueue)
      setLoading(false)

      // Pre-generate multiple-choice distractors for upcoming recognition
      // steps in the background, so cards rarely show "Loading choices…".
      // Skip index 0 — that card's own component will fetch on mount.
      const prefetchItems: PrefetchItem[] = finalQueue
        .slice(1)
        .map(item => {
          const sortedSteps = [...item.pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
          const step = sortedSteps.find(s => s.stepOrder === item.state.currentStepOrder) ?? sortedSteps[0]!
          if (item.state.graduated || step.stepType !== 'recognition') return null
          return { card: item.card, side: step.answerSide, deckCards: item.deckCards, sourceLanguage: item.sourceLanguage, targetLanguage: item.targetLanguage }
        })
        .filter((x): x is PrefetchItem => x !== null)
      void prefetchChoices(prefetchItems, handleChoicesCached)

      // Promote frequently-confused words into cached distractors for
      // upcoming recognition steps (all of them — this is cheap, no AI
      // calls), so the next time these cards come up the mix-up is offered
      // as one of the options.
      const confusions = await new SupabaseCardConfusionRepository().listForUser(session.user.id)
      const confusionsByCard = new Map<string, CardConfusion[]>()
      for (const c of confusions) {
        const arr = confusionsByCard.get(c.cardId) ?? []
        arr.push(c)
        confusionsByCard.set(c.cardId, arr)
      }
      const promotionItems: ConfusionPromotionItem[] = finalQueue
        .map(item => {
          const sortedSteps = [...item.pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
          const step = sortedSteps.find(s => s.stepOrder === item.state.currentStepOrder) ?? sortedSteps[0]!
          if (item.state.graduated || step.stepType !== 'recognition') return null
          return { card: item.card, side: step.answerSide }
        })
        .filter((x): x is ConfusionPromotionItem => x !== null)
      void promoteConfusionDistractors(promotionItems, confusionsByCard, handleChoicesCached)
    }
    load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAnswer = useCallback(async (rating: Rating, wasCorrect: boolean, userAnswer = '') => {
    const current = queue[index]
    if (!current) return
    if (submitting) return

    setSubmitting(true)
    setAnswerError(null)

    try {
      const { card, state, pipeline, gradingSettings, productionMode, deckCards } = current
      const stateRepo  = new SupabaseCardStateRepository()
      const eventRepo  = new SupabaseReviewEventRepository()
      const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
      const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!

      // Confusion tracking: record every wrong answer (multiple-choice pick
      // or typed response, in either direction) so it can be surfaced later
      // as easily-confused vocabulary, and — for word-level mix-ups —
      // promoted into multiple-choice distractors once they recur (see
      // lib/distractors.ts: promoteConfusionDistractor). `answerSide` tells
      // us which side of the card the learner was asked to produce — look
      // up a possible "confused with" card on that same side. A
      // multiple-choice pick is always a real word; a typed answer only
      // counts as a word-level mix-up if it's not just a close typo.
      if (!wasCorrect && userAnswer.trim()) {
        const confusedWithCardId = step.answerSide === 'front'
          ? deckCards.find(c => c.front.trim().toLowerCase() === userAnswer.trim().toLowerCase())?.id ?? null
          : deckCards.find(c => c.back.trim().toLowerCase()  === userAnswer.trim().toLowerCase())?.id ?? null
        const isWordMixup = step.stepType !== 'typing'
          || isDifferentWordMistake(userAnswer, step.answerSide === 'front' ? card.front : card.back, gradingSettings ?? DEFAULT_GRADING_SETTINGS)
        new SupabaseCardConfusionRepository().record(card.id, userAnswer.trim(), step.answerSide, isWordMixup, confusedWithCardId)
          .catch(err => console.error('Failed to record card confusion:', err))
      }

      const nowDate    = new Date()
      const reviewMode = classifyReviewMode(state, nowDate)
      const wasTyped   = state.graduated ? productionMode === 'typed' : null

      await eventRepo.create({
        userId: userId, cardId: card.id, mode: step.stepType,
        promptSide: step.promptSide, answerSide: step.answerSide,
        promptShown: step.promptSide === 'front' ? card.front : card.back,
        expected:    step.answerSide === 'front' ? card.front : card.back,
        userAnswer, wasCorrect, rating, responseMs: null,
        reviewMode, wasTyped,
      })

      const wrongSeverity = !wasCorrect && (step.stepType === 'typing' || wasTyped)
        ? classifyWrongAnswer(userAnswer, step.answerSide === 'front' ? card.front : card.back, gradingSettings ?? DEFAULT_GRADING_SETTINGS)
        : undefined

      // Computed independently (same `nowDate`) so the density-smoothing
      // window matches exactly what progressAfterReview just applied.
      const scheduled = state.graduated ? scheduleNext(state, rating, { now: nowDate, wrongSeverity }) : null

      let newState = progressAfterReview(state, pipeline, { wasCorrect, rating, wrongSeverity, wasTyped: wasTyped ?? false }, nowDate)

      if (
        newState.graduated && newState.dueAt && scheduled &&
        !scheduled.noChange && !scheduled.relearn && scheduled.relearningStep === 0 &&
        scheduled.smoothMinDays != null && scheduled.smoothMaxDays != null &&
        scheduled.intervalDays >= 7
      ) {
        const smoothed = await smoothDueDate(userId, newState.dueAt, scheduled.smoothMinDays, scheduled.smoothMaxDays, scheduled.intervalDays, stateRepo)
        newState = { ...newState, dueAt: smoothed }
      }

      await stateRepo.upsert(newState)

      // 10-minute "Again" relearn loop: re-queue the card a few slots ahead so
      // it resurfaces later in this session (dueAt is also set to +10min, so
      // it'll come back due if the session ends first).
      if (newState.graduated && newState.relearningStep > 0) {
        const requeued: SessionCard = { ...current, state: newState, productionMode: decideProductionMode(newState, nowDate) }
        setQueue(prev => {
          const next = [...prev]
          next[index] = { ...current, state: newState }
          const insertPos = Math.min(index + 1 + RELEARN_REQUEUE_OFFSET, next.length)
          next.splice(insertPos, 0, requeued)
          return next
        })
        setIndex(i => i + 1)
        return
      }

      if (index + 1 >= queue.length) setDone(true)
      else {
        setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: newState } : item))
        setIndex(i => i + 1)
      }
    } catch (err: unknown) {
      console.error('Failed to record answer:', err)
      setAnswerError(err instanceof Error ? err.message : 'Something went wrong saving your answer. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [queue, index, userId, submitting])

  const handleChoicesCached = useCallback((cardId: string, choices: Card['choices']) => {
    setQueue(prev => prev.map(item => {
      if (item.card.id !== cardId) return item
      const card = { ...item.card, choices }
      return { ...item, card, deckCards: item.deckCards.map(c => c.id === cardId ? card : c) }
    }))
  }, [])

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading session…</div>

  const backHref = folder ? `/library/${folder.id}` : '/library'

  if (done) {
    return (
      <div className="max-w-md mx-auto pt-20 text-center space-y-6">
        <div className="text-5xl">🎉</div>
        <h2 className="text-2xl font-semibold text-ink">Session complete!</h2>
        <p className="text-ink-muted">
          You reviewed {queue.length} card{queue.length !== 1 ? 's' : ''}
          {folder ? ` in ${folder.name}` : ''}.
        </p>
        <Link href={backHref} className="btn-primary inline-block">Back to library</Link>
      </div>
    )
  }

  const current = queue[index]!
  const { card, state, pipeline, gradingSettings, deckName, deckCards, sourceLanguage, targetLanguage } = current
  const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!

  return (
    <div className="space-y-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between">
        <Link href={backHref} className="text-sm text-ink-muted hover:text-ink">✕ End session</Link>
        <div className="text-xs text-ink-muted">{index + 1} / {queue.length}</div>
        <div className="text-xs text-ink-muted">{state.graduated ? 'Review' : `Step ${state.currentStepOrder + 1} · ${step.stepType}`}</div>
      </div>
      <div className="h-1 bg-surface-raised rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full transition-all duration-300"
          style={{ width: `${Math.round((index / queue.length) * 100)}%` }} />
      </div>
      {answerError && (
        <div className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger flex items-center justify-between gap-3">
          <span>Couldn&apos;t save your answer: {answerError}</span>
          <button onClick={() => setAnswerError(null)} className="text-danger/70 hover:text-danger text-xs underline shrink-0">
            Dismiss
          </button>
        </div>
      )}
      {!state.graduated && step.stepType === 'recognition' ? (
        <MultipleChoiceMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide} answerSide={step.answerSide}
          deckCards={deckCards} sourceLanguage={sourceLanguage} targetLanguage={targetLanguage} deckName={deckName}
          onChoicesCached={handleChoicesCached}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      ) : !state.graduated ? (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          gradingSettings={gradingSettings} gradedReview={false} deckName={deckName}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${step.answerSide}`) ?? [])}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, step.answerSide, answerText, accept)}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      ) : current.productionMode === 'self-graded' ? (
        <FlashcardMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide} deckName={deckName}
          onRate={rating => handleAnswer(rating, rating !== 'again')} />
      ) : (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          gradingSettings={gradingSettings} gradedReview={true} deckName={deckName}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${step.answerSide}`) ?? [])}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, step.answerSide, answerText, accept)}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      )}
    </div>
  )
}
