'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
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
import { SupabaseCardConfusionLinkRepository } from '@/lib/data/cardConfusionLinks'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import type { CardSide } from '@/domain'
import { progressAfterReview, initialCardState } from '@/engine/pipeline'
import { classifyWrongAnswer, isDifferentWordMistake } from '@/engine/grading'
import { smoothDueDate } from '@/engine/density'
import { scheduleNext, classifyReviewMode, graduationIntervalRange } from '@/engine/scheduler'
import { decideProductionMode, type ProductionMode } from '@/engine/productionMode'
import type { Card, CardState, Pipeline, Rating, GradingSettings, CardConfusion, SynonymGroup, SynonymAnswerField, SynonymProductionPrompt, GradingIssueType, SchedulerParams } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS, DEFAULT_GRADING_SETTINGS, DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { TypingMode } from '@/components/session/TypingMode'
import { MultipleChoiceMode } from '@/components/session/MultipleChoiceMode'
import { SynonymTypingMode } from '@/components/session/SynonymTypingMode'
import { SynonymDueNowMode } from '@/components/session/SynonymDueNowMode'
import { prefetchChoices, prefetchAudio, promoteConfusionDistractors, deckSiblings, needsChoices, ensureChoicesGenerated, type PrefetchItem, type ConfusionPromotionItem } from '@/lib/distractors'
import { getToday, snapDueAtToStartOfDay } from '@/lib/dates'
import { SupabaseSynonymGroupRepository } from '@/lib/data/synonymGroups'
import { markSynonymAnswered, wasSynonymAnswered, purgeStaleSynonymPrefill } from '@/lib/synonymPrefill'
import { triggerSyncFill } from '@/lib/triggerSyncFill'

const REPEAT_REQUEUE_OFFSET    = 8
const IDONTKNOW_REQUEUE_OFFSET = 4

interface SessionCard {
  card: Card
  state: CardState
  pipeline: Pipeline
  /** For graduated cards: whether this review should use typed or self-graded production. Null pre-graduation. */
  productionMode: ProductionMode | null
  /** Which interval track triggered this queue entry ('typed' | 'recall' | 'legacy'). Undefined for pipeline cards. */
  reviewTrack?: 'typed' | 'recall' | 'legacy'
  /** True when this entry is for the reverse-direction (Spanish→English) recall row. */
  isReverse?: boolean
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

  // When a category session completes, return to the deck page with the same
  // filter active so the user can immediately study that category again.
  const deckUrl = category ? `/study/${deckId}?filter=${category}` : `/study/${deckId}`

  const [queue,           setQueue]           = useState<SessionCard[]>([])
  const [allCards,        setAllCards]        = useState<Card[]>([])
  const [index,           setIndex]           = useState(0)
  const [loading,         setLoading]         = useState(true)
  const [userId,          setUserId]          = useState('')
  const [deckName,        setDeckName]        = useState('')
  const [sourceLanguage,  setSourceLanguage]  = useState('es')
  const [targetLanguage,  setTargetLanguage]  = useState('en')
  const [gradingSettings,  setGradingSettings]  = useState<GradingSettings | null>(null)
  const [schedulerParams,  setSchedulerParams]  = useState<SchedulerParams>(DEFAULT_SCHEDULER_PARAMS)
  const [forwardTypedEnabled, setForwardTypedEnabled] = useState(true)
  const [forwardRecallEnabled, setForwardRecallEnabled] = useState(true)
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
  /** Graduated cards in the 10-minute relearn loop — held out of the main queue until their dueAt passes (or the queue runs out). */
  const [relearnPool,     setRelearnPool]     = useState<SessionCard[]>([])
  /** Synonym groups for all cards in this session (loaded at session start). */
  const [synonymGroups,           setSynonymGroups]           = useState<Map<string, SynonymGroup>>(new Map())
  /** The "today" date key used for synonym pre-fill localStorage (accounts for day turnover hour). */
  const [studyDayKey,             setStudyDayKey]             = useState('')
  /** IDs of synonym-group cards answered in this session via multi-field — auto-advance when encountered. */
  const [sessionAnsweredSynonyms, setSessionAnsweredSynonyms] = useState<Set<string>>(new Set())
  /** Whether to show IPA transcription below the source-language prompt. Persisted to localStorage. */
  const [showIPA,  setShowIPA]  = useState(() => typeof window !== 'undefined' && localStorage.getItem('lexify_ipa') === '1')
  /** In-session IPA cache: cardId → IPA text (supplements card.ipa from DB). */
  const [ipaCache, setIpaCache] = useState<Map<string, string>>(new Map())
  /** Undo/redo stacks — each entry captures the card state before/after handleAnswer ran. */
  const [undoStack, setUndoStack] = useState<Array<{ queueIndex: number; prevState: CardState; newState: CardState }>>([])
  const [redoStack, setRedoStack] = useState<Array<{ queueIndex: number; prevState: CardState; newState: CardState }>>([]);

  const tzRef          = useRef('UTC')
  const turnoverRef    = useRef(0)
  /** Wrong typing-step answers per card during the current pipeline run. */
  const pipelineTypingErrorsRef = useRef<Map<string, number>>(new Map())

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

  const handleAudioCached = useCallback((cardId: string, audioData: string) => {
    setAllCards(prev => prev.map(c => c.id === cardId ? { ...c, audioGenerated: true, audioData } : c))
    setQueue(prev => prev.map(item => item.card.id === cardId ? { ...item, card: { ...item.card, audioGenerated: true, audioData } } : item))
  }, [])

  /**
   * Commits a built queue (from the normal new/due flow, a ?category=
   * elective queue, or the elective picker) and kicks off the same
   * background prefetch/confusion-promotion work the normal flow does.
   * `ctx` is passed explicitly rather than read from state, since this can
   * run mid-`load()` before `setAllCards`/`setUserId`/etc. have flushed.
   */
  const finalizeQueue = useCallback(async (
    rawQueue: SessionCard[],
    ctx: { deckCards: Card[]; sourceLanguage: string; targetLanguage: string; userId: string },
  ) => {
    // Deduplicate synonym groups: only keep one card per group so the session
    // counter matches reality. handleSynonymTypingAdvance updates all member states.
    const seenGroups = new Set<string>()
    const finalQueue = rawQueue.filter(item => {
      const gid = item.card.synonymGroupId
      if (!gid) return true
      if (seenGroups.has(gid)) return false
      seenGroups.add(gid)
      return true
    })

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
    void prefetchChoices(prefetchItems, handleChoicesCached, 2)

    // Prefetch audio for ALL cards in the queue (typing steps, graduated cards,
    // and index 0 are excluded from prefetchItems but still need audio).
    const audioPrefetchItems = finalQueue.map(item => ({
      card: item.card, sourceLanguage: ctx.sourceLanguage,
    }))
    void prefetchAudio(audioPrefetchItems, handleAudioCached)

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
    setDone(false)
    setEmptySession(false)
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
    setUndoStack([])
    setRedoStack([])

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
      tzRef.current       = tz
      turnoverRef.current = turnoverHour

      if (!deck || cards.length === 0) { router.push(`/study/${deckId}`); return }
      if (!deck.syncingComplete) triggerSyncFill()
      setDeckName(deck.name)
      setGradingSettings(deck.gradingSettings)
      setSourceLanguage(deck.sourceLanguage)
      setTargetLanguage(deck.targetLanguage)
      setAllCards(cards)

      try {
        const paramsRow = await new SupabaseUserSchedulerParamsRepository().getOrCreate(
          session.user.id, deck.sourceLanguage, deck.targetLanguage, 'forward_typed',
        )
        setSchedulerParams(paramsRow)
        setForwardTypedEnabled(paramsRow.forwardTypedEnabled ?? true)
        setForwardRecallEnabled(paramsRow.forwardRecallEnabled ?? true)
      } catch { /* fall back to defaults */ }

      const today = getToday(tz, turnoverHour)
      setStudyDayKey(today)
      purgeStaleSynonymPrefill(session.user.id, today)
      const groupsMap = await new SupabaseSynonymGroupRepository().listForCards(cards.map(c => c.id))
      setSynonymGroups(groupsMap)

      const existingStates  = await stateRepo.listByDeck(session.user.id, deckId)
      const forwardStates   = existingStates.filter(s => s.reviewDirection !== 'reverse')
      const reverseStatesList = existingStates.filter(s => s.reviewDirection === 'reverse')
      const stateMap = new Map(forwardStates.map(s => [s.cardId, s]))
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
      const isDueByDate = (dateStr: string | null | undefined): boolean => {
        if (!dateStr) return false
        return new Date(dateStr).toLocaleDateString('en-CA', { timeZone: tz }) <= today
      }

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
                .map(card => { const state = stateMap.get(card.id)!; return { card, state, pipeline, productionMode: decideProductionMode(state, now, Math.random, schedulerParams) } })
            )
            break
          case 'due':
            categoryQueue = shuffle(
              cards.flatMap(card => {
                const state = stateMap.get(card.id)
                if (!state?.graduated) return []
                const isLegacyDue = !state.typedDueAt && isDueByDate(state.dueAt)
                const isTypedDue  = !!state.typedDueAt && isDueByDate(state.typedDueAt)
                const isRecallDue = isDueByDate(state.recallDueAt)
                const items: (typeof categoryQueue)[number][] = []
                if (isTypedDue)  items.push({ card, state, pipeline, productionMode: decideProductionMode(state, now, Math.random, schedulerParams), reviewTrack: 'typed' })
                if (isRecallDue) items.push({ card, state, pipeline, productionMode: 'self-graded', reviewTrack: 'recall' })
                if (isLegacyDue) items.push({ card, state, pipeline, productionMode: decideProductionMode(state, now, Math.random, schedulerParams), reviewTrack: 'legacy' })
                return items
              })
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

      const cardsPerSession   = prefs?.cardsPerSession   ?? null
      const learningBatchMode = prefs?.learningBatchMode ?? false

      // Exclude states for soft-deleted cards so they don't skew budget math.
      const activeCardIdSet   = new Set(cards.map(c => c.id))
      const activeStates      = existingStates.filter(s => activeCardIdSet.has(s.cardId))

      let newCardBudget: number
      let eligibleNewCardIds: Set<string> | null = null  // null = all cards eligible

      if (cardsPerSession && cardsPerSession > 0) {
        const inPipelineTotal = activeStates.filter(s => !s.graduated).length

        if (learningBatchMode) {
          // Batch mode: cards are grouped by position into groups of cardsPerSession.
          // All cards in a group must graduate before the next group unlocks.
          const sortedCards = [...cards].sort((a, b) => a.position - b.position)
          let batchStart = 0
          while (batchStart < sortedCards.length) {
            const batchEnd  = Math.min(batchStart + cardsPerSession, sortedCards.length)
            const allGraduated = sortedCards.slice(batchStart, batchEnd)
              .every(c => stateMap.get(c.id)?.graduated === true)
            if (!allGraduated) break
            batchStart += cardsPerSession
          }
          eligibleNewCardIds = new Set(
            sortedCards.slice(batchStart, batchStart + cardsPerSession).map(c => c.id)
          )
          newCardBudget = Math.max(0, cardsPerSession - inPipelineTotal)
        } else {
          // Rolling mode: keep at most cardsPerSession cards in the pipeline.
          // As each card graduates, the next unlearned card enters immediately.
          newCardBudget = Math.max(0, Math.min(cardsPerSession, cards.length) - inPipelineTotal)
        }
      } else {
        const dailyLimit  = Math.min(
          prefs ? prefRepo.effectiveDailyLimit(prefs) : DEFAULT_DAILY_NEW_CARDS,
          cards.length,
        )
        const spilloverOn = prefs?.spilloverDue ?? false

        const introducedToday   = activeStates.filter(s => s.introducedDate === today).length
        // In-pipeline cards introduced before today (i.e. the "backlog")
        const inPipelineBacklog = activeStates.filter(s => !s.graduated && s.introducedDate && s.introducedDate < today).length

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
          if (eligibleNewCardIds && !eligibleNewCardIds.has(card.id)) continue
          if (newCardBudget <= 0) continue
          newCardBudget--
          newCards.push({ card, state: initialCardState(session.user.id, card.id, pipeline.id), pipeline, productionMode: null })
        } else if (!state.graduated) {
          inPipeline.push({ card, state, pipeline, productionMode: null })
        } else if (state.graduated) {
          const isLegacyDue = !state.typedDueAt && isDueByDate(state.dueAt)
          const isTypedDue  = !!state.typedDueAt && isDueByDate(state.typedDueAt)
          const isRecallDue = isDueByDate(state.recallDueAt)
          if (isTypedDue) {
            dueCards.push({ card, state, pipeline, productionMode: decideProductionMode(state, now, Math.random, schedulerParams), reviewTrack: 'typed' })
          }
          if (isRecallDue) {
            dueCards.push({ card, state, pipeline, productionMode: 'self-graded', reviewTrack: 'recall' })
          }
          if (isLegacyDue) {
            dueCards.push({ card, state, pipeline, productionMode: decideProductionMode(state, now, Math.random, schedulerParams), reviewTrack: 'legacy' })
          }
          if (!isTypedDue && !isRecallDue && !isLegacyDue) {
            electiveCards.push({ card, state, pipeline, productionMode: decideProductionMode(state, now, Math.random, schedulerParams) })
          }
        }
      }

      // Add due reverse-direction rows
      for (const reverseState of reverseStatesList) {
        if (!reverseState.recallDueAt || new Date(reverseState.recallDueAt) > now) continue
        const card = cards.find(c => c.id === reverseState.cardId)
        if (card) dueCards.push({ card, state: reverseState, pipeline, productionMode: 'self-graded', reviewTrack: 'recall', isReverse: true })
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
      const cappedQueue = batchLimit != null ? finalQueue.slice(0, batchLimit) : finalQueue
      await finalizeQueue(cappedQueue, { deckCards: cards, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage, userId: session.user.id })
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, category, finalizeQueue])

  useEffect(() => {
    loadSession()
  }, [loadSession])

  // When the main queue runs out, inject the most-elapsed relearn card so the
  // session continues. Cards are sorted by dueAt ASC (soonest due = most of
  // their relearn interval has already elapsed).
  useEffect(() => {
    if (loading || showElectivePicker || done || index < queue.length) return
    if (relearnPool.length === 0) { setDone(true); return }
    const sorted = [...relearnPool].sort((a, b) =>
      (a.state.dueAt ? new Date(a.state.dueAt).getTime() : 0) -
      (b.state.dueAt ? new Date(b.state.dueAt).getTime() : 0)
    )
    setQueue(prev => [...prev, sorted[0]!])
    setRelearnPool(sorted.slice(1))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue.length, done, loading, showElectivePicker])

  // Auto-advance past any synonym-group card that was already answered in
  // this session via a multi-field prompt (to avoid showing it again).
  const currentCardId = !loading && !done ? queue[index]?.card.id : undefined
  useEffect(() => {
    if (!currentCardId) return
    if (sessionAnsweredSynonyms.has(currentCardId)) {
      setIndex(i => i + 1)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCardId, sessionAnsweredSynonyms])

  // Fire-and-forget calibration when the session completes.
  useEffect(() => {
    if (!done || !userId || !sourceLanguage || !targetLanguage || electiveSession) return
    fetch('/api/calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sourceLanguage, targetLanguage }),
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

  // Persist IPA toggle preference.
  useEffect(() => {
    localStorage.setItem('lexify_ipa', showIPA ? '1' : '0')
  }, [showIPA])

  // When IPA is on and the current card lacks IPA, fetch it in the background.
  useEffect(() => {
    if (!showIPA || !currentCardId) return
    const card = queue[index]?.card
    if (!card || ipaCache.has(card.id) || card.ipa) return
    fetch('/api/ipa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: card.front, language: sourceLanguage }),
    })
      .then(r => r.json())
      .then((d: { ok: boolean; ipa?: string }) => {
        if (!d.ok || !d.ipa) return
        setIpaCache(prev => new Map(prev).set(card.id, d.ipa!))
        new SupabaseCardRepository().update(card.id, { ipa: d.ipa }).catch(() => {})
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIPA, currentCardId])

  const handlePromptEdit = useCallback(async (cardId: string, promptSide: 'front' | 'back', newText: string) => {
    const cardRepo = new SupabaseCardRepository()
    if (!newText) {
      await cardRepo.softDelete(cardId)
      setQueue(prev => prev.filter(it => it.card.id !== cardId))
      setAllCards(prev => prev.filter(c => c.id !== cardId))
      return
    }
    const existing = allCards.find(c => c.id === cardId)
    if (!existing) return
    if (newText === (promptSide === 'front' ? existing.front : existing.back)) return
    const patch = promptSide === 'front'
      ? { front: newText, audioGenerated: false as const, audioData: null, choices: null }
      : { back: newText, choices: null }
    const updated = await cardRepo.update(cardId, patch)
    setAllCards(prev => prev.map(c => c.id === cardId ? updated : c))
    setQueue(prev => prev.map(it => it.card.id === cardId ? { ...it, card: updated } : it))
    if (promptSide === 'front') {
      void prefetchAudio([{ card: updated, sourceLanguage }], handleAudioCached)
    }
    // Regenerate distractors for both sides — the changed text makes existing choices stale.
    for (const side of ['front', 'back'] as const) {
      void ensureChoicesGenerated(updated, side, allCards, sourceLanguage, targetLanguage)
        .then(ai => { if (ai) handleChoicesCached(cardId, ai) })
    }
  }, [allCards, sourceLanguage, targetLanguage, handleAudioCached, handleChoicesCached])

  const handleChoiceEdit = useCallback(async (cardId: string, answerSide: CardSide, originalChoice: string, newText: string, isCorrect: boolean) => {
    const cardRepo = new SupabaseCardRepository()
    const card = allCards.find(c => c.id === cardId)
    if (!card) return
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
        void ensureChoicesGenerated(updated, answerSide, allCards, sourceLanguage, targetLanguage)
          .then(ai => { if (ai) handleChoicesCached(cardId, ai) })
      }
    }
    setAllCards(prev => prev.map(c => c.id === cardId ? updated : c))
    setQueue(prev => prev.map(it => it.card.id === cardId ? { ...it, card: updated } : it))
  }, [allCards, sourceLanguage, targetLanguage, handleChoicesCached])

  const handleAnswer = useCallback(async (rating: Rating, wasCorrect: boolean, userAnswer = '', _issueType?: GradingIssueType, softWrongRecallRating?: Rating) => {
    const current = queue[index]
    if (!current) return
    if (submitting) return

    setSubmitting(true)
    setAnswerError(null)

    try {
      const { card, state, pipeline, productionMode, reviewTrack, isReverse } = current
      const stateRepo  = new SupabaseCardStateRepository()
      const eventRepo  = new SupabaseReviewEventRepository()
      const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
      const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!
      const reviewPromptSide: CardSide = state.graduated ? (isReverse ? 'front' : 'back') : step.promptSide
      const reviewAnswerSide: CardSide = state.graduated ? (isReverse ? 'back'  : 'front') : step.answerSide

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
        if (confusedWithCardId) {
          new SupabaseCardConfusionLinkRepository().link(userId, card.id, confusedWithCardId)
            .catch(err => console.error('Failed to auto-link confusion:', err))
        }
      }

      const nowDate    = new Date()
      const reviewMode = classifyReviewMode(state, nowDate)
      const isRecallReview = reviewTrack === 'recall' || !!isReverse
      const wasTyped   = state.graduated ? (isRecallReview ? false : productionMode === 'typed') : null

      const reviewEvent = await eventRepo.create({
        userId: userId, cardId: card.id, mode: step.stepType,
        promptSide: reviewPromptSide, answerSide: reviewAnswerSide,
        promptShown: reviewPromptSide === 'front' ? card.front : card.back,
        expected:    reviewAnswerSide === 'front' ? card.front : card.back,
        userAnswer, wasCorrect, rating, responseMs: null,
        reviewMode, wasTyped,
        wasAccelerated:     state.acceleratedMode === 'import_known',
        acceleratedPenalty: state.acceleratedPenalty,
        reviewDirection:    (state.reviewDirection ?? 'forward') as 'forward' | 'reverse',
        reps:               state.reps,
      })

      const wrongSeverity = !wasCorrect && (step.stepType === 'typing' || wasTyped)
        ? classifyWrongAnswer(userAnswer, reviewAnswerSide === 'front' ? card.front : card.back, gradingSettings ?? DEFAULT_GRADING_SETTINGS)
        : undefined

      // Lazy reverse-row creation for existing graduated cards that predate Phase 2.
      // Actual upsert is deferred below after newState is computed, so we can base
      // the reverse due date on the forward card's NEXT review date (Option A).
      let reverseExistsForLazyInit: boolean | null = null
      if (state.graduated && state.reviewDirection !== 'reverse' && !isRecallReview) {
        reverseExistsForLazyInit = !!(await stateRepo.get(userId, card.id, 'reverse'))
      }

      // Recall/reverse review: update only the recall track then return early.
      if (isRecallReview) {
        const recallBase = state.recallIntervalDays != null
          ? { ...state, intervalDays: state.recallIntervalDays, scheduledIntervalDays: state.recallIntervalDays }
          : state
        const recallSched = scheduleNext(recallBase, rating, { now: nowDate, wrongSeverity, params: schedulerParams })
        const newRecallDueAt = recallSched.dueAt
          ? snapDueAtToStartOfDay(recallSched.dueAt, tzRef.current, turnoverRef.current)
          : state.recallDueAt
        const recallNewState: CardState = {
          ...state,
          ease:               recallSched.ease,
          lastRating:         rating,
          lastReviewedAt:     nowDate.toISOString(),
          reps:               rating !== 'hard' ? state.reps + 1 : state.reps,
          lapseClusterCount:  recallSched.lapseClusterCount,
          lastLapseAt:        recallSched.lastLapseAt,
          recallIntervalDays: recallSched.intervalDays,
          recallDueAt:        newRecallDueAt,
        }
        await stateRepo.upsert(recallNewState)
        setCardStates(prev => {
          if (isReverse) return prev
          const n = new Map(prev); n.set(card.id, recallNewState); return n
        })
        setUndoStack(prev => [...prev.slice(-9), { queueIndex: index, prevState: { ...state }, newState: recallNewState }])
        setRedoStack([])
        setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: recallNewState } : item))
        if (index + 1 < queue.length || relearnPool.length > 0) { setIndex(i => i + 1) } else { setDone(true) }
        return
      }

      // Count wrong typing answers during the pipeline so graduation can pick the right interval.
      if (!state.graduated && step.stepType === 'typing' && !wasCorrect) {
        pipelineTypingErrorsRef.current.set(card.id, (pipelineTypingErrorsRef.current.get(card.id) ?? 0) + 1)
      }

      // Computed independently (same `nowDate`) so the density-smoothing
      // window matches exactly what progressAfterReview just applied.
      const scheduled = state.graduated ? scheduleNext(state, rating, { now: nowDate, wrongSeverity, params: schedulerParams }) : null

      let newState = progressAfterReview(state, pipeline, { wasCorrect, rating, wrongSeverity, wasTyped: wasTyped ?? false }, nowDate)

      if (state.graduated && !newState.graduated) {
        eventRepo.markLapsed(reviewEvent.id, userId).catch(() => {})
      }

      if (
        newState.graduated && newState.dueAt && scheduled &&
        !scheduled.noChange && !scheduled.relearn && scheduled.relearningStep === 0 &&
        scheduled.smoothMinDays != null && scheduled.smoothMaxDays != null &&
        scheduled.intervalDays >= 7
      ) {
        const smoothed = await smoothDueDate(userId, newState.dueAt, scheduled.smoothMinDays, scheduled.smoothMaxDays, scheduled.intervalDays, stateRepo)
        newState = { ...newState, dueAt: smoothed }
      }

      // Graduation: override the default interval with a range based on how many
      // typing steps the learner got wrong during this pipeline run.
      if (!state.graduated && newState.graduated && newState.dueAt) {
        const errors    = pipelineTypingErrorsRef.current.get(card.id) ?? 0
        const [minDays, maxDays] = graduationIntervalRange(errors, schedulerParams)
        const idealDays = Math.floor((minDays + maxDays) / 2)
        const idealDueAt = new Date(nowDate.getTime() + idealDays * 24 * 60 * 60 * 1000).toISOString()
        const smoothed = (maxDays - minDays >= 1)
          ? await smoothDueDate(userId, idealDueAt, minDays, maxDays, idealDays, stateRepo)
          : idealDueAt
        newState = { ...newState, dueAt: smoothed, intervalDays: idealDays, scheduledIntervalDays: idealDays, typedDueAt: smoothed, typedIntervalDays: idealDays }
        // pipeline.ts appended INITIAL_INTERVAL['good']=3 before we knew idealDays; replace it
        if (newState.intervalHistory.length > 0) {
          newState = { ...newState, intervalHistory: [...newState.intervalHistory.slice(0, -1), idealDays] }
        }
        pipelineTypingErrorsRef.current.delete(card.id)
      }

      // Snap to start of logical day so all cards due on the same day appear
      // simultaneously rather than trickling in as fractional intervals expire.
      if (newState.graduated && newState.dueAt && newState.relearningStep === 0) {
        newState = { ...newState, dueAt: snapDueAtToStartOfDay(newState.dueAt, tzRef.current, turnoverRef.current) }
      }

      // Typed track: keep typedDueAt in sync with dueAt after scheduling.
      if (newState.graduated && !scheduled?.relearn && reviewTrack === 'typed') {
        newState = { ...newState, typedDueAt: newState.dueAt, typedIntervalDays: newState.intervalDays }
        // Phase 1 completion: once last 3 typed reviews are all correct, activate the recall track.
        if (wasCorrect && !newState.recallDueAt) {
          const w = newState.typedAccuracyWindow
          if (w.length >= 3 && w.slice(-3).every(v => v === 1)) {
            const recallInterval = Math.round((newState.typedIntervalDays ?? newState.intervalDays) * 1.5)
            newState = { ...newState, recallIntervalDays: recallInterval, recallDueAt: new Date(nowDate.getTime() + recallInterval * 86_400_000).toISOString() }
          }
        }
        // One-way typed→recall credit: push recall due date if it falls within 3 days.
        if (wasCorrect && newState.recallDueAt && newState.recallIntervalDays) {
          const recallDueSoon = (new Date(newState.recallDueAt).getTime() - nowDate.getTime()) < 3 * 86_400_000
          if (recallDueSoon) {
            const priorTyped   = state.typedIntervalDays ?? 1
            const newTyped     = newState.typedIntervalDays ?? 1
            const growthRatio  = Math.max(1, newTyped / priorTyped)
            const newRecallInt = Math.min(Math.round(newState.recallIntervalDays * growthRatio), schedulerParams.maxIntervalDays)
            newState = { ...newState, recallIntervalDays: newRecallInt, recallDueAt: new Date(nowDate.getTime() + newRecallInt * 86_400_000).toISOString() }
          }
        }
      }

      // Soft-wrong split: update recall track with the user's recall rating (typed track already got 'again').
      // Works even when recallDueAt is null (card predates dual-track) — initialises recall from the typed interval.
      if (softWrongRecallRating && newState.graduated && !isRecallReview && (reviewTrack === 'typed' || reviewTrack === 'legacy')) {
        const recallIntervalBase = state.recallIntervalDays ?? state.typedIntervalDays ?? state.intervalDays
        const recallBase = { ...state, intervalDays: recallIntervalBase, scheduledIntervalDays: recallIntervalBase }
        const recallSched = scheduleNext(recallBase, softWrongRecallRating, { now: nowDate, wrongSeverity: undefined, params: schedulerParams })
        const newRecallDueAt = recallSched.dueAt
          ? snapDueAtToStartOfDay(recallSched.dueAt, tzRef.current, turnoverRef.current)
          : state.recallDueAt
        newState = { ...newState, recallIntervalDays: recallSched.intervalDays, recallDueAt: newRecallDueAt }
      }

      // Legacy track: check Phase 1 completion when review was typed.
      if (newState.graduated && !scheduled?.relearn && reviewTrack === 'legacy' && wasTyped && wasCorrect && !newState.recallDueAt) {
        const w = newState.typedAccuracyWindow
        if (w.length >= 3 && w.slice(-3).every(v => v === 1)) {
          const recallInterval = Math.round(newState.intervalDays * 1.5)
          newState = { ...newState, recallIntervalDays: recallInterval, recallDueAt: new Date(nowDate.getTime() + recallInterval * 86_400_000).toISOString() }
        }
      }

      // Post-acceleration restart window: 2+ wrong answers in 3 attempts → restart pipeline.
      if (state.graduated && state.acceleratedMode === 'none' && state.postAccelRestartWindow > 0) {
        const newWindow = state.postAccelRestartWindow - 1
        const newWrong  = state.postAccelWrongCount + (wasCorrect ? 0 : 1)
        if (newWrong >= 2) {
          newState = {
            ...initialCardState(userId, card.id, pipeline.id),
            introducedDate:         state.introducedDate,
            acceleratedMode:        'none',
            postAccelRestartWindow: 0,
            postAccelWrongCount:    0,
          }
        } else {
          newState = { ...newState, postAccelRestartWindow: newWindow, postAccelWrongCount: newWrong }
        }
      }

      await stateRepo.upsert(newState)

      // Lazy reverse-row creation (deferred from above — uses newState's forward due date).
      if (reverseExistsForLazyInit === false) {
        const fwdNextDue  = newState.typedDueAt ?? newState.dueAt ?? nowDate.toISOString()
        const fwdInterval = newState.typedIntervalDays ?? newState.intervalDays
        const revInterval = Math.max(1, Math.round(fwdInterval / 2))
        const revDueAt    = new Date(new Date(fwdNextDue).getTime() + revInterval * 86_400_000).toISOString()
        await stateRepo.upsert({
          ...initialCardState(userId, card.id, pipeline.id),
          graduated:             true,
          reviewDirection:       'reverse',
          intervalDays:          revInterval,
          scheduledIntervalDays: revInterval,
          recallIntervalDays:    revInterval,
          recallDueAt:           revDueAt,
          dueAt:                 revDueAt,
          lastReviewedAt:        nowDate.toISOString(),
          graduatedAt:           state.graduatedAt ?? nowDate.toISOString(),
          introducedDate:        state.introducedDate,
        })
      }

      // Create reverse-direction row when a card just graduated.
      if (!state.graduated && newState.graduated) {
        const fwdNextDue  = newState.typedDueAt ?? newState.dueAt ?? nowDate.toISOString()
        const revInterval = Math.max(1, Math.round(newState.intervalDays / 2))
        const revDueAt    = new Date(new Date(fwdNextDue).getTime() + revInterval * 86_400_000).toISOString()
        await stateRepo.upsert({
          ...initialCardState(userId, card.id, pipeline.id),
          graduated:             true,
          reviewDirection:       'reverse',
          intervalDays:          revInterval,
          scheduledIntervalDays: revInterval,
          recallIntervalDays:    revInterval,
          recallDueAt:           revDueAt,
          dueAt:                 revDueAt,
          lastReviewedAt:        nowDate.toISOString(),
          graduatedAt:           nowDate.toISOString(),
          introducedDate:        getToday(tzRef.current, turnoverRef.current),
        })
      }

      // Co-advance all synonym group members at the same pre-graduation step.
      // Steps 3 (TypingMode, same back answer) and 4 (final recognition) are
      // only rendered for the representative card.  Running progressAfterReview
      // for the other members here keeps every group member in sync so none
      // get stuck behind while the representative moves on.
      const coAdvancedStates = new Map<string, CardState>()
      if (!state.graduated && card.synonymGroupId) {
        const groupMemberIds = synonymGroups.get(card.synonymGroupId)?.itemIds ?? []
        for (const memberId of groupMemberIds) {
          if (memberId === card.id) continue
          const memberCard  = allCards.find(c => c.id === memberId)
          const memberState = cardStates.get(memberId)
          if (!memberCard || !memberState || memberState.graduated) continue
          if (memberState.currentStepOrder !== state.currentStepOrder) continue
          const memberNewState = progressAfterReview(
            memberState, pipeline,
            { wasCorrect, rating, wrongSeverity: undefined, wasTyped: wasTyped ?? false },
            nowDate,
          )
          await stateRepo.upsert(memberNewState)
          coAdvancedStates.set(memberId, memberNewState)
        }
      }

      setCardStates(prev => {
        const next = new Map(prev)
        next.set(card.id, newState)
        for (const [id, s] of coAdvancedStates) next.set(id, s)
        return next
      })

      // Capture undo entry before any branch that advances the index.
      setUndoStack(prev => [...prev.slice(-9), { queueIndex: index, prevState: { ...state }, newState }])
      setRedoStack([])

      // 10-minute "Again" relearn loop: hold the card in the relearn pool until
      // its dueAt passes. The pool-injection useEffect above reintroduces it
      // once the main queue runs out, ordered by elapsed percentage.
      if (newState.graduated && newState.relearningStep > 0) {
        const requeued: SessionCard = { card, state: newState, pipeline, productionMode: decideProductionMode(newState, nowDate) }
        setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: newState } : item))
        setRelearnPool(prev => [...prev, requeued])
        setIndex(i => i + 1)
        return
      }

      setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: newState } : item))

      // Re-insert the group into the queue when the representative advances to
      // a new step within the same-day window.  This lets steps 3 and 4 run
      // in the same session as step 2, preventing same-day-window resets.
      const windowStart = sortedSteps[Math.max(0, sortedSteps.length - 3)]!
      const didReinsert = (
        !newState.graduated &&
        newState.currentStepOrder !== state.currentStepOrder &&
        newState.currentStepOrder >= windowStart.stepOrder &&
        !!card.synonymGroupId
      )
      if (didReinsert) {
        const currentItem = queue[index]!
        setQueue(prev => {
          const next = [...prev]
          next.splice(index + 1, 0, { ...currentItem, state: newState })
          return next
        })
      }

      // `queue.length` is stale here when we just re-inserted, so use
      // `didReinsert` to guarantee advancement in that case.
      if (didReinsert || index + 1 < queue.length || relearnPool.length > 0) {
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
  }, [queue, index, userId, gradingSettings, submitting, relearnPool, synonymGroups, allCards, cardStates])

  const handleUndo = useCallback(async () => {
    const entry = undoStack[undoStack.length - 1]
    if (!entry || submitting) return
    setUndoStack(prev => prev.slice(0, -1))
    setRedoStack(prev => [...prev, entry])
    try {
      const stateRepo = new SupabaseCardStateRepository()
      await stateRepo.upsert(entry.prevState)
      setCardStates(prev => { const n = new Map(prev); n.set(entry.prevState.cardId, entry.prevState); return n })
      setQueue(prev => prev.map((item, i) => i === entry.queueIndex ? { ...item, state: entry.prevState } : item))
      setRelearnPool(prev => prev.filter(item => item.card.id !== entry.prevState.cardId))
      setDone(false)
      setIndex(entry.queueIndex)
    } catch (err) { console.error('Undo failed:', err) }
  }, [undoStack, submitting])

  const handleRedo = useCallback(async () => {
    const entry = redoStack[redoStack.length - 1]
    if (!entry || submitting) return
    setRedoStack(prev => prev.slice(0, -1))
    setUndoStack(prev => [...prev, entry])
    try {
      const stateRepo = new SupabaseCardStateRepository()
      await stateRepo.upsert(entry.newState)
      setCardStates(prev => { const n = new Map(prev); n.set(entry.newState.cardId, entry.newState); return n })
      setQueue(prev => prev.map((item, i) => i === entry.queueIndex ? { ...item, state: entry.newState } : item))
      const nextIdx = entry.queueIndex + 1
      if (nextIdx >= queue.length && relearnPool.length === 0) { setDone(true) } else { setIndex(nextIdx) }
    } catch (err) { console.error('Redo failed:', err) }
  }, [redoStack, submitting, queue.length, relearnPool.length])

  // Keyboard undo/redo: Cmd+Z / Ctrl+Z to undo, Cmd+Shift+Z / Ctrl+Shift+Z / Ctrl+Y to redo.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); void handleUndo() }
      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); void handleRedo() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleUndo, handleRedo])

  /**
   * Called by SynonymTypingMode (pipeline multi-field prompt) with ALL field
   * results at once.  Updates every group member's CardState, marks them
   * answered in the pre-fill store, adds them to sessionAnsweredSynonyms so
   * they auto-advance if they appear later in the queue, then advances.
   */
  const handleSynonymTypingAdvance = useCallback(async (
    results: Array<{ lexicalItemId: string; rating: Rating; wasCorrect: boolean; issueType?: GradingIssueType }>,
  ) => {
    if (submitting) return
    setSubmitting(true)
    setAnswerError(null)
    try {
      const currentPipeline = queue[index]?.pipeline
      if (!currentPipeline) { setIndex(i => i + 1); return }

      const stateRepo  = new SupabaseCardStateRepository()
      const eventRepo  = new SupabaseReviewEventRepository()
      const nowDate    = new Date()
      const newStates  = new Map<string, CardState>()

      for (const { lexicalItemId, rating, wasCorrect } of results) {
        const memberCard  = allCards.find(c => c.id === lexicalItemId)
        const memberState = cardStates.get(lexicalItemId)
        if (!memberCard || !memberState) continue

        const sortedSteps = [...currentPipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
        const step = sortedSteps.find(s => s.stepOrder === memberState.currentStepOrder) ?? sortedSteps[0]!
        const reviewMode  = classifyReviewMode(memberState, nowDate)

        await eventRepo.create({
          userId, cardId: memberCard.id, mode: step.stepType,
          promptSide: step.promptSide, answerSide: step.answerSide,
          promptShown: step.promptSide === 'front' ? memberCard.front : memberCard.back,
          expected:    step.answerSide === 'front' ? memberCard.front : memberCard.back,
          userAnswer:  wasCorrect ? (step.answerSide === 'front' ? memberCard.front : memberCard.back) : '',
          wasCorrect, rating, responseMs: null, reviewMode, wasTyped: true,
        })

        const newState = progressAfterReview(
          memberState, currentPipeline,
          { wasCorrect, rating, wrongSeverity: undefined, wasTyped: true },
          nowDate,
        )
        await stateRepo.upsert(newState)
        newStates.set(lexicalItemId, newState)
      }

      // Members that advanced to a new step must NOT be marked as answered
      // today — they need to appear fresh at the new step (step 3 asks a
      // different direction than step 2).  Members that stayed at the same
      // step are done for today and should be pre-filled on re-entry.
      const advancingIds = new Set<string>()
      for (const { lexicalItemId } of results) {
        const prev = cardStates.get(lexicalItemId)
        const next = newStates.get(lexicalItemId)
        if (prev && next && !next.graduated && next.currentStepOrder !== prev.currentStepOrder) {
          advancingIds.add(lexicalItemId)
        }
      }
      for (const { lexicalItemId, wasCorrect } of results) {
        if (wasCorrect && !advancingIds.has(lexicalItemId)) {
          markSynonymAnswered(userId, lexicalItemId, studyDayKey)
        }
      }

      setCardStates(prev => {
        const next = new Map(prev)
        for (const [id, state] of newStates) next.set(id, state)
        return next
      })
      // Only add to sessionAnsweredSynonyms for members that stayed at the
      // same step — advancing members need to be shown at the new step.
      setSessionAnsweredSynonyms(prev => {
        const next = new Set(prev)
        for (const { lexicalItemId } of results) {
          if (!advancingIds.has(lexicalItemId)) next.add(lexicalItemId)
        }
        return next
      })
      // If any member advanced to a new step, re-insert the group into the
      // queue so the next step runs in the same session.  This keeps synonym
      // groups from spanning multiple sessions and triggering same-day-window
      // resets.
      if (advancingIds.size > 0) {
        const repId       = queue[index]?.card.id
        const repNewState = repId ? newStates.get(repId) : undefined
        if (repNewState && !repNewState.graduated) {
          const currentItem = queue[index]!
          setQueue(prev => {
            const next = [...prev]
            next.splice(index + 1, 0, { ...currentItem, state: repNewState })
            return next
          })
        }
      }
      setIndex(i => i + 1)
    } catch (err: unknown) {
      console.error('Failed to record synonym answer:', err)
      setAnswerError(err instanceof Error ? err.message : 'Something went wrong saving your answer. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [queue, index, userId, allCards, cardStates, submitting, studyDayKey])

  /**
   * Called by SynonymDueNowMode when the learner types a synonym word during
   * the Due Now sequential chain.  Credits the synonym's SRS state and marks
   * it in the pre-fill store.
   */
  const handleSynonymDueNowTyped = useCallback(async (synonymCardId: string) => {
    const memberCard  = allCards.find(c => c.id === synonymCardId)
    const memberState = cardStates.get(synonymCardId)
    const pipeline    = queue[index]?.pipeline
    if (!memberCard || !memberState || !pipeline) return

    try {
      const stateRepo  = new SupabaseCardStateRepository()
      const eventRepo  = new SupabaseReviewEventRepository()
      const nowDate    = new Date()
      const reviewMode = classifyReviewMode(memberState, nowDate)

      await eventRepo.create({
        userId, cardId: memberCard.id, mode: 'typing',
        promptSide: 'back', answerSide: 'front',
        promptShown: memberCard.back, expected: memberCard.front,
        userAnswer: memberCard.front,
        wasCorrect: true, rating: 'good', responseMs: null,
        reviewMode, wasTyped: true,
      })

      const newState = progressAfterReview(
        memberState, pipeline,
        { wasCorrect: true, rating: 'good', wrongSeverity: undefined, wasTyped: true },
        nowDate,
      )
      await stateRepo.upsert(newState)
      setCardStates(prev => { const n = new Map(prev); n.set(synonymCardId, newState); return n })
      markSynonymAnswered(userId, synonymCardId, studyDayKey)
      setSessionAnsweredSynonyms(prev => new Set([...prev, synonymCardId]))
    } catch (err) {
      console.error('Failed to credit synonym state:', err)
    }
  }, [queue, index, userId, allCards, cardStates, studyDayKey])

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
      const { card, state, pipeline, productionMode, isReverse } = current
      const stateRepo  = new SupabaseCardStateRepository()
      const eventRepo  = new SupabaseReviewEventRepository()
      const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
      const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!
      const reviewPromptSide: CardSide = state.graduated ? (isReverse ? 'front' : 'back') : step.promptSide
      const reviewAnswerSide: CardSide = state.graduated ? (isReverse ? 'back'  : 'front') : step.answerSide

      const nowDate    = new Date()
      const reviewMode = classifyReviewMode(state, nowDate)
      const prevState  = { ...state }

      // Count "?" as one struggle regardless of step type.
      if (!state.graduated) {
        pipelineTypingErrorsRef.current.set(card.id, (pipelineTypingErrorsRef.current.get(card.id) ?? 0) + 1)
      }

      let newState = state
      const penaltyCount = state.graduated ? 1 : 3
      for (let i = 0; i < penaltyCount; i++) {
        const idkEvent = await eventRepo.create({
          userId: userId, cardId: card.id, mode: step.stepType,
          promptSide: reviewPromptSide, answerSide: reviewAnswerSide,
          promptShown: reviewPromptSide === 'front' ? card.front : card.back,
          expected:    reviewAnswerSide === 'front' ? card.front : card.back,
          userAnswer: '', wasCorrect: false, rating: 'again', responseMs: null,
          reviewMode, wasTyped: state.graduated ? productionMode === 'typed' : null,
        })
        const wasGraduated = newState.graduated
        newState = progressAfterReview(newState, pipeline, { wasCorrect: false, rating: 'again', wrongSeverity: undefined, wasTyped: false }, nowDate)
        if (wasGraduated && !newState.graduated) {
          eventRepo.markLapsed(idkEvent.id, userId).catch(() => {})
        }
      }

      const counted = { ...newState, iDontKnowCount: (prevState.iDontKnowCount ?? 0) + 1 }
      await stateRepo.upsert(counted)
      setCardStates(prev => { const m = new Map(prev); m.set(card.id, counted); return m })

      // True when the penalty sent the card backwards in the pipeline (e.g. typing-streak reset to step 0).
      const wasReset = counted.currentStepOrder < prevState.currentStepOrder

      const requeued: SessionCard = { card, state: counted, pipeline, productionMode, idontknow: true }
      if (counted.graduated && counted.relearningStep > 0) {
        // Graduated card entered relearn loop — hold in pool until timer elapses
        setQueue(prev => prev.map((item, i) => i === index ? { ...current, state: counted } : item))
        setRelearnPool(prev => [...prev, requeued])
      } else {
        // Pre-graduation or relapsed back into pipeline — reinsert ahead, displace last card.
        setQueue(prev => {
          const next = [...prev]
          if (!wasReset) {
            // Normal ? press: update the current slot so state stays consistent
            next[index] = { ...current, state: counted }
          }
          // If the card was reset to an earlier step, leave the current slot alone so
          // the active component (TypingMode) doesn't get replaced mid-screen.
          if (index + 1 < next.length) {
            const offset = wasReset ? 3 : IDONTKNOW_REQUEUE_OFFSET
            const insertPos = Math.min(index + 1 + offset, next.length)
            next.splice(insertPos, 0, requeued)
            next.pop()
          }
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
    const { pipeline } = current
    const siblingCard = allCards.find(c => c.id === siblingCardId)
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
  }, [queue, index, userId, allCards])

  /**
   * "Repeat" — credits the current correct answer, then reinserts it REPEAT_REQUEUE_OFFSET
   * slots ahead. The last card in the queue is displaced (removed) to keep the total count
   * constant. If there are no future cards to displace, just advances normally.
   */
  const handleRepeat = useCallback(() => {
    const current = queue[index]
    if (!current) return
    if (!current.state.graduated) {
      pipelineTypingErrorsRef.current.set(current.card.id, (pipelineTypingErrorsRef.current.get(current.card.id) ?? 0) + 1)
    }
    if (index + 1 < queue.length) {
      const insertAt = Math.min(index + 1 + REPEAT_REQUEUE_OFFSET, queue.length)
      setQueue(prev => {
        const next = [...prev]
        next.splice(insertAt, 0, { ...current, state: { ...current.state, correctInStep: 0 } })
        next.pop()
        return next
      })
    }
    handleAnswer('good', true, '')
  }, [queue, index, handleAnswer])

  const handleResetCard = useCallback(() => {
    const current = queue[index]
    if (!current) return
    const stateRepo = new SupabaseCardStateRepository()
    const fresh = initialCardState(userId, current.card.id, current.pipeline.id)
    stateRepo.upsert(fresh).catch(console.error)
    // Remove the reverse-direction row so it no longer appears as due; a new one
    // will be created when this card re-graduates through the pipeline.
    stateRepo.delete(userId, current.card.id, 'reverse').catch(console.error)
    setIndex(i => i + 1)
  }, [queue, index, userId])

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading session…</div>

  if (showElectivePicker && electivePickerData) {
    return <ElectivePicker deckId={deckId} deckUrl={deckUrl} data={electivePickerData} onStart={startElectiveSession} />
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
            <Link href={deckUrl} className="btn-primary">Back to deck</Link>
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
          <Link href={deckUrl} className="btn-primary">Back to deck</Link>
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

  const current = queue[index]
  if (!current) return null // pool-injection useEffect will add a card momentarily
  const { card, state, pipeline, isReverse: currentIsReverse } = current
  const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!
  const reviewPromptSide: CardSide = state.graduated ? (currentIsReverse ? 'front' : 'back') : step.promptSide
  const reviewAnswerSide: CardSide = state.graduated ? (currentIsReverse ? 'back'  : 'front') : step.answerSide
  // Repeat is offered when a correct answer would complete the current pipeline step.
  const stepWillComplete = !state.graduated && state.correctInStep + 1 >= step.requiredCorrect

  // ── Synonym group info for the current card ─────────────────────────────────
  const synGroup = card.synonymGroupId ? synonymGroups.get(card.synonymGroupId) : null
  // Other members of the group (the current card is excluded).
  const synMemberCards: Card[] = synGroup
    ? synGroup.itemIds
        .filter(id => id !== card.id)
        .map(id => allCards.find(c => c.id === id))
        .filter((c): c is Card => c !== undefined)
    : []

  // For pipeline typing: only use multi-field when answers are distinct across
  // members (stage 2: different fronts).  Stage 3 with a shared back falls
  // back to the regular TypingMode since all boxes would be identical.
  const synTypingIsNativeToTarget = step.promptSide === 'back' // true for stage 2
  const synTypingExpected = (m: Card) => synTypingIsNativeToTarget ? m.front : m.back
  const synAllMembers = synMemberCards.length > 0 ? [card, ...synMemberCards] : []
  const synAnswersDistinct =
    synAllMembers.length > 1 &&
    new Set(synAllMembers.map(m => synTypingExpected(m).trim().toLowerCase())).size > 1

  // For Due Now chain: IDs already answered today (localStorage) or this session.
  const synPreAnsweredIds = new Set<string>([
    ...synMemberCards
      .filter(m => wasSynonymAnswered(userId, m.id, studyDayKey))
      .map(m => m.id),
    ...sessionAnsweredSynonyms,
  ])

  const promptShowsSource = !state.graduated ? step.promptSide === 'front' : reviewPromptSide === 'front'
  const currentIpaText = showIPA && promptShowsSource
    ? (ipaCache.get(card.id) ?? card.ipa ?? undefined)
    : undefined
  const softWrongEnabled = state.graduated && !currentIsReverse &&
    current.reviewTrack !== 'recall' && forwardTypedEnabled && forwardRecallEnabled

  return (
    <div className="space-y-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between">
        <Link href={deckUrl} className="text-sm text-ink-muted hover:text-ink">✕ End session</Link>
        <div className="text-xs text-ink-muted">{index + 1} / {queue.length}</div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-ink-muted">
            {state.graduated
              ? (currentIsReverse ? 'Reverse recall' : current.reviewTrack === 'recall' ? 'Recall' : 'Review')
              : `Step ${state.currentStepOrder + 1} · ${step.stepType}`}
          </div>
        </div>
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
        // ── Pre-graduation MC ────────────────────────────────────────────────
        // Stage 1 (native→target): exclude other group members' fronts from
        //   distractors (they're also correct answers).
        // Stages 0 & 4 (target→native): split the back gloss into individual
        //   words and display one randomly as the correct answer.
        <MultipleChoiceMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide} answerSide={step.answerSide}
          deckCards={allCards} sourceLanguage={sourceLanguage} targetLanguage={targetLanguage}
          autoPlayAudio={gradingSettings?.autoPlayAudio ?? true}
          excludeAnswerTexts={step.answerSide === 'front' && synMemberCards.length > 0
            ? synMemberCards.map(m => m.front) : undefined}
          splitGlossFromBack={step.answerSide === 'back'}
          onChoicesCached={handleChoicesCached}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onRepeat={handleRepeat}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${step.answerSide}`) ?? [])}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, step.answerSide, answerText, accept)}
          onPromptEdit={t => handlePromptEdit(card.id, step.promptSide, t)}
          onChoiceEdit={(orig, newText, isCorrect) => handleChoiceEdit(card.id, step.answerSide, orig, newText, isCorrect)}
          ipaText={currentIpaText} onToggleIPA={() => setShowIPA(v => !v)} />
      ) : !state.graduated && step.stepType === 'typing' && synAnswersDistinct ? (
        // ── Pipeline multi-field synonym typing ──────────────────────────────
        // Stages 2 & 3 where group members have distinct expected answers.
        <SynonymTypingMode
          key={`${card.id}-${index}`}
          prompt={(() => {
            const gloss = synTypingIsNativeToTarget
              ? card.back
              : synAllMembers.map(m => m.front).join(', ')
            const fields: SynonymAnswerField[] = synAllMembers.map(m => {
              const expected   = synTypingExpected(m)
              const isPrefilled = wasSynonymAnswered(userId, m.id, studyDayKey)
              return {
                lexicalItemId:  m.id,
                expectedAnswer: expected,
                status:  isPrefilled ? 'prefilled' : 'due_blank',
                value:   isPrefilled ? expected : '',
                dueState: isPrefilled ? 'not_due' : 'due',
                register: m.register,
                region:   m.region,
              }
            })
            return { synonymGroupId: card.synonymGroupId!, gloss, fields } satisfies SynonymProductionPrompt
          })()}
          gradingSettings={gradingSettings!}
          gradedReview={false}
          onAdvance={handleSynonymTypingAdvance}
        />
      ) : !state.graduated ? (
        // ── Pipeline single-field typing (or stage 3 with shared back) ───────
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          promptLanguage={step.promptSide === 'front' ? sourceLanguage : undefined}
          answerLanguage={step.promptSide === 'back' ? sourceLanguage : targetLanguage}
          gradingSettings={gradingSettings!} autoPlayAudio={gradingSettings?.autoPlayAudio ?? true} gradedReview={false}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${step.answerSide}`) ?? [])}
          synonyms={step.answerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
          deckSiblings={deckSiblings(card, step.answerSide, allCards)}
          onSiblingAnswered={handleSiblingAnswered}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, step.answerSide, answerText, accept)}
          onRepeat={handleRepeat}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)}
          onPromptEdit={t => handlePromptEdit(card.id, step.promptSide, t)}
          ipaText={currentIpaText} onToggleIPA={() => setShowIPA(v => !v)} />
      ) : current.productionMode === 'self-graded' ? (
        // ── Post-graduation self-graded flashcard ────────────────────────────
        <FlashcardMode key={`${card.id}-${index}`} card={card} promptSide={reviewPromptSide}
          onRate={rating => handleAnswer(rating, rating !== 'again')}
          onPromptEdit={t => handlePromptEdit(card.id, reviewPromptSide, t)} />
      ) : synMemberCards.length > 0 ? (
        // ── Post-graduation typed recall with synonym chain ──────────────────
        <SynonymDueNowMode
          key={`${card.id}-${index}`}
          card={card}
          synonymMembers={synMemberCards}
          preAnsweredIds={synPreAnsweredIds}
          gradingSettings={gradingSettings!}
          overrideAnswers={Array.from(overrides.get(`${card.id}:front`) ?? [])}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)}
          onSynonymTyped={handleSynonymDueNowTyped}
          onPromptEdit={t => handlePromptEdit(card.id, reviewPromptSide, t)}
        />
      ) : (
        // ── Post-graduation typed recall (no synonym group) ───────────────────
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={reviewPromptSide}
          promptLanguage={reviewPromptSide === 'front' ? sourceLanguage : undefined}
          answerLanguage={reviewPromptSide === 'back' ? sourceLanguage : targetLanguage}
          gradingSettings={gradingSettings!} autoPlayAudio={gradingSettings?.autoPlayAudio ?? true} gradedReview={true}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${reviewAnswerSide}`) ?? [])}
          synonyms={reviewAnswerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
          deckSiblings={deckSiblings(card, reviewAnswerSide, allCards)}
          onSiblingAnswered={handleSiblingAnswered}
          onOverrideAnswer={(answerText, accept) => handleOverrideAnswer(card.id, reviewAnswerSide, answerText, accept)}
          onRate={(rating, wasCorrect, userAnswer, issueType, softWrongRecallRating) => handleAnswer(rating, wasCorrect, userAnswer, issueType, softWrongRecallRating)}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onPromptEdit={t => handlePromptEdit(card.id, reviewPromptSide, t)}
          onResetCard={handleResetCard}
          softWrongEnabled={softWrongEnabled}
          ipaText={currentIpaText} onToggleIPA={() => setShowIPA(v => !v)} />
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
function ElectivePicker({ deckId: _deckId, deckUrl, data, onStart }: {
  deckId:  string
  deckUrl: string
  data:    ElectivePickerData
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
        <Link href={deckUrl} className="btn-ghost">Back to deck</Link>
      </div>
    </div>
  )
}
