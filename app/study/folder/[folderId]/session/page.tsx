'use client'

/**
 * Folder-scoped study session — pulls due/new cards from every deck inside
 * a folder (including nested subfolders). Same engine as the all-decks
 * session, just with a folder-scoped queue-builder.
 */

import { Suspense, useEffect, useState, useCallback } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
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
import { prefetchChoices, prefetchAudio, promoteConfusionDistractors, deckSiblings, needsChoices, ensureChoicesGenerated, type PrefetchItem, type ConfusionPromotionItem } from '@/lib/distractors'
import { getToday } from '@/lib/dates'

/** How many slots ahead an "I don't know" card is re-queued to resurface in the same session. */
const IDONTKNOW_REQUEUE_OFFSET = 4
const REPEAT_REQUEUE_OFFSET = 6

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
  /** Marks a copy of a card re-inserted after "I don't know" — used for undo cleanup. */
  idontknow?: true
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/** Cards-per-elective-batch for folder/all sessions (no per-deck pref available). */
const FOLDER_ELECTIVE_LIMIT = 20

type StudyCategory = 'new' | 'learning' | 'graduated' | 'due'

export default function FolderSessionPage() {
  return (
    <Suspense fallback={<div className="text-ink-muted pt-16 text-center">Loading session…</div>}>
      <FolderSessionInner />
    </Suspense>
  )
}

function FolderSessionInner() {
  const router   = useRouter()
  const params   = useParams()
  const folderId = params.folderId as string
  const supabase = createClient()
  const searchParams = useSearchParams()
  const categoryParam = searchParams.get('category')
  const category: StudyCategory | null =
    categoryParam === 'new' || categoryParam === 'learning' || categoryParam === 'graduated' || categoryParam === 'due'
      ? categoryParam : null

  const [queue,           setQueue]           = useState<SessionCard[]>([])
  const [index,           setIndex]           = useState(0)
  const [loading,         setLoading]         = useState(true)
  const [userId,          setUserId]          = useState('')
  const [done,            setDone]            = useState(false)
  const [electiveSession, setElectiveSession] = useState(false)
  const [folder,          setFolder]          = useState<Folder | null>(null)
  const [answerError,     setAnswerError]     = useState<string | null>(null)
  const [submitting,      setSubmitting]      = useState(false)
  /** Persisted typed-answer overrides, keyed by `${cardId}:${answerSide}` -> set of accepted normalized answers. */
  const [overrides,       setOverrides]       = useState<Map<string, Set<string>>>(new Map())
  /** Graduated cards in the 10-minute relearn loop — held out of the main queue until their dueAt passes (or the queue runs out). */
  const [relearnPool,     setRelearnPool]     = useState<SessionCard[]>([])

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

      const [allDecks, allFolders, pipeline, thisFolder, profileData] = await Promise.all([
        deckRepo.list(session.user.id),
        folderRepo.list(session.user.id),
        pipelineRepo.getDefault(),
        folderRepo.get(folderId),
        supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', session.user.id).single(),
      ])
      setFolder(thisFolder)

      const tz           = (profileData.data?.timezone as string | null) ?? 'UTC'
      const turnoverHour = (profileData.data?.day_turnover_hour as number | null) ?? 0

      const deckIds = new Set(descendantDeckIds(folderId, allFolders, allDecks))
      const decks   = allDecks.filter(d => deckIds.has(d.id))

      const now   = new Date()
      const today = getToday(tz, turnoverHour)

      // ?category= elective study: build queue from only that category across
      // all decks in the folder, capped at FOLDER_ELECTIVE_LIMIT cards.
      if (category) {
        const categoryCards: SessionCard[] = []
        for (const deck of decks) {
          const [cards, states] = await Promise.all([
            cardRepo.listByDeck(deck.id),
            stateRepo.listByDeck(session.user.id, deck.id),
          ])
          const stateMap = new Map(states.map(s => [s.cardId, s]))
          const common = { pipeline, gradingSettings: deck.gradingSettings, deckName: deck.name, deckCards: cards, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage }
          for (const card of cards) {
            const state = stateMap.get(card.id)
            if (category === 'new' && !state) {
              categoryCards.push({ ...common, card, state: initialCardState(session.user.id, card.id, pipeline.id), productionMode: null })
            } else if (category === 'learning' && state && !state.graduated) {
              categoryCards.push({ ...common, card, state, productionMode: null })
            } else if (category === 'graduated' && state?.graduated) {
              categoryCards.push({ ...common, card, state, productionMode: decideProductionMode(state, now) })
            } else if (category === 'due' && state?.graduated && state.dueAt && new Date(state.dueAt) <= now) {
              categoryCards.push({ ...common, card, state, productionMode: decideProductionMode(state, now) })
            }
          }
        }
        const finalQueue = shuffle(categoryCards).slice(0, FOLDER_ELECTIVE_LIMIT)
        if (finalQueue.length === 0) { setDone(true); setLoading(false); return }
        setElectiveSession(true)
        setQueue(finalQueue)
        setLoading(false)
        // Background prefetch/promotion (same as normal path below)
        const prefetchItems: PrefetchItem[] = finalQueue.slice(1).map(item => {
          const sortedSteps = [...item.pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
          const step = sortedSteps.find(s => s.stepOrder === item.state.currentStepOrder) ?? sortedSteps[0]!
          if (item.state.graduated || step.stepType !== 'recognition') return null
          return { card: item.card, side: step.answerSide, deckCards: item.deckCards, sourceLanguage: item.sourceLanguage, targetLanguage: item.targetLanguage }
        }).filter((x): x is PrefetchItem => x !== null)
        void prefetchChoices(prefetchItems, handleChoicesCached, 2)
        void prefetchAudio(finalQueue.map(item => ({ card: item.card, sourceLanguage: item.sourceLanguage })), handleAudioCached)
        return
      }

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
      void prefetchChoices(prefetchItems, handleChoicesCached, 2)
      void prefetchAudio(finalQueue.map(item => ({ card: item.card, sourceLanguage: item.sourceLanguage })), handleAudioCached)

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

  // When the main queue runs out, inject the most-elapsed relearn card so the
  // session continues. Cards are sorted by dueAt ASC (soonest due = most of
  // their relearn interval has already elapsed).
  useEffect(() => {
    if (loading || done || index < queue.length) return
    if (relearnPool.length === 0) { setDone(true); return }
    const sorted = [...relearnPool].sort((a, b) =>
      (a.state.dueAt ? new Date(a.state.dueAt).getTime() : 0) -
      (b.state.dueAt ? new Date(b.state.dueAt).getTime() : 0)
    )
    setQueue(prev => [...prev, sorted[0]!])
    setRelearnPool(sorted.slice(1))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue.length, done, loading])

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
      const reviewPromptSide: CardSide = state.graduated ? 'back' : step.promptSide
      const reviewAnswerSide: CardSide = state.graduated ? 'front' : step.answerSide

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
        const confusedWithCardId = reviewAnswerSide === 'front'
          ? deckCards.find(c => c.front.trim().toLowerCase() === userAnswer.trim().toLowerCase())?.id ?? null
          : deckCards.find(c => c.back.trim().toLowerCase()  === userAnswer.trim().toLowerCase())?.id ?? null
        const isWordMixup = step.stepType !== 'typing'
          || isDifferentWordMistake(userAnswer, reviewAnswerSide === 'front' ? card.front : card.back, gradingSettings ?? DEFAULT_GRADING_SETTINGS)
        new SupabaseCardConfusionRepository().record(card.id, userAnswer.trim(), reviewAnswerSide, isWordMixup, confusedWithCardId)
          .catch(err => console.error('Failed to record card confusion:', err))
      }

      const nowDate    = new Date()
      const reviewMode = classifyReviewMode(state, nowDate)
      const wasTyped   = state.graduated ? productionMode === 'typed' : null

      await eventRepo.create({
        userId: userId, cardId: card.id, mode: step.stepType,
        promptSide: reviewPromptSide, answerSide: reviewAnswerSide,
        promptShown: reviewPromptSide === 'front' ? card.front : card.back,
        expected:    reviewAnswerSide === 'front' ? card.front : card.back,
        userAnswer, wasCorrect, rating, responseMs: null,
        reviewMode, wasTyped,
      })

      const wrongSeverity = !wasCorrect && (step.stepType === 'typing' || wasTyped)
        ? classifyWrongAnswer(userAnswer, reviewAnswerSide === 'front' ? card.front : card.back, gradingSettings ?? DEFAULT_GRADING_SETTINGS)
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

      // 10-minute "Again" relearn loop: hold the card in the relearn pool until
      // its dueAt passes. The pool-injection useEffect above reintroduces it
      // once the main queue runs out, ordered by elapsed percentage.
      if (newState.graduated && newState.relearningStep > 0) {
        const requeued: SessionCard = { ...current, state: newState, productionMode: decideProductionMode(newState, nowDate) }
        setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: newState } : item))
        setRelearnPool(prev => [...prev, requeued])
        setIndex(i => i + 1)
        return
      }

      setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: newState } : item))
      if (index + 1 < queue.length || relearnPool.length > 0) {
        setIndex(i => i + 1)
      } else {
        setDone(true)
      }
    } catch (err: unknown) {
      console.error('Failed to record answer:', err)
      setAnswerError(err instanceof Error ? err.message : 'Something went wrong saving your answer. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [queue, index, userId, submitting, relearnPool])

  const handleIDontKnow = useCallback(async () => {
    const current = queue[index]
    if (!current || submitting) return
    setSubmitting(true)
    setAnswerError(null)
    try {
      const { card, state, pipeline, gradingSettings, productionMode } = current
      const stateRepo  = new SupabaseCardStateRepository()
      const eventRepo  = new SupabaseReviewEventRepository()
      const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
      const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!
      const reviewPromptSide: CardSide = state.graduated ? 'back' : step.promptSide
      const reviewAnswerSide: CardSide = state.graduated ? 'front' : step.answerSide
      const nowDate    = new Date()
      const reviewMode = classifyReviewMode(state, nowDate)
      const prevState  = { ...state }
      let newState = state
      const penaltyCount = state.graduated ? 1 : 3
      for (let i = 0; i < penaltyCount; i++) {
        await eventRepo.create({
          userId: userId, cardId: card.id, mode: step.stepType,
          promptSide: reviewPromptSide, answerSide: reviewAnswerSide,
          promptShown: reviewPromptSide === 'front' ? card.front : card.back,
          expected:    reviewAnswerSide === 'front' ? card.front : card.back,
          userAnswer: '', wasCorrect: false, rating: 'again', responseMs: null,
          reviewMode, wasTyped: state.graduated ? productionMode === 'typed' : null,
        })
        newState = progressAfterReview(newState, pipeline, { wasCorrect: false, rating: 'again', wrongSeverity: undefined, wasTyped: false }, nowDate)
      }
      const counted = { ...newState, iDontKnowCount: (prevState.iDontKnowCount ?? 0) + 1 }
      await stateRepo.upsert(counted)
      const requeued: SessionCard = { ...current, state: counted, idontknow: true }
      if (counted.graduated && counted.relearningStep > 0) {
        // Graduated card entered relearn loop — hold in pool until timer elapses
        setQueue(prev => prev.map((item, i) => i === index ? { ...current, state: counted } : item))
        setRelearnPool(prev => [...prev, requeued])
      } else {
        // Pre-graduation or relapsed back into pipeline — reinsert ahead in queue
        setQueue(prev => {
          const next = [...prev]
          next[index] = { ...current, state: counted }
          const insertPos = Math.min(index + 1 + IDONTKNOW_REQUEUE_OFFSET, next.length)
          next.splice(insertPos, 0, requeued)
          return next
        })
      }
    } catch (err: unknown) {
      console.error('Failed to record I don\'t know:', err)
      setAnswerError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [queue, index, userId, submitting])

  const handleSiblingAnswered = useCallback(async (siblingCardId: string) => {
    const current = queue[index]
    if (!current) return
    const { pipeline, deckCards } = current
    const siblingCard = deckCards.find(c => c.id === siblingCardId)
    if (!siblingCard) return
    try {
      const stateRepo = new SupabaseCardStateRepository()
      const eventRepo = new SupabaseReviewEventRepository()
      const nowDate   = new Date()
      const existing  = await stateRepo.get(userId, siblingCardId)
      const state     = existing ?? initialCardState(userId, siblingCardId, pipeline.id)
      const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
      const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!
      const reviewMode = classifyReviewMode(state, nowDate)
      await eventRepo.create({
        userId, cardId: siblingCardId, mode: step.stepType,
        promptSide: 'back', answerSide: 'front',
        promptShown: siblingCard.back, expected: siblingCard.front,
        userAnswer: siblingCard.front, wasCorrect: true, rating: 'good', responseMs: null,
        reviewMode, wasTyped: true,
      })
      const newState = progressAfterReview(state, pipeline, { wasCorrect: true, rating: 'good', wrongSeverity: undefined, wasTyped: false }, nowDate)
      await stateRepo.upsert(newState)
      setQueue(prev => prev.map(item => item.card.id === siblingCardId ? { ...item, state: newState } : item))
    } catch (err) {
      console.error('Failed to credit sibling card:', err)
    }
  }, [queue, index, userId])

  const handleResetCard = useCallback(() => {
    const current = queue[index]
    if (!current) return
    const stateRepo = new SupabaseCardStateRepository()
    const fresh = initialCardState(userId, current.card.id, current.pipeline.id)
    stateRepo.upsert(fresh).catch(console.error)
    setIndex(i => i + 1)
  }, [queue, index, userId])

  const handleRepeat = useCallback(() => {
    const current = queue[index]
    if (!current) return
    const insertAt = Math.min(index + 1 + REPEAT_REQUEUE_OFFSET, queue.length)
    setQueue(prev => {
      const next = [...prev]
      next.splice(insertAt, 0, { ...current })
      return next
    })
    handleAnswer('good', true, '')
  }, [queue, index, handleAnswer])


  const handleChoicesCached = useCallback((cardId: string, choices: Card['choices']) => {
    setQueue(prev => prev.map(item => {
      if (item.card.id !== cardId) return item
      const card = { ...item.card, choices }
      return { ...item, card, deckCards: item.deckCards.map(c => c.id === cardId ? card : c) }
    }))
  }, [])

  const handleAudioCached = useCallback((cardId: string, audioData: string) => {
    setQueue(prev => prev.map(item => {
      if (item.card.id !== cardId) return item
      const card = { ...item.card, audioGenerated: true, audioData }
      return { ...item, card, deckCards: item.deckCards.map(c => c.id === cardId ? card : c) }
    }))
  }, [])

  const handlePromptEdit = useCallback(async (cardId: string, promptSide: 'front' | 'back', newText: string) => {
    const cardRepo = new SupabaseCardRepository()
    if (!newText) {
      await cardRepo.softDelete(cardId)
      setQueue(prev => prev.filter(it => it.card.id !== cardId))
      return
    }
    const currentItem = queue.find(it => it.card.id === cardId)
    if (!currentItem) return
    if (newText === (promptSide === 'front' ? currentItem.card.front : currentItem.card.back)) return
    const patch = promptSide === 'front'
      ? { front: newText, audioGenerated: false as const, audioData: null }
      : { back: newText }
    const updated = await cardRepo.update(cardId, patch)
    setQueue(prev => prev.map(it => ({
      ...it,
      card:      it.card.id === cardId ? updated : it.card,
      deckCards: it.deckCards.map(c => c.id === cardId ? updated : c),
    })))
    if (promptSide === 'front') {
      void prefetchAudio([{ card: updated, sourceLanguage: currentItem.sourceLanguage }], handleAudioCached)
    }
  }, [queue, handleAudioCached])

  const handleChoiceEdit = useCallback(async (cardId: string, answerSide: CardSide, originalChoice: string, newText: string, isCorrect: boolean) => {
    const cardRepo = new SupabaseCardRepository()
    const currentItem = queue.find(it => it.card.id === cardId)
    if (!currentItem) return
    const card = currentItem.card
    let updated: typeof card
    if (isCorrect) {
      const patch = answerSide === 'front' ? { front: newText } : { back: newText }
      updated = await cardRepo.update(cardId, patch)
    } else {
      const existing = card.choices ?? { front: [], back: [], frontSynonyms: [], backSynonyms: [] }
      const newPool = !newText
        ? (existing[answerSide] ?? []).filter((d: string) => d !== originalChoice)
        : (existing[answerSide] ?? []).map((d: string) => d === originalChoice ? newText : d)
      updated = await cardRepo.update(cardId, { choices: { ...existing, [answerSide]: newPool } })
      if (needsChoices(updated, answerSide)) {
        void ensureChoicesGenerated(updated, answerSide, currentItem.deckCards, currentItem.sourceLanguage, currentItem.targetLanguage)
          .then(ai => { if (ai) handleChoicesCached(cardId, ai) })
      }
    }
    setQueue(prev => prev.map(it => ({
      ...it,
      card:      it.card.id === cardId ? updated : it.card,
      deckCards: it.deckCards.map(c => c.id === cardId ? updated : c),
    })))
  }, [queue, handleChoicesCached])

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading session…</div>

  const backHref = folder ? `/library/${folder.id}` : '/library'

  if (done) {
    const CATEGORY_LABELS: Record<StudyCategory, string> = { new: 'Unlearned', learning: 'Learning', graduated: 'Graduated', due: 'Due Now' }
    return (
      <div className="max-w-md mx-auto pt-20 text-center space-y-6">
        <div className="text-5xl">🎉</div>
        <h2 className="text-2xl font-semibold text-ink">Session complete!</h2>
        <p className="text-ink-muted">
          You reviewed {queue.length} card{queue.length !== 1 ? 's' : ''}
          {folder ? ` in ${folder.name}` : ''}.
        </p>
        <div className="flex gap-3 justify-center flex-wrap">
          <Link href={backHref} className="btn-primary">Back to library</Link>
          {electiveSession && category && (
            <button
              onClick={() => router.push(`/study/folder/${folderId}/session?category=${category}`)}
              className="btn-ghost"
            >
              Study ahead ({CATEGORY_LABELS[category]})
            </button>
          )}
        </div>
      </div>
    )
  }

  const current = queue[index]
  if (!current) return null // pool-injection useEffect will add a card momentarily
  const { card, state, pipeline, gradingSettings, deckName, deckCards, sourceLanguage, targetLanguage } = current
  const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!
  const reviewPromptSide: CardSide = state.graduated ? 'back' : step.promptSide
  const reviewAnswerSide: CardSide = state.graduated ? 'front' : step.answerSide
  const stepWillComplete = !state.graduated && state.correctInStep + 1 >= step.requiredCorrect

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
      {electiveSession && category && (
        <p className="text-xs text-accent text-center">
          {category === 'new' ? 'Studying unlearned cards.' : category === 'learning' ? 'Studying cards in the learning pipeline.' : category === 'graduated' ? 'Studying graduated cards.' : 'Studying cards due now.'}
        </p>
      )}
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
          autoPlayAudio={gradingSettings.autoPlayAudio ?? true}
          splitGlossFromBack={step.answerSide === 'back'}
          onChoicesCached={handleChoicesCached}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onRepeat={handleRepeat}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${step.answerSide}`) ?? [])}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, step.answerSide, answerText, accept)}
          onPromptEdit={t => handlePromptEdit(card.id, step.promptSide, t)}
          onChoiceEdit={(orig, newText, isCorrect) => handleChoiceEdit(card.id, step.answerSide, orig, newText, isCorrect)} />
      ) : !state.graduated ? (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          promptLanguage={step.promptSide === 'front' ? sourceLanguage : undefined}
          answerLanguage={step.promptSide === 'back' ? sourceLanguage : targetLanguage}
          gradingSettings={gradingSettings} autoPlayAudio={gradingSettings.autoPlayAudio ?? true} gradedReview={false} deckName={deckName}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${step.answerSide}`) ?? [])}
          synonyms={step.answerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
          deckSiblings={deckSiblings(card, step.answerSide, deckCards)}
          onSiblingAnswered={handleSiblingAnswered}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, step.answerSide, answerText, accept)}
          onRepeat={handleRepeat}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)}
          onPromptEdit={t => handlePromptEdit(card.id, step.promptSide, t)} />
      ) : current.productionMode === 'self-graded' ? (
        <FlashcardMode key={`${card.id}-${index}`} card={card} promptSide={reviewPromptSide} deckName={deckName}
          onRate={rating => handleAnswer(rating, rating !== 'again')} />
      ) : (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={reviewPromptSide}
          promptLanguage={reviewPromptSide === 'front' ? sourceLanguage : undefined}
          answerLanguage={reviewPromptSide === 'back' ? sourceLanguage : targetLanguage}
          gradingSettings={gradingSettings} autoPlayAudio={gradingSettings.autoPlayAudio ?? true} gradedReview={true} deckName={deckName}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${reviewAnswerSide}`) ?? [])}
          synonyms={reviewAnswerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
          deckSiblings={deckSiblings(card, reviewAnswerSide, deckCards)}
          onSiblingAnswered={handleSiblingAnswered}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, reviewAnswerSide, answerText, accept)}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)}
          onPromptEdit={t => handlePromptEdit(card.id, reviewPromptSide, t)}
          onResetCard={handleResetCard} />
      )}
    </div>
  )
}
