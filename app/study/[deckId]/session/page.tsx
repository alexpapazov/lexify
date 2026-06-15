'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }            from '@/lib/data/decks'
import { SupabaseCardRepository }            from '@/lib/data/cards'
import { SupabaseCardStateRepository }       from '@/lib/data/cardStates'
import { SupabaseReviewEventRepository }     from '@/lib/data/reviewEvents'
import { SupabasePipelineRepository }        from '@/lib/data/pipelines'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { progressAfterReview, initialCardState } from '@/engine/pipeline'
import { classifyWrongAnswer } from '@/engine/grading'
import { smoothDueDate } from '@/engine/density'
import { scheduleNext, classifyReviewMode } from '@/engine/scheduler'
import { decideProductionMode, type ProductionMode } from '@/engine/productionMode'
import type { Card, CardState, Pipeline, Rating, GradingSettings } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS, DEFAULT_GRADING_SETTINGS } from '@/domain'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { TypingMode } from '@/components/session/TypingMode'
import { MultipleChoiceMode } from '@/components/session/MultipleChoiceMode'
import { prefetchChoices, type PrefetchItem } from '@/lib/distractors'

/** How many slots ahead a graduated card is re-queued after starting the 10-minute relearn loop. */
const RELEARN_REQUEUE_OFFSET = 3

interface SessionCard {
  card: Card
  state: CardState
  pipeline: Pipeline
  /** For graduated cards: whether this review should use typed or self-graded production. Null pre-graduation. */
  productionMode: ProductionMode | null
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
  const supabase   = createClient()

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

  const handleChoicesCached = useCallback((cardId: string, choices: Card['choices']) => {
    setAllCards(prev => prev.map(c => c.id === cardId ? { ...c, choices } : c))
    setQueue(prev => prev.map(item => item.card.id === cardId ? { ...item, card: { ...item.card, choices } } : item))
  }, [])

  const loadSession = useCallback(() => {
    setLoading(true)
    setDone(false)
    setEmptySession(false)
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

      const [deck, cards, pipeline, prefs] = await Promise.all([
        deckRepo.get(deckId),
        cardRepo.listByDeck(deckId),
        pipelineRepo.getDefault(),
        prefRepo.get(session.user.id, deckId),
      ])

      if (!deck || cards.length === 0) { router.push(`/study/${deckId}`); return }
      setDeckName(deck.name)
      setGradingSettings(deck.gradingSettings)
      setSourceLanguage(deck.sourceLanguage)
      setTargetLanguage(deck.targetLanguage)
      setAllCards(cards)

      const existingStates = await stateRepo.listByDeck(session.user.id, deckId)
      const stateMap = new Map(existingStates.map(s => [s.cardId, s]))
      setCardStates(stateMap)

      const now   = new Date()
      const today = now.toISOString().slice(0, 10)

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
      let finalQueue = [...newCards, ...shuffle(inPipeline), ...shuffle(dueCards)]

      // Elective study: if nothing new/due, let the learner continue with
      // not-yet-due graduated cards via this same Study button.
      if (finalQueue.length === 0 && electiveCards.length > 0) {
        finalQueue = shuffle(electiveCards)
        setElectiveSession(true)
      } else {
        setElectiveSession(false)
      }

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
          return { card: item.card, side: step.answerSide, deckCards: cards, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage }
        })
        .filter((x): x is PrefetchItem => x !== null)
      void prefetchChoices(prefetchItems, handleChoicesCached)
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId])

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

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading session…</div>

  if (done) {
    if (emptySession) {
      return (
        <div className="max-w-md mx-auto pt-20 text-center space-y-6">
          <div className="text-5xl">✅</div>
          <h2 className="text-2xl font-semibold text-ink">All caught up!</h2>
          <p className="text-ink-muted">
            You&apos;ve gone through everything available for this deck right now.
            To keep studying, add more cards to the deck or increase your new-cards
            limit (or cards-per-session batch size) in the deck&apos;s study settings.
          </p>
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
        <div className="flex gap-3 justify-center">
          <Link href={`/study/${deckId}`} className="btn-primary">Back to deck</Link>
          {!allLearned && (
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
        <p className="text-xs text-accent text-center">Studying ahead — nothing else is due right now.</p>
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
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      ) : !state.graduated ? (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          gradingSettings={gradingSettings!} gradedReview={false}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      ) : current.productionMode === 'self-graded' ? (
        <FlashcardMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          onRate={rating => handleAnswer(rating, rating !== 'again')} />
      ) : (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          gradingSettings={gradingSettings!} gradedReview={true}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      )}
    </div>
  )
}
