'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { useActiveTimer } from '@/lib/activeTimer'
import { loadProfileRow } from '@/lib/offline/profilePrefs'
import { apiUrl } from '@/lib/apiBase'
import { routes } from '@/lib/routes'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }            from '@/lib/data/decks'
import { SupabaseCardRepository }            from '@/lib/data/cards'
import { SupabaseCardStateRepository }       from '@/lib/data/cardStates'
import { SupabaseReviewEventRepository }     from '@/lib/data/reviewEvents'
import { SupabaseLadderClimbRepository }     from '@/lib/data/ladderClimb'
import { SupabasePipelineRepository }        from '@/lib/data/pipelines'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { setAudioPlaybackRate, setAudioVolume, setAudioSourceDefault, setAudioSourceByLanguage } from '@/lib/speak'
import { hydrateSessionAudio, needsAudioHydration, applyAudioPatch, type AudioPatch } from '@/lib/sessionAudio'
import { markReverseDormant } from '@/lib/dormancy'
import { SupabaseCardConfusionRepository }   from '@/lib/data/cardConfusions'
import { SupabaseTypingErrorMarkRepository } from '@/lib/data/typingErrorMarks'
import { SupabaseCardConfusionLinkRepository } from '@/lib/data/cardConfusionLinks'
import { interleaveConfusablePairs } from '@/engine/confusion'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import type { CardSide } from '@/domain'
import { progressAfterReview, initialCardState, appendHistory } from '@/engine/pipeline'
import { classifyWrongAnswer, isDifferentWordMistake } from '@/engine/grading'
import { smoothDueDate } from '@/engine/density'
import { classifyReviewMode, isGraduatedDueByDate, graduationIntervalRange } from '@/engine/scheduler'
import { scheduleGraduatedFsrs, RELEARN_MINUTES, seedDifficulty } from '@/engine/dueNow'
import { DEFAULT_FSRS_CONFIG, fsrsFuzzRange, nextDifficulty } from '@/engine/fsrs'
import { decideProductionMode, type ProductionMode } from '@/engine/productionMode'
import type { Card, CardState, Pipeline, Rating, GradingSettings, CardConfusion, SynonymGroup, SynonymAnswerField, SynonymProductionPrompt, GradingIssueType, SchedulerParams, TypedErrorCategory, TypedStrictness } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS, DEFAULT_GRADING_SETTINGS, DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { TypingMode } from '@/components/session/TypingMode'
import { MultipleChoiceMode } from '@/components/session/MultipleChoiceMode'
import { SynonymTypingMode } from '@/components/session/SynonymTypingMode'
import { SynonymDueNowMode } from '@/components/session/SynonymDueNowMode'
import { prefetchChoices, prefetchAudio, promoteConfusionDistractors, deckSiblings, needsChoices, ensureChoicesGenerated, type PrefetchItem, type ConfusionPromotionItem } from '@/lib/distractors'
import { getToday, snapDueAtToStartOfDay } from '@/lib/dates'
import { forwardStateMap } from '@/lib/cardStateMap'
import { computeActiveLearningSet, dedupeDueReviews, buildEnabledTracksMap, trackEnabled, activeProductionTrack, forwardProductionMode, buildCalibrationMap, calibrationFor, buildRetentionMap, retentionFor, type EnabledTracks } from '@/lib/sessionLimits'
import { respondToProductionConfusion } from '@/lib/confusionResponse'
import { ConfusionDrill } from '@/components/session/ConfusionDrill'
import { UndoFab } from '@/components/session/UndoFab'
import { CardEditModal } from '@/components/CardEditModal'
import { SupabaseSynonymGroupRepository } from '@/lib/data/synonymGroups'
import { markSynonymAnswered, unmarkSynonymAnswered, wasSynonymAnswered, purgeStaleSynonymPrefill } from '@/lib/synonymPrefill'
import { triggerSyncFill } from '@/lib/triggerSyncFill'

const REPEAT_REQUEUE_OFFSET    = 8
const IDONTKNOW_REQUEUE_OFFSET = 4
const HINT_HARD_REQUEUE_OFFSET = 6   // hint-assisted "Hard" re-shows this session instead of advancing
const ALMOST_REQUEUE_OFFSET = 4      // self-graded "Almost" re-shows this session; the re-rating schedules
const DRILL_OFFSET             = 3   // A-vs-B confusion drill lands this many cards ahead (before A/B recur)

interface SessionCard {
  card: Card
  state: CardState
  pipeline: Pipeline
  /** For graduated cards: whether this review should use typed or self-graded production. Null pre-graduation. */
  productionMode: ProductionMode | null
  /** Which interval track triggered this queue entry ('typed' | 'recall' | 'legacy'). Undefined for pipeline cards. */
  reviewTrack?: 'typed' | 'recall' | 'legacy' | 'smart'
  /** True when this entry is for the reverse-direction (Spanish→English) recall row. */
  isReverse?: boolean
  /** Marks a copy of a card re-inserted after "I don't know" — used for undo cleanup. */
  idontknow?: true
  /** Answer counter when this card lapsed into the relearn pool (drives the batch-size resurface window). */
  relearnLapsedAt?: number
  /** When set, this queue item is an A-vs-B discrimination drill (card is A; otherFront is B's word). */
  drill?: { otherFront: string; otherId: string }
}

/** A single elective study category, chosen either via a deck-stat "Study" button (?category=) or the elective picker. */
type StudyCategory = 'new' | 'learning' | 'graduated' | 'due' | 'dormant'

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
  dormant:   'Reviewing dormant cards (they stay dormant).',
}

const CATEGORY_EMPTY_MESSAGE: Record<StudyCategory, string> = {
  new:       'You have no unlearned cards in this deck.',
  learning:  'You have no cards currently in the learning pipeline.',
  graduated: 'You have no graduated cards yet.',
  due:       'You have no cards due right now.',
  dormant:   'You have no dormant cards.',
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
  const router     = useRouter()
  const searchParams = useSearchParams()
  const deckId     = searchParams.get('deck') ?? ''
  const supabase   = createClient()

  // ?category=new|learning|graduated|due — set by the per-stat "Study" buttons
  // on the deck detail page to study only that category, bypassing the
  // normal new/due queue-building below entirely.
  const categoryParam = searchParams.get('category')
  const category: StudyCategory | null =
    categoryParam === 'new' || categoryParam === 'learning' || categoryParam === 'graduated' || categoryParam === 'due' || categoryParam === 'dormant'
      ? categoryParam
      : null

  // When a category session completes, return to the deck page with the same
  // filter active so the user can immediately study that category again.
  const deckUrl = category ? routes.deck(deckId, { filter: category }) : routes.deck(deckId)

  const [queue,           setQueue]           = useState<SessionCard[]>([])
  const [allCards,        setAllCards]        = useState<Card[]>([])
  const [index,           setIndex]           = useState(0)
  const reviewTimer = useActiveTimer(30_000)
  useEffect(() => { reviewTimer.current?.restart() }, [index])
  const [loading,         setLoading]         = useState(true)
  const [userId,          setUserId]          = useState('')
  const [deckName,        setDeckName]        = useState('')
  const [sourceLanguage,  setSourceLanguage]  = useState('es')
  const [targetLanguage,  setTargetLanguage]  = useState('en')
  const [gradingSettings,  setGradingSettings]  = useState<GradingSettings | null>(null)
  const [schedulerParams,  setSchedulerParams]  = useState<SchedulerParams>(DEFAULT_SCHEDULER_PARAMS)
  // Per-track FSRS interval calibration (measured-vs-target retention) for this deck's pair.
  const calRef = useRef<Record<string, number>>({})
  // Per-track FSRS target retention for this deck's pair.
  const retRef = useRef<Record<string, number>>({})
  const [forwardTypedEnabled, setForwardTypedEnabled] = useState(true)
  const [forwardRecallEnabled, setForwardRecallEnabled] = useState(true)
  const [done,            setDone]            = useState(false)
  const [emptySession,    setEmptySession]    = useState(false)
  const [electiveSession, setElectiveSession] = useState(false)
  const [cardStates,      setCardStates]      = useState<Map<string, CardState>>(new Map())
  const [answerError,     setAnswerError]     = useState<string | null>(null)
  const [submitting,      setSubmitting]      = useState(false)
  // Card info/edit modal ("i" button) — lets the learner inspect and edit the
  // current card mid-session.
  const [infoOpen,        setInfoOpen]        = useState(false)
  const [dormantNotice,   setDormantNotice]   = useState(false)
  useEffect(() => {
    if (!dormantNotice) return
    const t = setTimeout(() => setDormantNotice(false), 2800)
    return () => clearTimeout(t)
  }, [dormantNotice])
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
  const reviewCountRef = useRef(0)                    // monotonic count of answers given this session
  const batchSizeRef   = useRef(20)                   // resurface window = the session's batch size
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
  type UndoEntry = { queueIndex: number; prevState: CardState; newState: CardState; eventId: string | null; overrideAdd: { cardId: string; answerSide: CardSide; answerText: string } | null; userAnswer: string; wasCorrect: boolean; selfGraded: boolean }
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  // First Undo press lands here: re-show the just-rated card answered so a different rating can be picked;
  // a second press clears it -> the real card remounts blank (see handleUndo).
  const [reRate, setReRate] = useState<{ queueIndex: number; userAnswer: string; wasCorrect: boolean; selfGraded: boolean } | null>(null)
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);
  const pendingOverrideAddRef = useRef<{ cardId: string; answerSide: CardSide; answerText: string } | null>(null)

  const indexRef       = useRef(0)   // current queue index (for async drill insertion)
  const tzRef          = useRef('UTC')
  const turnoverRef    = useRef(0)
  // Hint usage for the current card's review — consumed once in handleAnswer.
  const hintRef        = useRef<{ level: number; growthFactor: number } | null>(null)
  const handleHint     = useCallback((level: number, growthFactor: number) => {
    hintRef.current = { level, growthFactor }
  }, [])
  // Whether the current typed answer was an "almost" (near-miss) — consumed in handleAnswer.
  const nearMissRef    = useRef(false)
  const handleNearMiss = useCallback((nearMiss: boolean) => { nearMissRef.current = nearMiss }, [])
  // Per-category typed penalty (accent/article/spelling): weight + loggable category.
  const typedPenaltyRef = useRef<{ weight: number; category: TypedErrorCategory | null } | null>(null)
  const handleTypedPenalty = useCallback((weight: number, category: TypedErrorCategory | null) => {
    typedPenaltyRef.current = { weight, category }
  }, [])

const handleOverrideAnswer = useCallback((cardId: string, answerSide: CardSide, answerText: string, accept: boolean) => {
    const repo = new SupabaseTypedAnswerOverrideRepository()
    const key  = `${cardId}:${answerSide}`
    if (accept && !(overrides.get(key)?.has(answerText) ?? false)) pendingOverrideAddRef.current = { cardId, answerSide, answerText }
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
  }, [userId, overrides])

  const handleAddSynonym = useCallback((cardId: string, answerSide: CardSide, normalizedText: string) => {
    setQueue(prev => {
      const card = prev.find(i => i.card.id === cardId)?.card
      if (!card) return prev
      const choices = card.choices ?? { front: [], back: [] }
      const updatedChoices = answerSide === 'front'
        ? { ...choices, frontSynonyms: [...(choices.frontSynonyms ?? []), normalizedText] }
        : { ...choices, backSynonyms:  [...(choices.backSynonyms  ?? []), normalizedText] }
      new SupabaseCardRepository().update(cardId, { choices: updatedChoices })
        .catch(err => console.error('Failed to save synonym:', err))
      return prev.map(i => i.card.id === cardId ? { ...i, card: { ...i.card, choices: updatedChoices } } : i)
    })
  }, [])

  const handleChoicesCached = useCallback((cardId: string, choices: Card['choices']) => {
    setAllCards(prev => prev.map(c => c.id === cardId ? { ...c, choices } : c))
    setQueue(prev => prev.map(item => item.card.id === cardId ? { ...item, card: { ...item.card, choices } } : item))
  }, [])

  const handleAudioCached = useCallback((cardId: string, audioData: string) => {
    setAllCards(prev => prev.map(c => c.id === cardId ? { ...c, audioGenerated: true, audioData } : c))
    setQueue(prev => prev.map(item => item.card.id === cardId ? { ...item, card: { ...item.card, audioGenerated: true, audioData } } : item))
  }, [])

  // ── Card info/edit modal wiring ─────────────────────────────────────────────
  // Reflect edits made in the mid-session "i" modal back into the live queue.
  const applyInfoCardChange = useCallback((updated: Card, prevId?: string) => {
    const oldId = prevId ?? updated.id
    setAllCards(prev => prev.map(c => c.id === oldId ? updated : c))
    setQueue(prev => prev.map(item => item.card.id === oldId ? { ...item, card: updated } : item))
  }, [])

  const applyInfoStateChange = useCallback((updated: CardState, prevId?: string) => {
    setCardStates(prev => {
      const n = new Map(prev)
      if (prevId && prevId !== updated.cardId) n.delete(prevId)
      n.set(updated.cardId, updated)
      return n
    })
    const oldId = prevId ?? updated.cardId
    setQueue(prev => prev.map(item => item.card.id === oldId ? { ...item, state: updated } : item))
  }, [])

  async function handleInfoSave(cardId: string, front: string, back: string) {
    const cardRepo  = new SupabaseCardRepository()
    const stateRepo = new SupabaseCardStateRepository()
    // forkInDeck edits in place if the card is only in this deck, otherwise
    // creates a deck-local fork (new id) and re-points this deck's link.
    const { card: updated, forked } = await cardRepo.forkInDeck(deckId, cardId, userId, { front, back })
    if (forked) {
      await stateRepo.copy(userId, cardId, updated.id)
      const oldState = cardStates.get(cardId)
      if (oldState) applyInfoStateChange({ ...oldState, cardId: updated.id }, cardId)
    }
    applyInfoCardChange(updated, cardId)
  }

  function handleInfoDelete(cardId: string) {
    setInfoOpen(false)
    setAllCards(prev => prev.filter(c => c.id !== cardId))
    // Dropping the current card leaves `index` pointing at the next one; if it
    // was the last card, the done/pool logic takes over.
    setQueue(prev => prev.filter(item => item.card.id !== cardId))
  }

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
    // Stored-clip hydration for the trimmed session card read (see SESSION_CARD_COLUMNS): the first
    // card autoplays on mount, so when it has a stored clip, wait for that one row; the rest patch
    // in from the background. Patches audioSources too — the ℹ modal's "Use this" spreads it back.
    const applyAudioHydration = (patch: AudioPatch) => {
      setQueue(prev => prev.map(item => {
        const card = applyAudioPatch(item.card, patch)
        return card === item.card ? item : { ...item, card }
      }))
      setAllCards(prev => prev.map(c => applyAudioPatch(c, patch)))
    }
    const first = finalQueue[0]
    if (first && needsAudioHydration(first.card)) {
      const patch = await hydrateSessionAudio([first.card], applyAudioHydration)
      const p = patch.get(first.card.id)
      if (p) first.card = { ...first.card, audioData: p.audioData, audioSources: p.audioSources }
    }
    void hydrateSessionAudio(finalQueue.slice(1).map(i => i.card), applyAudioHydration)
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

      // One wave for everything that needs only the user id + the deckId prop. The states, overrides,
      // scheduler-params and confusion-link fetches used to run as serial stages AFTER this wave —
      // ~5 round trips of pure latency. Cards come via listForDecks (SESSION_CARD_COLUMNS — no audio
      // blobs; queued clips hydrate in finalizeQueue).
      const [deck, cardsByDeck, pipeline, prefs, profileData, existingStates, existingOverrides, allRows, intraLinksAll] = await Promise.all([
        deckRepo.get(deckId),
        cardRepo.listForDecks([deckId]),
        pipelineRepo.getDefault(),
        prefRepo.get(session.user.id, deckId),
        loadProfileRow(() => supabase.from('profiles').select('timezone, day_turnover_hour, audio_source_default, audio_source_by_language').eq('user_id', session.user.id).single()),
        stateRepo.listByDeck(session.user.id, deckId),
        new SupabaseTypedAnswerOverrideRepository().listForUser(session.user.id),
        new SupabaseUserSchedulerParamsRepository().listForUser(session.user.id),
        new SupabaseCardConfusionLinkRepository().listForUser(session.user.id).catch(() => []),
      ])
      const cards = cardsByDeck.get(deckId) ?? []

      const tz           = (profileData.data?.timezone as string | null) ?? deviceTimeZone()
      const turnoverHour = (profileData.data?.day_turnover_hour as number | null) ?? 0
      setAudioSourceDefault(profileData.data?.audio_source_default as string | null)
      setAudioSourceByLanguage(profileData.data?.audio_source_by_language as Record<string, string> | null)
      tzRef.current       = tz
      turnoverRef.current = turnoverHour

      if (!deck || cards.length === 0) { router.push(routes.deck(deckId)); return }
      if (!deck.syncingComplete) triggerSyncFill()
      setDeckName(deck.name)
      setGradingSettings(deck.gradingSettings)
      setSourceLanguage(deck.sourceLanguage)
      setTargetLanguage(deck.targetLanguage)
      setAllCards(cards)

      let enabledTracks: EnabledTracks | undefined
      try {
        // The pair's row is almost always in the bulk listForUser result — the old getOrCreate here
        // cost 2 extra serial round trips. Only a genuinely new pair still awaits the create.
        const paramsRow =
          allRows.find(r => r.sourceLanguage === deck.sourceLanguage && r.targetLanguage === deck.targetLanguage && r.answerField === 'forward_typed')
          ?? await new SupabaseUserSchedulerParamsRepository().getOrCreate(
            session.user.id, deck.sourceLanguage, deck.targetLanguage, 'forward_typed',
          )
        setSchedulerParams(paramsRow)
        setForwardTypedEnabled(paramsRow.forwardTypedEnabled ?? true)
        setForwardRecallEnabled(paramsRow.forwardRecallEnabled ?? true)
        // Per-pair enabled review tracks (each flag lives on its own answer_field row).
        enabledTracks = buildEnabledTracksMap(allRows).get(`${deck.sourceLanguage}|${deck.targetLanguage}`)
        const cm = buildCalibrationMap(allRows)
        const rm = buildRetentionMap(allRows)
        const s = deck.sourceLanguage, t = deck.targetLanguage
        calRef.current = {
          forward_typed:  calibrationFor(cm, s, t, 'forward_typed'),
          forward_smart:  calibrationFor(cm, s, t, 'forward_smart'),
          forward_recall: calibrationFor(cm, s, t, 'forward_recall'),
          reverse_recall: calibrationFor(cm, s, t, 'reverse_recall'),
        }
        retRef.current = {
          forward_typed:  retentionFor(rm, s, t, 'forward_typed'),
          forward_smart:  retentionFor(rm, s, t, 'forward_smart'),
          forward_recall: retentionFor(rm, s, t, 'forward_recall'),
          reverse_recall: retentionFor(rm, s, t, 'reverse_recall'),
        }
      } catch { /* fall back to defaults */ }

      const today = getToday(tz, turnoverHour)
      setStudyDayKey(today)
      purgeStaleSynonymPrefill(session.user.id, today)
      const groupsMap = await new SupabaseSynonymGroupRepository().listForCards(cards.map(c => c.id))
      setSynonymGroups(groupsMap)

      const forwardStates   = existingStates.filter(s => s.reviewDirection !== 'reverse')
      const reverseStatesList = existingStates.filter(s => s.reviewDirection === 'reverse')
      const stateMap = forwardStateMap(forwardStates)
      setCardStates(stateMap)

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

      // Intra-language confusion links → interleave confusable pairs so they land next to each other.
      const intraLinks = intraLinksAll.filter(l => l.kind === 'intra')

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
              cards.filter(c => stateMap.get(c.id)?.graduated && !stateMap.get(c.id)!.dormant)
                .map(card => { const state = stateMap.get(card.id)!; return { card, state, pipeline, productionMode: decideProductionMode(state, now, Math.random, schedulerParams) } })
            )
            break
          case 'dormant':
            categoryQueue = shuffle(
              cards.filter(c => stateMap.get(c.id)?.dormant)
                .map(card => { const state = stateMap.get(card.id)!; return { card, state, pipeline, productionMode: decideProductionMode(state, now, Math.random, schedulerParams) } })
            )
            break
          case 'due':
            categoryQueue = shuffle(
              cards.flatMap(card => {
                const state = stateMap.get(card.id)
                if (!state?.graduated || state.dormant) return []
                // Production is one lane (typed/smart mutually exclusive): the due date may sit in the
                // typed OR smart column, but it's reviewed on whichever lane is enabled.
                const prodTrack = activeProductionTrack(enabledTracks)
                const prodDueDate = state.smartDueAt ?? state.typedDueAt ?? state.dueAt
                const items: (typeof categoryQueue)[number][] = []
                if (prodTrack && isDueByDate(prodDueDate)) items.push({ card, state, pipeline, reviewTrack: prodTrack, productionMode: forwardProductionMode(state, prodTrack, schedulerParams.smartTypingThresholdDays) })
                if (isDueByDate(state.recallDueAt) && trackEnabled(enabledTracks, 'recall', false)) items.push({ card, state, pipeline, productionMode: 'self-graded', reviewTrack: 'recall' })
                return items
              })
            )
            break
        }
        // Collapse multiple due tracks for the same card+direction into one review.
        categoryQueue = dedupeDueReviews(categoryQueue)
        // Cluster confusable due-review pairs so they land next to each other (due case only).
        if (category === 'due') categoryQueue = interleaveConfusablePairs(categoryQueue, intraLinks)
        // Slice to the elective batch limit; store the rest for "Study ahead".
        // Exception: when the learner explicitly picks the "learning" category,
        // run through every in-pipeline card (no cap) and never pull in
        // unlearned cards — they asked to clear what's already in learning.
        const capThisCategory = batchLimit != null && category !== 'learning'
        const batch = capThisCategory ? categoryQueue.slice(0, batchLimit!) : categoryQueue
        const rest  = capThisCategory ? categoryQueue.slice(batchLimit!)    : []
        setRemainingElective(rest)
        setElectiveSession(true)
        await finalizeQueue(batch, { deckCards: cards, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage, userId: session.user.id })
        return
      }

      const cardsPerSession   = prefs?.cardsPerSession   ?? null
      batchSizeRef.current = cardsPerSession && cardsPerSession > 0 ? cardsPerSession : 20
      const learningBatchMode = prefs?.learningBatchMode ?? false
      setAudioPlaybackRate(prefs?.audioSpeed ?? 1)
      setAudioVolume(prefs?.audioVolume ?? 1)

      // Exclude states for soft-deleted cards so they don't skew budget math.
      const activeCardIdSet   = new Set(cards.map(c => c.id))
      const activeStates      = existingStates.filter(s => activeCardIdSet.has(s.cardId))

      // When a per-session pipeline limit is set, `limitedLearningSet` is the
      // exact set of non-graduated card IDs allowed into this session. It caps
      // BOTH new-card introduction AND the existing in-pipeline backlog, so the
      // learner only ever works ~N cards at a time (previously the limit capped
      // new intros only, and every in-pipeline card was dumped in each session).
      // `null` = no such cap; the daily-limit path governs new intros instead.
      let limitedLearningSet: Set<string> | null = null
      let newCardBudget = 0

      if (cardsPerSession && cardsPerSession > 0) {
        limitedLearningSet = computeActiveLearningSet(
          cards, id => stateMap.get(id), cardsPerSession, learningBatchMode,
        )
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
          if (limitedLearningSet) {
            if (!limitedLearningSet.has(card.id)) continue
          } else {
            if (newCardBudget <= 0) continue
            newCardBudget--
          }
          newCards.push({ card, state: initialCardState(session.user.id, card.id, pipeline.id), pipeline, productionMode: null })
        } else if (!state.graduated) {
          // With a per-session limit, only the active set's in-pipeline cards
          // are studied — the rest of the learning backlog waits its turn.
          if (limitedLearningSet && !limitedLearningSet.has(card.id)) continue
          inPipeline.push({ card, state, pipeline, productionMode: null })
        } else if (state.graduated && state.dormant) {
          // Dormant cards never become due automatically (studyable via ?category=dormant).
        } else if (state.graduated) {
          const prodTrack = activeProductionTrack(enabledTracks)
          const prodDueDate = state.smartDueAt ?? state.typedDueAt ?? state.dueAt
          const prodDue = isDueByDate(prodDueDate)
          const isRecallDue = isDueByDate(state.recallDueAt)
          if (prodTrack && prodDue) {
            dueCards.push({ card, state, pipeline, reviewTrack: prodTrack, productionMode: forwardProductionMode(state, prodTrack, schedulerParams.smartTypingThresholdDays) })
          }
          if (isRecallDue && trackEnabled(enabledTracks, 'recall', false)) {
            dueCards.push({ card, state, pipeline, productionMode: 'self-graded', reviewTrack: 'recall' })
          }
          if (!prodDue && !isRecallDue) {
            // Graduated but nothing due yet → early-review (elective) pool.
            electiveCards.push({ card, state, pipeline, productionMode: decideProductionMode(state, now, Math.random, schedulerParams) })
          }
        }
      }

      // Add due reverse-direction rows (unless the reverse track is disabled for this pair)
      const reverseEnabled = trackEnabled(enabledTracks, 'recall', true)
      for (const reverseState of reverseStatesList) {
        if (!reverseEnabled) break
        if (reverseState.dormant) continue   // recognition paused (per-direction dormancy)
        if (!reverseState.recallDueAt || new Date(reverseState.recallDueAt) > now) continue
        const card = cards.find(c => c.id === reverseState.cardId)
        if (card) dueCards.push({ card, state: reverseState, pipeline, productionMode: 'self-graded', reviewTrack: 'recall', isReverse: true })
      }

      // Collapse multiple due tracks for the same card+direction into one review.
      const dedupedDue = dedupeDueReviews(dueCards)

      // New cards: keep in deck order (first session = ordered introduction)
      // In-pipeline + due: shuffle so session feels varied
      const finalQueue = [...newCards, ...shuffle(inPipeline), ...interleaveConfusablePairs(shuffle(dedupedDue), intraLinks)]

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

  // Relearn resurfacing. A lapsed (Again/Hard) graduated card KEEPS coming back THIS session until it
  // exits the relearn loop (Good×2 / Easy, or 3 Agains → ladder) — never deferred to a later session,
  // so difficult cards can't slip by. Resurfaces mid-session once its real-clock time passes; if the
  // main queue empties while relearns are pending, the soonest is flushed to the end.
  useEffect(() => {
    if (loading || done || showElectivePicker) return
    if (relearnPool.length === 0) { if (index >= queue.length) setDone(true); return }
    const now = Date.now()
    const dueMs = (c: SessionCard) => c.state.dueAt ? new Date(c.state.dueAt).getTime() : 0
    const due = relearnPool.filter(c => dueMs(c) <= now)
    if (due.length > 0) {
      setQueue(prev => { const at = Math.min(prev.length, index + 3); const next = [...prev]; next.splice(at, 0, ...due); return next })
      setRelearnPool(prev => prev.filter(c => !due.includes(c)))
      return
    }
    if (index >= queue.length) {
      const soonest = [...relearnPool].sort((a, b) => dueMs(a) - dueMs(b))[0]!
      setQueue(prev => [...prev, soonest])
      setRelearnPool(prev => prev.filter(c => c !== soonest))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue.length, done, loading, relearnPool, showElectivePicker])

  // Auto-advance past a synonym-group representative only when EVERY member of
  // its group is already answered for the current round (nothing left to type).
  // Skipping merely because the representative itself was answered would hide a
  // group that still has a due partner form.
  const currentCardId = !loading && !done ? queue[index]?.card.id : undefined
  useEffect(() => {
    if (!currentCardId) return
    const item = queue[index]
    const gid  = item?.card.synonymGroupId
    if (gid) {
      // Pipeline synonym groups are gated only by SESSION-scoped answers (the
      // day-persistent store applies to Due Now reviews). This lets a group
      // finish its required-correct reps within one session instead of going
      // dormant for the rest of the day.
      const graduated = item?.state.graduated
      const members = synonymGroups.get(gid)?.itemIds ?? []
      const allAnswered = members.length > 0 && members.every(id =>
        sessionAnsweredSynonyms.has(id) || (graduated && wasSynonymAnswered(userId, id, studyDayKey)),
      )
      if (allAnswered) setIndex(i => i + 1)
    } else if (sessionAnsweredSynonyms.has(currentCardId)) {
      setIndex(i => i + 1)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCardId, sessionAnsweredSynonyms])

  // Fire-and-forget calibration when the session completes.
  useEffect(() => {
    // Calibrate after any real due-review session (including category=due, which is
    // flagged elective) — only skip true study-ahead / early-review electives.
    if (!done || !userId || (electiveSession && category !== 'due')) return
    fetch(apiUrl('/api/calibrate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sourceLanguage && targetLanguage ? { userId, sourceLanguage, targetLanguage } : { userId }),
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

  useEffect(() => { indexRef.current = index }, [index])

  // Insert an A-vs-B discrimination drill a few cards ahead — but before card A or B recurs.
  function queueDrill(source: SessionCard, otherId: string, otherFront: string) {
    setQueue(prev => {
      const cur = indexRef.current
      let bound = prev.length
      for (let i = cur + 1; i < prev.length; i++) {
        const id = prev[i]!.card.id
        if (id === source.card.id || id === otherId) { bound = i; break }
      }
      const at = Math.min(cur + 1 + DRILL_OFFSET, bound)
      const next = [...prev]
      next.splice(at, 0, { ...source, drill: { otherFront, otherId } })
      return next
    })
  }

  // Persist IPA toggle preference.
  useEffect(() => {
    localStorage.setItem('lexify_ipa', showIPA ? '1' : '0')
  }, [showIPA])

  // When IPA is on and the current card lacks IPA, fetch it in the background.
  useEffect(() => {
    if (!showIPA || !currentCardId) return
    const card = queue[index]?.card
    if (!card || ipaCache.has(card.id) || card.ipa) return
    fetch(apiUrl('/api/ipa'), {
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

  // Orange "Almost" on a self-graded due card: recalled it with a small slip (el crano for el craneo)
  // — not a clean success, but nowhere near an Again-grade lapse. Reuses the typed near-miss
  // accounting: a 0.3-weight near-miss event (dings measured retention slightly; the damped
  // calibration turns persistent sloppiness into shorter intervals) + an FSRS difficulty bump by the
  // Hard delta (small, per-card, mean-reverted). The SCHEDULE is untouched — the card re-shows
  // ~ALMOST_REQUEUE_OFFSET ahead this session, and the re-rating there sets the next interval from
  // the slightly-penalized state.
  async function handleAlmost() {
    const current = queue[index]
    if (!current || submitting) return
    const { card, state } = current
    if (!state.graduated) return
    // Almost can also be picked from the first-Undo re-rate view ("actually, that was a near-miss")
    // — the undo already reverted the original rating, so this applies cleanly to the restored
    // state. Clear the view like handleAnswer does, else the Undo FAB lingers on a stale reRate.
    setReRate(null)
    setSubmitting(true)
    try {
      hintRef.current = null
      const isRev = (state.reviewDirection ?? 'forward') === 'reverse'
      new SupabaseReviewEventRepository().create({
        userId, cardId: card.id, mode: 'recognition',
        promptSide: isRev ? 'front' : 'back', answerSide: isRev ? 'back' : 'front',
        promptShown: isRev ? card.front : card.back,
        expected:    isRev ? card.back : card.front,
        userAnswer: '', wasCorrect: true, rating: 'hard', responseMs: reviewTimer.current?.read() ?? null,
        reviewMode: 'due', wasTyped: false,
        wasAccelerated: state.acceleratedMode === 'import_known',
        reviewDirection: (state.reviewDirection ?? 'forward') as 'forward' | 'reverse',
        reps: state.reps, nearMiss: true, nearMissWeight: 0.3,
        graduationErrorCount: state.graduationErrorCount ?? 0,
        sourceLanguage: sourceLanguage, targetLanguage: targetLanguage,
      }).catch(err => console.error('Failed to record almost event:', err))
      const newState = { ...state, difficulty: nextDifficulty(state.difficulty ?? seedDifficulty(state.lapses), 'hard') }
      await new SupabaseCardStateRepository().upsert(newState)
      setQueue(prev => {
        const at = Math.min(index + 1 + ALMOST_REQUEUE_OFFSET, prev.length)
        const next = [...prev]; next.splice(at, 0, { ...current, state: newState }); return next
      })
      setIndex(i => i + 1)
    } catch (err) {
      setAnswerError(err instanceof Error ? err.message : 'Failed to record')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAnswer = useCallback(async (rating: Rating, wasCorrect: boolean, userAnswer = '', _issueType?: GradingIssueType, softWrongRecallRating?: Rating) => {
    const current = queue[index]
    if (!current) return
    if (submitting) return

    setSubmitting(true)
    setAnswerError(null)
    setReRate(null)   // a fresh rating supersedes any re-rate view
    reviewCountRef.current += 1

    try {
      const { card, state, pipeline, productionMode, reviewTrack, isReverse } = current

      setRedoStack([])
      const undoOverride = pendingOverrideAddRef.current?.cardId === card.id ? pendingOverrideAddRef.current : null
      pendingOverrideAddRef.current = null

      // Hint + "Hard" on a due card: the recall wasn't cold, so re-show it this session instead of
      // granting a new interval. Only a hint-free Hard advances the schedule. (Any number of hints.)
      if (state.graduated && rating === 'hard' && hintRef.current) {
        hintRef.current = null
        setQueue(prev => {
          const at = Math.min(index + 1 + HINT_HARD_REQUEUE_OFFSET, prev.length)
          const next = [...prev]; next.splice(at, 0, { ...current }); return next
        })
        setIndex(i => i + 1)
        return
      }

      // Production confusion: typing a *different real word* (another card's target) on a typed
      // production review is a discrimination failure — link the pair + penalize both recognition
      // tracks (fire-and-forget; the schedule for THIS card still runs normally below).
      if (gradingSettings && state.graduated && !wasCorrect && !isReverse && reviewTrack !== 'recall' && productionMode === 'typed' && userAnswer.trim()) {
        const drillSource = current
        void respondToProductionConfusion({
          userId, cardAId: card.id, sourceLanguageA: sourceLanguage, typed: userAnswer, expectedFront: card.front,
          gradingSettings, tz: tzRef.current, turnover: turnoverRef.current,
        }).then(d => { if (d) queueDrill(drillSource, d.cardBId, d.cardBFront) })
      }

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
      const gsWithLang = { ...(gradingSettings ?? DEFAULT_GRADING_SETTINGS), answerLanguage: reviewAnswerSide === 'front' ? targetLanguage : sourceLanguage }
      if (!wasCorrect && userAnswer.trim()) {
        const confusedWithCardId = reviewAnswerSide === 'front'
          ? allCards.find(c => c.front.trim().toLowerCase() === userAnswer.trim().toLowerCase())?.id ?? null
          : allCards.find(c => c.back.trim().toLowerCase()  === userAnswer.trim().toLowerCase())?.id ?? null
        const isWordMixup = step.stepType !== 'typing'
          || isDifferentWordMistake(userAnswer, reviewAnswerSide === 'front' ? card.front : card.back, gsWithLang)
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

      // Hint (Due Now only): dampens interval growth on a correct answer;
      // ignored on `again`. Consumed here and cleared for the next card.
      const hint = state.graduated ? hintRef.current : null
      hintRef.current = null
      const nearMiss = nearMissRef.current
      nearMissRef.current = false

      // Per-category typed penalty: an accepted accent/article/spelling slip counts as
      // correct but dampens the interval by its weight (0.2/0.3); a lenient slip has
      // weight 0 (no penalty). Every slip is logged for future practice modes.
      const typedPenalty = typedPenaltyRef.current
      typedPenaltyRef.current = null
      const nmWeight = (typedPenalty && typedPenalty.weight > 0 && typedPenalty.weight < 1) ? typedPenalty.weight : 0
      if (typedPenalty?.category) {
        new SupabaseTypingErrorMarkRepository()
          .record(card.id, reviewAnswerSide, typedPenalty.category, reviewAnswerSide === 'front' ? card.front : card.back, userAnswer)
          .catch(err => console.error('Failed to record typing error mark:', err))
      }

      const reviewEvent = await eventRepo.create({
        userId: userId, cardId: card.id, mode: step.stepType,
        promptSide: reviewPromptSide, answerSide: reviewAnswerSide,
        promptShown: reviewPromptSide === 'front' ? card.front : card.back,
        expected:    reviewAnswerSide === 'front' ? card.front : card.back,
        userAnswer, wasCorrect, rating, responseMs: reviewTimer.current?.read() ?? null,
        reviewMode, wasTyped,
        wasAccelerated:     state.acceleratedMode === 'import_known',
        acceleratedPenalty: state.acceleratedPenalty,
        reviewDirection:    (state.reviewDirection ?? 'forward') as 'forward' | 'reverse',
        reps:               state.reps,
        hintLevel:          hint?.level ?? 0,
        nearMiss:           nmWeight > 0 || (!wasCorrect && nearMiss),
        nearMissWeight:     nmWeight,
        errorCategory:      typedPenalty?.category ?? null,
        graduationErrorCount: state.graduationErrorCount ?? 0,
        sourceLanguage, targetLanguage,
      })

      const wrongSeverity = !wasCorrect && (step.stepType === 'typing' || wasTyped)
        ? classifyWrongAnswer(userAnswer, reviewAnswerSide === 'front' ? card.front : card.back, gsWithLang)
        : undefined

      // Lazy reverse-row creation for existing graduated cards that predate Phase 2.
      // Actual upsert is deferred below after newState is computed, so we can base
      // the reverse due date on the forward card's NEXT review date (Option A).
      let reverseExistsForLazyInit: boolean | null = null
      if (state.graduated && state.reviewDirection !== 'reverse' && !isRecallReview) {
        reverseExistsForLazyInit = !!(await stateRepo.get(userId, card.id, 'reverse'))
      }

      // Recall/reverse review: update only the recall track then return early.
      // Graduated recall reviews are self-graded, so the FSRS grade is the rating.
      if (isRecallReview) {
        const grade: Rating = rating
        const elapsedDays = state.lastReviewedAt
          ? Math.max(0, (nowDate.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
          : (state.recallIntervalDays ?? state.intervalDays ?? 1)
        const fsrs = scheduleGraduatedFsrs({
          difficulty:  state.difficulty,
          stability:   state.stability,
          intervalDays: state.recallIntervalDays ?? state.intervalDays,
          lapses:      state.lapses,
          relearning:  state.relearning,
          goodStreak:  state.goodStreak,
          againStreak: state.againStreak,
          elapsedDays,
        }, grade, { ...DEFAULT_FSRS_CONFIG, requestRetention: retRef.current[isReverse ? 'reverse_recall' : 'forward_recall'] ?? schedulerParams.requestRetention, retentionCalibration: calRef.current[isReverse ? 'reverse_recall' : 'forward_recall'] ?? 1 }, { softLapse: nearMiss, hintGrowthFactor: hint?.growthFactor })
        // The recall/reverse track only ever recognises the native side, so failing it
        // never sends a card back to the ladder — only failing target-language production
        // (the forward path) does. A recall sendToLadder is treated as one more 5-min loop.
        const relearnMinutes = fsrs.dueInMinutes ?? (fsrs.sendToLadder ? RELEARN_MINUTES.again : null)
        let newRecallDueAt: string | null
        if (relearnMinutes != null) {
          newRecallDueAt = new Date(nowDate.getTime() + relearnMinutes * 60_000).toISOString()
        } else if (fsrs.intervalDays != null) {
          const days = fsrs.intervalDays
          const [minDays, maxDays] = fsrsFuzzRange(days)
          const idealDueAt = new Date(nowDate.getTime() + days * 86_400_000).toISOString()
          const smoothed = (maxDays - minDays >= 1)
            ? await smoothDueDate(userId, idealDueAt, minDays, maxDays, days, stateRepo)
            : idealDueAt
          newRecallDueAt = snapDueAtToStartOfDay(smoothed, tzRef.current, turnoverRef.current)
        } else {
          newRecallDueAt = state.recallDueAt
        }
        const recallNewState: CardState = {
          ...state,
          difficulty:         fsrs.difficulty,
          stability:          fsrs.stability,
          relearning:         fsrs.relearning,
          goodStreak:         fsrs.goodStreak,
          againStreak:        fsrs.againStreak,
          lastRating:         rating,
          lastReviewedAt:     nowDate.toISOString(),
          reps:               rating !== 'hard' ? state.reps + 1 : state.reps,
          lapses:             grade === 'again' ? state.lapses + 1 : state.lapses,
          relearningStep:     relearnMinutes != null ? 1 : 0,
          recallIntervalDays: fsrs.intervalDays ?? state.recallIntervalDays,
          recallDueAt:        newRecallDueAt,
          // Keep dueAt in sync for reverse-direction rows so the dashboard
          // doesn't see the original (past) dueAt and treat the card as still due.
          ...(isReverse ? { dueAt: newRecallDueAt } : {}),
        }
        await stateRepo.upsert(recallNewState)
        setCardStates(prev => {
          if (isReverse) return prev
          const n = new Map(prev); n.set(card.id, recallNewState); return n
        })
        setUndoStack(prev => [...prev.slice(-9), { queueIndex: index, prevState: { ...state }, newState: recallNewState, eventId: reviewEvent.id, overrideAdd: undoOverride, userAnswer, wasCorrect, selfGraded: productionMode === 'self-graded' }])
        setRedoStack([])
        setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: recallNewState } : item))
        // Re-queue "again" in the relearn pool (same 10-min loop as forward reviews).
        // Must advance index unconditionally — relearnPool state hasn't updated yet
        // in this closure, so checking relearnPool.length here would read the old value.
        // The relearnPool useEffect handles re-injection once the main queue is exhausted.
        if (recallNewState.relearningStep > 0) {
          setRelearnPool(prev => [...prev, { ...current, state: recallNewState, relearnLapsedAt: reviewCountRef.current }])
          setIndex(i => i + 1)
          return
        }
        if (index + 1 < queue.length || relearnPool.length > 0) { setIndex(i => i + 1) } else { setDone(true) }
        return
      }

      // Smart-typing review: an independent forward-production track, presented typed
      // (interval below the pair's threshold) or self-graded (past it). Own schedule
      // (smart_due_at/smart_interval_days), shares the row's FSRS D/S, mirrors dueAt.
      // Because it IS target-language production, three Agains in a row un-graduate to
      // the current ladder — same as the typed path.
      if (reviewTrack === 'smart') {
        const grade: Rating = (wasTyped && !wasCorrect) ? 'again' : rating
        const elapsedDays = state.lastReviewedAt
          ? Math.max(0, (nowDate.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
          : (state.smartIntervalDays ?? state.intervalDays ?? 1)
        const fsrs = scheduleGraduatedFsrs({
          difficulty:  state.difficulty,
          stability:   state.stability,
          intervalDays: state.smartIntervalDays ?? state.intervalDays,
          lapses:      state.lapses,
          relearning:  state.relearning,
          goodStreak:  state.goodStreak,
          againStreak: state.againStreak,
          elapsedDays,
        }, grade, { ...DEFAULT_FSRS_CONFIG, requestRetention: retRef.current['forward_smart'] ?? schedulerParams.requestRetention, retentionCalibration: calRef.current['forward_smart'] ?? 1 }, { softLapse: nearMiss, hintGrowthFactor: hint?.growthFactor })

        let smartNewState: CardState
        if (fsrs.sendToLadder) {
          smartNewState = {
            ...initialCardState(userId, card.id, pipeline.id),
            introducedDate:  state.introducedDate,
            reviewDirection: state.reviewDirection,
          }
          new SupabaseLadderClimbRepository().remove(userId, card.id).catch(() => {})
        } else {
          let dueAt: string
          if (fsrs.dueInMinutes != null) {
            dueAt = new Date(nowDate.getTime() + fsrs.dueInMinutes * 60_000).toISOString()
          } else {
            const days = fsrs.intervalDays!
            const [minDays, maxDays] = fsrsFuzzRange(days)
            const idealDueAt = new Date(nowDate.getTime() + days * 86_400_000).toISOString()
            const smoothed = (maxDays - minDays >= 1)
              ? await smoothDueDate(userId, idealDueAt, minDays, maxDays, days, stateRepo)
              : idealDueAt
            dueAt = snapDueAtToStartOfDay(smoothed, tzRef.current, turnoverRef.current)
          }
          smartNewState = {
            ...state,
            difficulty:        fsrs.difficulty,
            stability:         fsrs.stability,
            relearning:        fsrs.relearning,
            goodStreak:        fsrs.goodStreak,
            againStreak:       fsrs.againStreak,
            lastRating:        rating,
            lastReviewedAt:    nowDate.toISOString(),
            reps:              rating !== 'hard' ? state.reps + 1 : state.reps,
            lapses:            grade === 'again' ? state.lapses + 1 : state.lapses,
            relearningStep:    fsrs.dueInMinutes != null ? 1 : 0,
            // Keep the general interval/due in sync with the smart lane so folderStats,
            // redistribute, and classifyReviewMode all see the active schedule.
            intervalDays:          fsrs.intervalDays ?? state.intervalDays,
            scheduledIntervalDays: fsrs.intervalDays ?? state.scheduledIntervalDays,
            smartIntervalDays:     fsrs.intervalDays ?? state.smartIntervalDays,
            smartDueAt:            dueAt,
            dueAt,
            // Accelerated (import-known) cards go self-graded once a typed review is correct.
            acceleratedTypedConfirmed: state.acceleratedTypedConfirmed || (state.acceleratedMode === 'import_known' && !!wasTyped && wasCorrect),
          }
          if (smartNewState.graduated && !smartNewState.dormant && smartNewState.dormancyThreshold != null && smartNewState.reps >= smartNewState.dormancyThreshold) {
            smartNewState = { ...smartNewState, dormant: true }
            // Dormancy is per-direction now, so pause recognition too — "go dormant after N reviews"
            // means the whole card, not just production. (Best-effort; see lib/dormancy.ts.)
            markReverseDormant(userId, card.id)
            if (wasCorrect) setDormantNotice(true)
          }
        }

        if (state.graduated && !smartNewState.graduated) {
          eventRepo.markLapsed(reviewEvent.id, userId).catch(() => {})
        }
        await stateRepo.upsert(smartNewState)

        // Lazy reverse-row creation for pre-Phase-2 cards that lack one.
        if (reverseExistsForLazyInit === false && smartNewState.graduated) {
          const fwdNextDue  = smartNewState.smartDueAt ?? smartNewState.dueAt ?? nowDate.toISOString()
          const fwdInterval = smartNewState.smartIntervalDays ?? smartNewState.intervalDays
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

        setCardStates(prev => { const n = new Map(prev); n.set(card.id, smartNewState); return n })
        // Re-derive presentation: a lapsed smart card reverts to typed until it re-passes the threshold.
        const smartMode = forwardProductionMode(smartNewState, 'smart', schedulerParams.smartTypingThresholdDays)
        setUndoStack(prev => [...prev.slice(-9), { queueIndex: index, prevState: { ...state }, newState: smartNewState, eventId: reviewEvent.id, overrideAdd: undoOverride, userAnswer, wasCorrect, selfGraded: productionMode === 'self-graded' }])
        setRedoStack([])
        setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: smartNewState, productionMode: smartMode } : item))
        if (smartNewState.relearningStep > 0) {
          setRelearnPool(prev => [...prev, { ...current, state: smartNewState, productionMode: smartMode, relearnLapsedAt: reviewCountRef.current }])
          setIndex(i => i + 1)
          return
        }
        if (index + 1 < queue.length || relearnPool.length > 0) { setIndex(i => i + 1) } else { setDone(true) }
        return
      }

      // A wrong typing answer during the pipeline is a "struggle" — it feeds the
      // cumulative error count that buckets the card's graduation interval.
      const pipelineErrorInc = (!state.graduated && step.stepType === 'typing' && !wasCorrect) ? 1 : 0

      let newState = progressAfterReview(state, pipeline, { wasCorrect, rating, wrongSeverity, wasTyped: wasTyped ?? false }, nowDate)

      if (state.graduated && !newState.graduated) {
        eventRepo.markLapsed(reviewEvent.id, userId).catch(() => {})
      }

      // While the card is (still) in the pipeline, accumulate the struggle count.
      if (!newState.graduated) {
        newState = { ...newState, pipelineErrorCount: (state.pipelineErrorCount ?? 0) + pipelineErrorInc }
      }

      // ── FSRS scheduling for already-graduated forward reviews (engine/dueNow) ──
      // Keeps progressAfterReview's production bookkeeping (typed accuracy window,
      // forced-typing, reps/lapses) but replaces the legacy scheduler's interval
      // with the FSRS memory model + relearn gate. A wrong typed answer is an Again.
      let fsrsSentToLadder = false
      if (state.graduated) {
        const grade: Rating = (wasTyped && !wasCorrect) ? 'again' : rating
        const elapsedDays = state.lastReviewedAt
          ? Math.max(0, (nowDate.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
          : (state.scheduledIntervalDays || state.intervalDays || 1)
        const fsrs = scheduleGraduatedFsrs({
          difficulty:  state.difficulty,
          stability:   state.stability,
          intervalDays: state.typedIntervalDays ?? state.intervalDays,
          lapses:      state.lapses,
          relearning:  state.relearning,
          goodStreak:  state.goodStreak,
          againStreak: state.againStreak,
          elapsedDays,
        }, grade, { ...DEFAULT_FSRS_CONFIG, requestRetention: retRef.current['forward_typed'] ?? schedulerParams.requestRetention, retentionCalibration: calRef.current['forward_typed'] ?? 1 }, { softLapse: nearMiss, hintGrowthFactor: hint?.growthFactor })
        if (fsrs.sendToLadder) {
          // Three Agains in a row producing the target language → un-graduate and
          // restart the CURRENT ladder (drop any stale climb row so it re-enters
          // whatever the ladder is configured as now, not the old pipeline position).
          newState = {
            ...initialCardState(userId, card.id, pipeline.id),
            introducedDate:  state.introducedDate,
            reviewDirection: state.reviewDirection,
          }
          new SupabaseLadderClimbRepository().remove(userId, card.id).catch(() => {})
          fsrsSentToLadder = true
        } else {
          let dueAt: string
          if (fsrs.dueInMinutes != null) {
            dueAt = new Date(nowDate.getTime() + fsrs.dueInMinutes * 60_000).toISOString()  // relearn loop — precise, no fuzz
          } else {
            const days = fsrs.intervalDays!
            const [minDays, maxDays] = fsrsFuzzRange(days)
            const idealDueAt = new Date(nowDate.getTime() + days * 86_400_000).toISOString()
            const smoothed = (maxDays - minDays >= 1)
              ? await smoothDueDate(userId, idealDueAt, minDays, maxDays, days, stateRepo)
              : idealDueAt
            dueAt = snapDueAtToStartOfDay(smoothed, tzRef.current, turnoverRef.current)
          }
          newState = {
            ...newState,
            difficulty:            fsrs.difficulty,
            stability:             fsrs.stability,
            relearning:            fsrs.relearning,
            goodStreak:            fsrs.goodStreak,
            againStreak:           fsrs.againStreak,
            relearningStep:        fsrs.dueInMinutes != null ? 1 : 0,  // reuse the existing relearn re-queue
            intervalDays:          fsrs.intervalDays ?? newState.intervalDays,
            scheduledIntervalDays: fsrs.intervalDays ?? newState.scheduledIntervalDays,
            typedIntervalDays:     fsrs.intervalDays ?? newState.typedIntervalDays,
            typedDueAt:            dueAt,
            dueAt,
            acceleratedTypedConfirmed: state.acceleratedTypedConfirmed || (state.acceleratedMode === 'import_known' && !!wasTyped && wasCorrect),
            // Log the real FSRS interval (skip sub-day relearn steps) so the ℹ menu
            // shows how long each interval actually was given difficulty/stability.
            intervalHistory: fsrs.dueInMinutes == null
              ? appendHistory(newState.intervalHistory, fsrs.intervalDays!)
              : newState.intervalHistory,
          }
        }
      }

      // Graduation: override the default interval with a range based on how many
      // typing steps the learner got wrong during this pipeline run.
      if (!state.graduated && newState.graduated && newState.dueAt) {
        // The graduating answer is correct, so the accumulated count is final.
        const errors    = state.pipelineErrorCount ?? 0
        const [minDays, maxDays] = graduationIntervalRange(errors, schedulerParams)
        const idealDays = Math.floor((minDays + maxDays) / 2)
        const idealDueAt = new Date(nowDate.getTime() + idealDays * 24 * 60 * 60 * 1000).toISOString()
        const smoothed = (maxDays - minDays >= 1)
          ? await smoothDueDate(userId, idealDueAt, minDays, maxDays, idealDays, stateRepo)
          : idealDueAt
        // Snapshot the error count into graduationErrorCount (buckets calibration),
        // then reset the running counter for any future pipeline relapse.
        newState = { ...newState, dueAt: smoothed, intervalDays: idealDays, scheduledIntervalDays: idealDays, typedDueAt: smoothed, typedIntervalDays: idealDays, graduationErrorCount: errors, pipelineErrorCount: 0, intervalHistory: appendHistory(newState.intervalHistory, idealDays) }
      }

      // Snap to start of logical day so all cards due on the same day appear
      // simultaneously rather than trickling in as fractional intervals expire.
      if (newState.graduated && newState.dueAt && newState.relearningStep === 0) {
        newState = { ...newState, dueAt: snapDueAtToStartOfDay(newState.dueAt, tzRef.current, turnoverRef.current) }
      }

      // Typed track: keep typedDueAt in sync with dueAt after scheduling.
      if (newState.graduated && reviewTrack === 'typed') {
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
        const elapsedDays = state.lastReviewedAt
          ? Math.max(0, (nowDate.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
          : recallIntervalBase
        const recallFsrs = scheduleGraduatedFsrs({
          difficulty:   state.difficulty,
          stability:    state.stability,
          intervalDays: recallIntervalBase,
          lapses:       state.lapses,
          relearning:   false,
          goodStreak:   state.goodStreak,
          againStreak:  state.againStreak,
          elapsedDays,
        }, softWrongRecallRating, { ...DEFAULT_FSRS_CONFIG, requestRetention: retRef.current[isReverse ? 'reverse_recall' : 'forward_recall'] ?? schedulerParams.requestRetention, retentionCalibration: calRef.current[isReverse ? 'reverse_recall' : 'forward_recall'] ?? 1 }, {})
        if (recallFsrs.intervalDays != null) {
          const newRecallDueAt = snapDueAtToStartOfDay(new Date(nowDate.getTime() + recallFsrs.intervalDays * 86_400_000).toISOString(), tzRef.current, turnoverRef.current)
          newState = { ...newState, recallIntervalDays: recallFsrs.intervalDays, recallDueAt: newRecallDueAt }
        } else {
          // Recall rating lapsed → re-show soon (relearn), keeping the recall interval as-is.
          const minutes = recallFsrs.dueInMinutes ?? RELEARN_MINUTES.again
          newState = { ...newState, recallDueAt: new Date(nowDate.getTime() + minutes * 60_000).toISOString() }
        }
      }

      // Legacy track: check Phase 1 completion when review was typed.
      if (newState.graduated && reviewTrack === 'legacy' && wasTyped && wasCorrect && !newState.recallDueAt) {
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

      // Dormancy: after N production reviews the card auto-goes dormant (production
      // reviews only — this path is reached only for forward production reviews).
      if (newState.graduated && !newState.dormant && newState.dormancyThreshold != null && newState.reps >= newState.dormancyThreshold) {
        newState = { ...newState, dormant: true }
        // Dormancy is per-direction now, so pause recognition too — "go dormant after N reviews"
        // means the whole card, not just production. (Best-effort; see lib/dormancy.ts.)
        markReverseDormant(userId, card.id)
        if (wasCorrect) setDormantNotice(true)
      }

      await stateRepo.upsert(newState)

      // Lazy reverse-row creation (deferred from above — uses newState's forward due date).
      if (reverseExistsForLazyInit === false && !fsrsSentToLadder) {
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
      setUndoStack(prev => [...prev.slice(-9), { queueIndex: index, prevState: { ...state }, newState, eventId: reviewEvent.id, overrideAdd: undoOverride, userAnswer, wasCorrect, selfGraded: productionMode === 'self-graded' }])
      setRedoStack([])

      // 10-minute "Again" relearn loop: hold the card in the relearn pool until
      // its dueAt passes. The pool-injection useEffect above reintroduces it
      // once the main queue runs out, ordered by elapsed percentage.
      if (newState.graduated && newState.relearningStep > 0) {
        const requeued: SessionCard = { card, state: newState, pipeline, productionMode: decideProductionMode(newState, nowDate), relearnLapsedAt: reviewCountRef.current }
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
    // Two-stage undo: first press reverts the rating and re-shows the card answered (reRate) so a
    // different rating can be picked; a second press (while that view is up) clears it -> real card remounts blank.
    if (reRate) { setReRate(null); return }
    const entry = undoStack[undoStack.length - 1]
    if (!entry || submitting) return
    setUndoStack(prev => prev.slice(0, -1))
    setRedoStack(prev => [...prev, entry])
    try {
      const stateRepo = new SupabaseCardStateRepository()
      await stateRepo.upsert(entry.prevState)
      if (entry.eventId) new SupabaseReviewEventRepository().delete(entry.eventId).catch(() => {})
      if (entry.overrideAdd) handleOverrideAnswer(entry.overrideAdd.cardId, entry.overrideAdd.answerSide, entry.overrideAdd.answerText, false)
      setCardStates(prev => { const n = new Map(prev); n.set(entry.prevState.cardId, entry.prevState); return n })
      // Erase the rating's relearn re-show too. An Again (or relearn-loop Hard) puts a COPY of the
      // card in the relearn pool, and once its 5-minute clock passes the resurface effect moves that
      // copy INTO the queue — so filtering the pool alone leaves a stale copy carrying the undone
      // rating's relearning state; it would re-show later and upsert the very state this undo just
      // erased. Relearn copies are identified by the relearnLapsedAt marker (set at every pool-add
      // site, nowhere else) plus the rated item's card+track identity. Only items PAST the restored
      // index are dropped, so entry.queueIndex still points at the rated item for the map below.
      setQueue(prev => {
        const rated = prev[entry.queueIndex]
        return prev
          .filter((item, i) => !(rated && i > entry.queueIndex && item.relearnLapsedAt !== undefined &&
            item.card.id === rated.card.id && item.reviewTrack === rated.reviewTrack && item.isReverse === rated.isReverse))
          .map((item, i) => i === entry.queueIndex ? { ...item, state: entry.prevState } : item)
      })
      setRelearnPool(prev => prev.filter(item => item.card.id !== entry.prevState.cardId))
      setDone(false)
      setIndex(entry.queueIndex)
      setReRate({ queueIndex: entry.queueIndex, userAnswer: entry.userAnswer, wasCorrect: entry.wasCorrect, selfGraded: entry.selfGraded })
    } catch (err) { console.error('Undo failed:', err) }
  }, [reRate, undoStack, submitting, handleOverrideAnswer])

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
          wasCorrect, rating, responseMs: reviewTimer.current?.read() ?? null, reviewMode, wasTyped: true,
        })

        const newState = progressAfterReview(
          memberState, currentPipeline,
          { wasCorrect, rating, wrongSeverity: undefined, wasTyped: true },
          nowDate,
        )
        await stateRepo.upsert(newState)
        newStates.set(lexicalItemId, newState)
      }

      setCardStates(prev => {
        const next = new Map(prev)
        for (const [id, state] of newStates) next.set(id, state)
        return next
      })

      // ── Grey-out (answered) marks + same-session re-queue ────────────────
      // Members that advanced to a new step completed their step obligation.
      const advancingIds = new Set<string>()
      for (const { lexicalItemId } of results) {
        const prev = cardStates.get(lexicalItemId)
        const next = newStates.get(lexicalItemId)
        if (prev && next && !next.graduated && next.currentStepOrder !== prev.currentStepOrder) {
          advancingIds.add(lexicalItemId)
        }
      }

      const gid            = queue[index]?.card.synonymGroupId ?? null
      const groupMemberIds = gid ? (synonymGroups.get(gid)?.itemIds ?? []) : []
      const correctNow     = new Set(results.filter(r => r.wasCorrect).map(r => r.lexicalItemId))
      const roundFailed    = results.some(r => !r.wasCorrect)
      // Pipeline grey-out is session-scoped only (day-store is for Due Now).
      const priorAnswered  = (id: string) => sessionAnsweredSynonyms.has(id)

      // Did every member of the group get answered correctly across this cycle?
      const groupFullyAnswered = groupMemberIds.length > 0 && groupMemberIds.every(id =>
        correctNow.has(id) || priorAnswered(id) || newStates.get(id)?.graduated,
      )

      const clearGroupMarks = () => {
        for (const id of groupMemberIds) unmarkSynonymAnswered(userId, id, studyDayKey)
        setSessionAnsweredSynonyms(prev => {
          const next = new Set(prev)
          for (const id of groupMemberIds) next.delete(id)
          return next
        })
      }

      if (roundFailed && !groupFullyAnswered) {
        // Partial round — grey (session-scoped) the forms just answered
        // correctly so the retry only asks the missed ones. The group is
        // re-queued below to retry now, this session.
        setSessionAnsweredSynonyms(prev => {
          const next = new Set(prev)
          for (const id of correctNow) if (!advancingIds.has(id)) next.add(id)
          return next
        })
      } else {
        // A full "all forms correct" milestone (or a step advance): reset the
        // grey-out so the next required-correct round re-prompts every form.
        clearGroupMarks()
      }

      // Re-queue the group so the remaining reps/steps happen in THIS session,
      // rather than the group going dormant until a later session. Use the
      // representative's latest state (unchanged this round if it was already
      // greyed). Stops once the representative graduates.
      const repId       = queue[index]?.card.id
      const repNewState = repId ? (newStates.get(repId) ?? cardStates.get(repId)) : undefined
      if (repNewState && !repNewState.graduated) {
        const currentItem = queue[index]!
        setQueue(prev => {
          const next = [...prev]
          next.splice(index + 1, 0, { ...currentItem, state: repNewState })
          return next
        })
      }
      setIndex(i => i + 1)
    } catch (err: unknown) {
      console.error('Failed to record synonym answer:', err)
      setAnswerError(err instanceof Error ? err.message : 'Something went wrong saving your answer. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [queue, index, userId, allCards, cardStates, submitting, studyDayKey, synonymGroups, sessionAnsweredSynonyms])

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
    reviewCountRef.current += 1

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

      // "?" counts as one pipeline struggle (added to the persisted state below).
      const idkErrorInc = state.graduated ? 0 : 1

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
          graduationErrorCount: state.graduationErrorCount ?? 0,
        })
        const wasGraduated = newState.graduated
        newState = progressAfterReview(newState, pipeline, { wasCorrect: false, rating: 'again', wrongSeverity: undefined, wasTyped: false }, nowDate)
        if (wasGraduated && !newState.graduated) {
          eventRepo.markLapsed(idkEvent.id, userId).catch(() => {})
        }
      }

      const counted = {
        ...newState,
        iDontKnowCount: (prevState.iDontKnowCount ?? 0) + 1,
        pipelineErrorCount: newState.graduated ? newState.pipelineErrorCount : (prevState.pipelineErrorCount ?? 0) + idkErrorInc,
      }
      await stateRepo.upsert(counted)
      setCardStates(prev => { const m = new Map(prev); m.set(card.id, counted); return m })

      // True when the penalty sent the card backwards in the pipeline (e.g. typing-streak reset to step 0).
      const wasReset = counted.currentStepOrder < prevState.currentStepOrder

      const requeued: SessionCard = { card, state: counted, pipeline, productionMode, idontknow: true, relearnLapsedAt: reviewCountRef.current }
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

  // A-vs-B discrimination drill (pure practice — advancing schedules nothing).
  if (current.drill) {
    return (
      <div className="space-y-8">
        <div className="relative flex items-center justify-between">
          <Link href={deckUrl} className="text-sm text-ink-muted hover:text-ink">✕ End session</Link>
          <div className="absolute left-1/2 -translate-x-1/2 text-xs text-ink-muted">{index + 1} / {queue.length}</div>
          <div className="text-xs text-warning">Confusion drill</div>
        </div>
        <UndoFab show={undoStack.length > 0 || reRate !== null} onUndo={() => void handleUndo()} />
        <ConfusionDrill card={current.card} otherFront={current.drill.otherFront} deckName={deckName}
          onDone={() => setIndex(i => i + 1)}
          onPromptEdit={t => handlePromptEdit(current.card.id, 'back', t)}
          onInfo={() => setInfoOpen(true)} />
        {infoOpen && (
          <CardEditModal
            card={current.card} state={cardStates.get(current.card.id)} userId={userId} deckId={deckId}
            deckCards={allCards} sourceLanguage={sourceLanguage} targetLanguage={targetLanguage}
            onSave={handleInfoSave} onCardChange={applyInfoCardChange} onStateChange={applyInfoStateChange}
            onDelete={handleInfoDelete} onClose={() => setInfoOpen(false)} initialShowStats
          />
        )}
      </div>
    )
  }

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
  // The IPA toggle is only offered when the prompt IS the target-language word (card.front) — that's
  // the text /api/ipa transcribes. On a native-language prompt the button had nothing to show, so it
  // silently toggled a preference and appeared broken.
  const ipaToggle = promptShowsSource ? () => setShowIPA(v => !v) : undefined
  const softWrongEnabled = state.graduated && !currentIsReverse &&
    current.reviewTrack !== 'recall' && forwardTypedEnabled && forwardRecallEnabled
  // Hint is offered only on genuinely-due graduated reviews (not the pipeline,
  // and not early/elective reviews).
  const hintable = isGraduatedDueByDate(state, tzRef.current, getToday(tzRef.current, turnoverRef.current))

  return (
    <div className="space-y-8">
      {dormantNotice && (
        <div className="fixed left-1/2 -translate-x-1/2 top-6 z-50 px-4 py-2 rounded-card bg-surface-raised border border-line/70 text-sm text-ink shadow-lg">
          💤 Card is now dormant
        </div>
      )}
      <div className="relative flex items-center justify-between">
        <Link href={deckUrl} className="text-sm text-ink-muted hover:text-ink">✕ End session</Link>
        <div className="absolute left-1/2 -translate-x-1/2 text-xs text-ink-muted">{index + 1} / {queue.length}</div>
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

      {reRate && reRate.queueIndex === index ? (
        // First-Undo re-rate view: the card shown answered (FlashcardMode revealed) so a different
        // rating can be picked. Re-rating runs handleAnswer from the reverted state with the stored answer.
        <FlashcardMode key={`rerate-${card.id}-${index}`} card={card} promptSide={reviewPromptSide} deckName={deckName}
          resumeAnswered autoPlayAudio={false}
          onRate={rating => handleAnswer(rating, reRate.selfGraded ? rating !== 'again' : reRate.wasCorrect, reRate.userAnswer)}
          onAlmost={reRate.selfGraded && state.graduated ? handleAlmost : undefined}
          onPromptEdit={t => handlePromptEdit(card.id, reviewPromptSide, t)}
          onAnswerEdit={t => handlePromptEdit(card.id, reviewAnswerSide, t)}
          onInfo={() => setInfoOpen(true)}
          answerLanguage={reviewAnswerSide === 'front' ? sourceLanguage : targetLanguage}
          ipaText={currentIpaText} onToggleIPA={ipaToggle} />
      ) : !state.graduated && step.stepType === 'recognition' ? (
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
          onInfo={() => setInfoOpen(true)}
          ipaText={currentIpaText} onToggleIPA={ipaToggle} />
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
              // Pipeline grey-out is session-scoped (see auto-advance effect).
              const isPrefilled = sessionAnsweredSynonyms.has(m.id)
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
          onAddSynonym={step.answerSide === 'front' ? (normalizedText) => handleAddSynonym(card.id, step.answerSide, normalizedText) : undefined}
          onRepeat={handleRepeat}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)}
          onPromptEdit={t => handlePromptEdit(card.id, step.promptSide, t)}
          onAnswerEdit={t => handlePromptEdit(card.id, step.answerSide, t)}
          onInfo={() => setInfoOpen(true)}
          ipaText={currentIpaText} onToggleIPA={ipaToggle} />
      ) : current.productionMode === 'self-graded' ? (
        // ── Post-graduation self-graded flashcard ────────────────────────────
        <FlashcardMode key={`${card.id}-${index}`} card={card} promptSide={reviewPromptSide}
          onRate={rating => handleAnswer(rating, rating !== 'again')}
          onAlmost={state.graduated ? handleAlmost : undefined}
          onPromptEdit={t => handlePromptEdit(card.id, reviewPromptSide, t)}
          onAnswerEdit={t => handlePromptEdit(card.id, reviewAnswerSide, t)}
          onInfo={() => setInfoOpen(true)}
          hintable={hintable} onHint={handleHint}
          answerLanguage={reviewAnswerSide === 'front' ? sourceLanguage : targetLanguage}
          ipaText={currentIpaText} onToggleIPA={ipaToggle} />
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
          onInfo={() => setInfoOpen(true)}
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
          onAddSynonym={reviewAnswerSide === 'front' ? (normalizedText) => handleAddSynonym(card.id, reviewAnswerSide, normalizedText) : undefined}
          onRate={(rating, wasCorrect, userAnswer, issueType, softWrongRecallRating) => handleAnswer(rating, wasCorrect, userAnswer, issueType, softWrongRecallRating)}
          onIDontKnow={handleIDontKnow}
          onAdvance={() => setIndex(i => i + 1)}
          onPromptEdit={t => handlePromptEdit(card.id, reviewPromptSide, t)}
          onAnswerEdit={t => handlePromptEdit(card.id, reviewAnswerSide, t)}
          onResetCard={handleResetCard}
          onInfo={() => setInfoOpen(true)}
          hintable={hintable} onHint={handleHint} onNearMiss={handleNearMiss}
          onTypedPenalty={handleTypedPenalty}
          strictness={{ spelling: schedulerParams.strictSpelling, accents: schedulerParams.strictAccents, articles: schedulerParams.strictArticles }}
          softWrongEnabled={softWrongEnabled}
          ipaText={currentIpaText} onToggleIPA={ipaToggle} />
      )}

      <UndoFab show={undoStack.length > 0 || reRate !== null} onUndo={() => void handleUndo()} />

      {infoOpen && (
        <CardEditModal
          card={card}
          state={cardStates.get(card.id)}
          userId={userId}
          deckId={deckId}
          deckCards={allCards}
          sourceLanguage={sourceLanguage}
          targetLanguage={targetLanguage}
          onSave={handleInfoSave}
          onCardChange={applyInfoCardChange}
          onStateChange={applyInfoStateChange}
          onDelete={handleInfoDelete}
          onClose={() => setInfoOpen(false)}
          initialShowStats
        />
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
