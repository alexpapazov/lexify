'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }            from '@/lib/data/decks'
import { SupabaseCardRepository }            from '@/lib/data/cards'
import { SupabaseCardStateRepository }       from '@/lib/data/cardStates'
import { SupabaseReviewEventRepository }     from '@/lib/data/reviewEvents'
import { SupabasePipelineRepository }        from '@/lib/data/pipelines'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { SupabaseCardConfusionRepository }   from '@/lib/data/cardConfusions'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import type { CardSide } from '@/domain'
import { progressAfterReview, initialCardState } from '@/engine/pipeline'
import { classifyWrongAnswer, isDifferentWordMistake } from '@/engine/grading'
import { smoothDueDate } from '@/engine/density'
import { scheduleNext, classifyReviewMode } from '@/engine/scheduler'
import { decideProductionMode, type ProductionMode } from '@/engine/productionMode'
import type { Card, CardState, Pipeline, Rating, GradingSettings, CardConfusion } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS, DEFAULT_GRADING_SETTINGS } from '@/domain'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { TypingMode } from '@/components/session/TypingMode'
import { MultipleChoiceMode } from '@/components/session/MultipleChoiceMode'
import { prefetchChoices, promoteConfusionDistractors, type PrefetchItem, type ConfusionPromotionItem } from '@/lib/distractors'
import { getToday } from '@/lib/dates'

/** How many slots ahead a graduated card is re-queued after starting the 10-minute relearn loop. */
const RELEARN_REQUEUE_OFFSET = 3
/** How many slots ahead an "I don't know" card is re-queued to resurface in the same session. */
const IDONTKNOW_REQUEUE_OFFSET = 4

interface SessionCard {
  card: Card
  state: CardState
  pipeline: Pipeline
  /** For graduated cards: whether this review should use typed or self-graded production. Null pre-graduation. */
  productionMode: ProductionMode | null
  /** Marks a copy of a card re-inserted after "I don't know" — used for undo cleanup. */
  idontknow?: true
}

/** A single elective study category, chosen either via a deck-stat "Study" button (?category=) or the elective picker. */
type StudyCategory = 'new' | 'learning' | 'graduated' | 'due'

/** Cards available for elective study once the normal due/new queue is empty, offered via a picker. */
interface ElectivePickerData {
  unlearned:  SessionCard[]
  earlyReview: SessionCard[]
}

const CATEGORY_BANNER: Record<StudyCategory, string> = {
  new:       'Studying unlearned cards electively.',
  learning:  'Studying cards still in the learning pipeline.',
  graduated: 'Studying graduated cards for early review.',
  due:       'Studying cards that are due now.',
}

const CATEGORY_EMPTY_MESSAGE: Record<StudyCategory, string> = {
  new:       'You have no unlearned cards in this deck.',
  learning:  'You have no cards currently in the learning pipeline.',
  graduated: 'You have no graduated cards yet.',
  due:       'You have no cards due right now.',
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

// ─── Session ─────────────────────────────────────────────────────────────────

export default function SessionPage() {
  const { deckId } = useParams<{ deckId: string }>()
  const router     = useRouter()
  const searchParams = useSearchParams()
  const supabase   = createClient()

  // ?category=new|learning|graduated|due — set by the per-stat "Study" buttons
  // on the deck detail page to study only that category, bypassing the
  // normal new/due queue-building below entirely.
  const categoryParam = searchParams.get('category')
  const category: StudyCategory | null =
    categoryParam === 'new' || categoryParam === 'learning' || categoryParam === 'graduated' || categoryParam === 'due'
      ? categoryParam
      : null

  const [queue,           setQueue]           = useState<SessionCard[]>([])
  const [allCards,        setAllCards]        = useState<Card[]>([])
  const [index,           setIndex]           = useState(0)
  const [loading,         setLoading]         = useState(true)
  const [userId,          setUserId]          = useState('')
  const [deckName,        setDeckName]        = useState('')
  const [sourceLanguage,  setSourceLanguage]  = useState('es')
  const [targetLanguage,  setTargetLanguage]  = useState('en')
  const [gradingSettings, setGradingSettings] = useState<GradingSettings | null>(null)
  const [done,            setDone]            = useState(false)
  const [emptySession,    setEmptySession]    = useState(false)
  const [electiveSession, setElectiveSession] = useState(false)
  const [cardStates,      setCardStates]      = useState<Map<string, CardState>>(new Map())
  const [answerError,     setAnswerError]     = useState<string | null>(null)
  const [submitting,      setSubmitting]      = useState(false)
  // When the normal new/due queue is empty (and no ?category= was given),
  // offer a picker to elect into studying unlearned and/or not-yet-due
  // graduated ("early review") cards instead of auto-starting.
  const [showElectivePicker, setShowElectivePicker] = useState(false)
  const [electivePickerData, setElectivePickerData] = useState<ElectivePickerData | null>(null)
  /** Cards not yet shown in this elective batch — available for "Study ahead". */
  const [remainingElective, setRemainingElective] = useState<SessionCard[]>([])
  /** Computed from deck prefs: null = no cap, positive = cap at that number. Default 20. */
  const [electiveBatchLimit, setElectiveBatchLimit] = useState<number | null>(20)
  /** Persisted typed-answer overrides, keyed by `${cardId}:${answerSide}` -> set of accepted normalized answers. */
  const [overrides,       setOverrides]       = useState<Map<string, Set<string>>>(new Map())
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

  const handleChoicesCached = useCallback((cardId: string, choices: Card['choices']) => {
    setAllCards(prev => prev.map(c => c.id === cardId ? { ...c, choices } : c))
    setQueue(prev => prev.map(item => item.card.id === cardId ? { ...item, card: { ...item.card, choices } } : item))
  }, [])

  /**
   * Commits a built queue (from the normal new/due flow, a ?category=
   * elective queue, or the elective picker) and kicks off the same
   * background prefetch/confusion-promotion work the normal flow does.
   * `ctx` is passed explicitly rather than read from state, since this can
   * run mid-`load()` before `setAllCards`/`setUserId`/etc. have flushed.
   */
  const finalizeQueue = useCallback(async (
    finalQueue: SessionCard[],
    ctx: { deckCards: Card[]; sourceLanguage: string; targetLanguage: string; userId: string },
  ) => {
    if (finalQueue.length === 0) { setEmptySession(true); setDone(true); setLoading(false); return }
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
        return { card: item.card, side: step.answerSide, deckCards: ctx.deckCards, sourceLanguage: ctx.sourceLanguage, targetLanguage: ctx.targetLanguage }
      })
      .filter((x): x is PrefetchItem => x !== null)
    void prefetchChoices(prefetchItems, handleChoicesCached)

    // Promote frequently-confused words into cached distractors for
    // upcoming recognition steps (all of them — this is cheap, no AI calls).
    const confusions = await new SupabaseCardConfusionRepository().listForUser(ctx.userId)
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
  }, [handleChoicesCached])

  /** User picked categories in the elective picker — build and start that queue. */
  const startElectiveSession = useCallback((selected: { unlearned: boolean; earlyReview: boolean }) => {
    if (!electivePickerData) return
    const combined = shuffle([
      ...(selected.unlearned   ? electivePickerData.unlearned   : []),
      ...(selected.earlyReview ? electivePickerData.earlyReview : []),
    ])
    const batch = electiveBatchLimit != null ? combined.slice(0, electiveBatchLimit) : combined
    const rest  = electiveBatchLimit != null ? combined.slice(electiveBatchLimit)    : []
    setRemainingElective(rest)
    setElectiveSession(true)
    setShowElectivePicker(false)
    setIndex(0)
    setLoading(true)
    void finalizeQueue(batch, { deckCards: allCards, sourceLanguage, targetLanguage, userId })
  }, [electivePickerData, electiveBatchLimit, finalizeQueue, allCards, sourceLanguage, targetLanguage, userId])

  /** Pulls the next batch from the remaining elective cards when the user clicks "Study ahead". */
  const continueElectiveSession = useCallback(() => {
    if (remainingElective.length === 0) return
    const batch = electiveBatchLimit != null ? remainingElective.slice(0, electiveBatchLimit) : remainingElective
    const rest  = electiveBatchLimit != null ? remainingElective.slice(electiveBatchLimit)    : []
    setRemainingElective(rest)
    setDone(false)
    setEmptySession(false)
    setIndex(0)
    setLoading(true)
    void finalizeQueue(batch, { deckCards: allCards, sourceLanguage, targetLanguage, userId })
  }, [remainingElective, electiveBatchLimit, finalizeQueue, allCards, sourceLanguage, targetLanguage, userId])

  const loadSession = useCallback(() => {
    setLoading(true)
    setDone(false)
    setEmptySession(false)
    setShowElectivePicker(false)
    setElectivePickerData(null)
    setRemainingElective([])
    setIndex(0)
    setQueue([])

    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/auth'); return }
      setUserId(session.user.id)

      const deckRepo     = new SupabaseDeckRepository()
      const cardRepo     = new SupabaseCardRepository()
      const stateRepo    = new SupabaseCardStateRepository()
      const pipelineRepo = new SupabasePipelineRepository()
      const prefRepo     = new SupabaseDeckPreferencesRepository()

      const [deck, cards, pipeline, prefs, profileData] = await Promise.all([
        deckRepo.get(deckId),
        cardRepo.listByDeck(deckId),
        pipelineRepo.getDefault(),
        prefRepo.get(session.user.id, deckId),
        supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', session.user.id).single(),
      ])

      const tz           = (profileData.data?.timezone as string | null) ?? 'UTC'
      const turnoverHour = (profileData.data?.day_turnover_hour as number | null) ?? 0

      if (!deck || cards.length === 0) { router.push(`/study/${deckId}`); return }
      setDeckName(deck.name)
      setGradingSettings(deck.gradingSettings)
      setSourceLanguage(deck.sourceLanguage)
      setTargetLanguage(deck.targetLanguage)
      setAllCards(cards)

      const existingStates = await stateRepo.listByDeck(session.user.id, deckId)
      const stateMap = new Map(existingStates.map(s => [s.cardId, s]))
      setCardStates(stateMap)

      const existingOverrides = await new SupabaseTypedAnswerOverrideRepository().listForUser(session.user.id)
      const overrideMap = new Map<string, Set<string>>()
      for (const o of existingOverrides) {
        const key = `${o.cardId}:${o.answerSide}`
        const set = overrideMap.get(key) ?? new Set<string>()
        set.add(o.answerText)
        overrideMap.set(key, set)
      }
      setOverrides(overrideMap)

      // Compute elective batch limit from prefs:
      // null = use default (20), 0 = no cap, positive = cap at that value.
      const rawLimit = prefs?.electiveSessionLimit ?? 20
      const batchLimit: number | null = rawLimit === 0 ? null : rawLimit
      setElectiveBatchLimit(batchLimit)

      const now   = new Date()
      const today = getToday(tz, turnoverHour)

      // ?category= elective study: build a queue from exactly that category
      // (matching the deck-detail page's stat counts) and skip the normal
      // new/due budgeting entirely.
      if (category) {
        let categoryQueue: SessionCard[] = []
        switch (category) {
          case 'new':
            categoryQueue = shuffle(
              cards.filter(c => !stateMap.has(c.id))
                .map(card => ({ card, state: initialCardState(session.user.id, card.id, pipeline.id), pipeline, productionMode: null }))
            )
            break
          case 'learning':
            categoryQueue = shuffle(
              cards.filter(c => stateMap.has(c.id) && !stateMap.get(c.id)!.graduated)
                .map(card => ({ card, state: stateMap.get(card.id)!, pipeline, productionMode: null }))
            )
            break
          case 'graduated':
            categoryQueue = shuffle(
              cards.filter(c => stateMap.get(c.id)?.graduated)
                .map(card => { const state = stateMap.get(card.id)!; return { card, state, pipeline, productionMode: decideProductionMode(state, now) } })
            )
            break
          case 'due':
            categoryQueue = shuffle(
              cards.filter(c => {
                const s = stateMap.get(c.id)
                return !!s && s.graduated && !!s.dueAt && new Date(s.dueAt) <= now
              }).map(card => { const state = stateMap.get(card.id)!; return { card, state, pipeline, productionMode: decideProductionMode(state, now) } })
            )
            break
        }
        // Slice to the elective batch limit; store the rest for "Study ahead".
        const batch = batchLimit != null ? categoryQueue.slice(0, batchLimit) : categoryQueue
        const rest  = batchLimit != null ? categoryQueue.slice(batchLimit)    : []
        setRemainingElective(rest)
        setElectiveSession(true)
        await finalizeQueue(batch, { deckCards: cards, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage, userId: session.user.id })
        return
      }

      const cardsPerSession = prefs?.cardsPerSession ?? null

      let newCardBudget: number

      if (cardsPerSession && cardsPerSession > 0) {
        // Batch mode: keep at most `cardsPerSession` cards actively in the
        // pipeline (introduced but not yet graduated) at once, regardless of
        // calendar day. Once a card graduates, the next session introduces
        // another to refill the batch.
        const inPipelineTotal = existingStates.filter(s => !s.graduated).length
        newCardBudget = Math.max(0, Math.min(cardsPerSession, cards.length) - inPipelineTotal)
      } else {
        const dailyLimit  = Math.min(
          prefs ? prefRepo.effectiveDailyLimit(prefs) : DEFAULT_DAILY_NEW_CARDS,
          cards.length,
        )
        const spilloverOn = prefs?.spilloverDue ?? false

        const introducedToday   = existingStates.filter(s => s.introducedDate === today).length
        // In-pipeline cards introduced before today (i.e. the "backlog")
        const inPipelineBacklog = existingStates.filter(s => !s.graduated && s.introducedDate && s.introducedDate < today).length

        // Without spillover: backlog cards count against today's budget
        // With spillover:    backlog is additive — full daily budget for new cards
        const budgetUsed = spilloverOn ? introducedToday : introducedToday + inPipelineBacklog
        newCardBudget = Math.max(0, dailyLimit - budgetUsed)
      }

      // Build buckets
      const newCards:      SessionCard[] = []
      const inPipeline:    SessionCard[] = []
      const dueCards:      SessionCard[] = []
      const electiveCards: SessionCard[] = []

      for (const card of cards) {
        const state = stateMap.get(card.id)
        if (!state) {
          if (newCardBudget <= 0) continue
          newCardBudget--
          newCards.push({ card, state: initialCardState(session.user.id, card.id, pipeline.id), pipeline, productionMode: null })
        } else if (!state.graduated) {
          inPipeline.push({ card, state, pipeline, productionMode: null })
        } else if (state.dueAt && new Date(state.dueAt) <= now) {
          dueCards.push({ card, state, pipeline, productionMode: decideProductionMode(state, now) })
        } else {
          electiveCards.push({ card, state, pipeline, productionMode: decideProductionMode(state, now) })
        }
      }

      // New cards: keep in deck order (first session = ordered introduction)
      // In-pipeline + due: shuffle so session feels varied
      const finalQueue = [...newCards, ...shuffle(inPipeline), ...shuffle(dueCards)]

      if (finalQueue.length === 0) {
        // Nothing new/due. Offer a picker to elect into studying unlearned
        // cards (beyond today's budget) and/or not-yet-due graduated cards
        // ("early review") — rather than auto-starting either.
        const unlearnedCards: SessionCard[] = cards
          .filter(c => !stateMap.has(c.id))
          .map(card => ({ card, state: initialCardState(session.user.id, card.id, pipeline.id), pipeline, productionMode: null }))

        if (unlearnedCards.length > 0 || electiveCards.length > 0) {
          setElectivePickerData({ unlearned: unlearnedCards, earlyReview: electiveCards })
          setShowElectivePicker(true)
          setLoading(false)
          return
        }

        setEmptySession(true); setDone(true); setLoading(false); return
      }

      setElectiveSession(false)
      await finalizeQueue(finalQueue, { deckCards: cards, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage, userId: session.user.id })
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, category, finalizeQueue])

  useEffect(() => {
    loadSession()
  }, [loadSession])

  const handleAnswer = useCallback(async (rating: Rating, wasCorrect: boolean, userAnswer = '') => {
    const current = queue[index]
    if (!current) return
    if (submitting) return

    setSubmitting(true)
    setAnswerError(null)

    try {
      const { card, state, pipeline, productionMode } = current
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
          ? allCards.find(c => c.front.trim().toLowerCase() === userAnswer.trim().toLowerCase())?.id ?? null
          : allCards.find(c => c.back.trim().toLowerCase()  === userAnswer.trim().toLowerCase())?.id ?? null
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

      setCardStates(prev => {
        const next = new Map(prev)
        next.set(card.id, newState)
        return next
      })

      // 10-minute "Again" relearn loop: re-queue the card a few slots ahead so
      // it resurfaces later in this session (dueAt is also set to +10min, so
      // it'll come back due if the session ends first).
      if (newState.graduated && newState.relearningStep > 0) {
        const requeued: SessionCard = { card, state: newState, pipeline, productionMode: decideProductionMode(newState, nowDate) }
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
  }, [queue, index, userId, gradingSettings, submitting])

  /**
   * "I don't know" — heavier penalty than a single wrong answer.
   * Runs the state machine 3 times with 'again', records 3 review events,
   * and re-queues the card later in the session so it comes back for practice.
   * Stores enough info to undo if the press was accidental.
   */
  const handleIDontKnow = useCallback(async () => {
    const current = queue[index]
    if (!current || submitting) return
    setSubmitting(true)
    setAnswerError(null)

    try {
      const { card, state, pipeline, productionMode } = current
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
      setCardStates(prev => { const m = new Map(prev); m.set(card.id, counted); return m })

      // Re-queue the card a few slots ahead so it resurfaces this session
      const requeued: SessionCard = { card, state: counted, pipeline, productionMode, idontknow: true }
      setQueue(prev => {
        const next = [...prev]
        next[index] = { ...current, state: counted }
        const insertPos = Math.min(index + 1 + IDONTKNOW_REQUEUE_OFFSET, next.length)
        next.splice(insertPos, 0, requeued)
        return next
      })
    } catch (err: unknown) {
      console.error('Failed to record I don\'t know:', err)
      setAnswerError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [queue, index, userId, submitting])

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading session…</div>

  if (showElectivePicker && electivePickerData) {
    return <ElectivePicker deckId={deckId} data={electivePickerData} onStart={startElectiveSession} />
  }

  if (done) {
    if (emptySession) {
      const heading = category ? 'Nothing to study' : 'All caught up!'
      const message = category
        ? CATEGORY_EMPTY_MESSAGE[category]
        : <>
            You&apos;ve gone through everything available for this deck right now.
            To keep studying, add more cards to the deck or increase your new-cards
            limit (or cards-per-session batch size) in the deck&apos;s study settings.
          </>
      return (
        <div className="max-w-md mx-auto pt-20 text-center space-y-6">
          <div className="text-5xl">{category ? '🤷' : '✅'}</div>
          <h2 className="text-2xl font-semibold text-ink">{heading}</h2>
          <p className="text-ink-muted">{message}</p>
          <div className="flex justify-center">
            <Link href={`/study/${deckId}`} className="btn-primary">Back to deck</Link>
          </div>
        </div>
      )
    }

    const allLearned = allCards.length > 0 && allCards.every(c => cardStates.get(c.id)?.graduated === true)
    return (
      <div className="max-w-md mx-auto pt-20 text-center space-y-6">
        <div className="text-5xl">🎉</div>
        <h2 className="text-2xl font-semibold text-ink">Session complete!</h2>
        <p className="text-ink-muted">You reviewed {queue.length} card{queue.length !== 1 ? 's' : ''}.</p>
        {electiveSession && remainingElective.length > 0 && (
          <p className="text-xs text-ink-faint">
            {remainingElective.length} more card{remainingElective.length !== 1 ? 's' : ''} remaining in this category.
          </p>
        )}
        <div className="flex gap-3 justify-center flex-wrap">
          <Link href={`/study/${deckId}`} className="btn-primary">Back to deck</Link>
          {electiveSession && remainingElective.length > 0 && (
            <button onClick={continueElectiveSession} className="btn-ghost">
              Study ahead ({Math.min(electiveBatchLimit ?? remainingElective.length, remainingElective.length)} more)
            </button>
          )}
          {!electiveSession && !allLearned && (
            <button onClick={() => loadSession()} className="btn-ghost">Next round</button>
          )}
        </div>
      </div>
    )
  }

  const current = queue[index]!
  const { card, state, pipeline } = current
  const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!
  const reviewPromptSide: CardSide = state.graduated ? 'back' : step.promptSide
  const reviewAnswerSide: CardSide = state.graduated ? 'front' : step.answerSide

  return (
    <div className="space-y-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between">
        <Link href={`/study/${deckId}`} className="text-sm text-ink-muted hover:text-ink">✕ End session</Link>
        <div className="text-xs text-ink-muted">{index + 1} / {queue.length}</div>
        <div className="text-xs text-ink-muted">{state.graduated ? 'Review' : `Step ${state.currentStepOrder + 1} · ${step.stepType}`}</div>
      </div>
      <div className="h-1 bg-surface-raised rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full transition-all duration-300"
          style={{ width: `${Math.round((index / queue.length) * 100)}%` }} />
      </div>
      {electiveSession && (
        <p className="text-xs text-accent text-center">
          {category ? CATEGORY_BANNER[category] : 'Studying ahead — nothing else is due right now.'}
        </p>
      )}
      <p className="text-xs text-ink-faint uppercase tracking-wider text-center">{deckName}</p>

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
          deckCards={allCards} sourceLanguage={sourceLanguage} targetLanguage={targetLanguage}
          onChoicesCached={handleChoicesCached}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      ) : !state.graduated ? (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          promptLanguage={step.promptSide === 'front' ? sourceLanguage : targetLanguage}
          gradingSettings={gradingSettings!} gradedReview={false}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${step.answerSide}`) ?? [])}
          synonyms={step.answerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, step.answerSide, answerText, accept)}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      ) : current.productionMode === 'self-graded' ? (
        <FlashcardMode key={`${card.id}-${index}`} card={card} promptSide={reviewPromptSide}
          onRate={rating => handleAnswer(rating, rating !== 'again')} />
      ) : (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={reviewPromptSide}
          promptLanguage={reviewPromptSide === 'front' ? sourceLanguage : targetLanguage}
          gradingSettings={gradingSettings!} gradedReview={true}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${reviewAnswerSide}`) ?? [])}
          synonyms={reviewAnswerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, reviewAnswerSide, answerText, accept)}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      )}
    </div>
  )
}

// ─── Elective study picker ─────────────────────────────────────────────────────

/**
 * Shown when the learner has finished everything new/due for today and
 * presses "Study" — lets them choose to keep going with unlearned cards
 * (beyond today's new-card budget) and/or graduated cards that aren't due
 * yet ("early review"), either or both.
 */
function ElectivePicker({ deckId, data, onStart }: {
  deckId: string
  data:   ElectivePickerData
  onStart: (selected: { unlearned: boolean; earlyReview: boolean }) => void
}) {
  const hasUnlearned  = data.unlearned.length > 0
  const hasEarlyReview = data.earlyReview.length > 0

  const [unlearned,   setUnlearned]   = useState(hasUnlearned)
  const [earlyReview, setEarlyReview] = useState(hasEarlyReview)

  const canStart = (hasUnlearned && unlearned) || (hasEarlyReview && earlyReview)

  return (
    <div className="max-w-md mx-auto pt-16 text-center space-y-6">
      <div className="text-5xl">✅</div>
      <h2 className="text-2xl font-semibold text-ink">All caught up for today!</h2>
      <p className="text-ink-muted">
        Nothing new or due right now. Want to keep going? Pick what to study electively:
      </p>

      <div className="space-y-3 text-left">
        {hasUnlearned && (
          <label className="panel flex items-center gap-3 cursor-pointer hover:bg-surface-raised/50 transition-colors">
            <input type="checkbox" checked={unlearned} onChange={e => setUnlearned(e.target.checked)} className="accent-accent w-4 h-4" />
            <span className="flex-1">
              <span className="block text-sm font-medium text-ink">Unlearned</span>
              <span className="block text-xs text-ink-faint">{data.unlearned.length} card{data.unlearned.length !== 1 ? 's' : ''} not yet started</span>
            </span>
          </label>
        )}
        {hasEarlyReview && (
          <label className="panel flex items-center gap-3 cursor-pointer hover:bg-surface-raised/50 transition-colors">
            <input type="checkbox" checked={earlyReview} onChange={e => setEarlyReview(e.target.checked)} className="accent-accent w-4 h-4" />
            <span className="flex-1">
              <span className="block text-sm font-medium text-ink">Early review</span>
              <span className="block text-xs text-ink-faint">{data.earlyReview.length} graduated card{data.earlyReview.length !== 1 ? 's' : ''} not due yet</span>
            </span>
          </label>
        )}
      </div>

      <div className="flex gap-3 justify-center">
        <button onClick={() => onStart({ unlearned, earlyReview })} disabled={!canStart} className="btn-primary">
          Start studying
        </button>
        <Link href={`/study/${deckId}`} className="btn-ghost">Back to deck</Link>
      </div>
    </div>
  )
}
