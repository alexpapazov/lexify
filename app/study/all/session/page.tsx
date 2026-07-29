'use client'

/**
 * Cross-deck study session — pulls due cards from ALL decks.
 * Same engine as the per-deck session, just a different queue-builder.
 */

import { Suspense, useEffect, useState, useCallback, useRef } from 'react'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { useActiveTimer } from '@/lib/activeTimer'
import { loadProfileRow } from '@/lib/offline/profilePrefs'
import { apiUrl } from '@/lib/apiBase'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { langName } from '@/lib/languages'
import { SupabaseDeckRepository }        from '@/lib/data/decks'
import { SupabaseCardRepository }        from '@/lib/data/cards'
import { SupabaseCardStateRepository }   from '@/lib/data/cardStates'
import { SupabaseReviewEventRepository } from '@/lib/data/reviewEvents'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { SupabasePipelineRepository }    from '@/lib/data/pipelines'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { SupabaseCardConfusionRepository }   from '@/lib/data/cardConfusions'
import { SupabaseTypingErrorMarkRepository } from '@/lib/data/typingErrorMarks'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import type { CardSide } from '@/domain'
import { progressAfterReview, initialCardState, appendHistory } from '@/engine/pipeline'
import { classifyWrongAnswer, isDifferentWordMistake } from '@/engine/grading'
import { smoothDueDate } from '@/engine/density'
import { classifyReviewMode, isGraduatedDueByDate, graduationIntervalRange } from '@/engine/scheduler'
import { scheduleGraduatedFsrs, RELEARN_MINUTES, seedDifficulty } from '@/engine/dueNow'
import { setAudioSourceDefault, setAudioSourceByLanguage } from '@/lib/speak'
import { hydrateSessionAudio, needsAudioHydration, applyAudioPatch, type AudioPatch } from '@/lib/sessionAudio'
import { markReverseDormant } from '@/lib/dormancy'
import { DEFAULT_FSRS_CONFIG, fsrsFuzzRange, nextDifficulty } from '@/engine/fsrs'
import { decideProductionMode, type ProductionMode } from '@/engine/productionMode'
import type { Card, CardState, Deck, Pipeline, Rating, GradingSettings, CardConfusion, SchedulerParams, GradingIssueType, TypedErrorCategory, TypedStrictness } from '@/domain'
import { DEFAULT_TYPED_STRICTNESS } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS, DEFAULT_GRADING_SETTINGS, DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import { SupabaseUserSchedulerParamsRepository, type SchedulerParamsRow } from '@/lib/data/userSchedulerParams'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { TypingMode } from '@/components/session/TypingMode'
import { MultipleChoiceMode } from '@/components/session/MultipleChoiceMode'
import { prefetchChoices, prefetchAudio, promoteConfusionDistractors, deckSiblings, needsChoices, ensureChoicesGenerated, type PrefetchItem, type ConfusionPromotionItem } from '@/lib/distractors'
import { getToday, snapDueAtToStartOfDay } from '@/lib/dates'
import { forwardStateMap } from '@/lib/cardStateMap'
import { computeActiveLearningSet, dedupeDueReviews, buildEnabledTracksMap, trackEnabled, activeProductionTrack, forwardProductionMode, buildCalibrationMap, calibrationFor, buildRetentionMap, retentionFor, type EnabledTracks } from '@/lib/sessionLimits'
import { respondToProductionConfusion } from '@/lib/confusionResponse'
import { ConfusionDrill } from '@/components/session/ConfusionDrill'
import { UndoFab } from '@/components/session/UndoFab'
import { SupabaseCardConfusionLinkRepository } from '@/lib/data/cardConfusionLinks'
import { interleaveConfusablePairs } from '@/engine/confusion'
import { CardEditModal } from '@/components/CardEditModal'

const REPEAT_REQUEUE_OFFSET    = 8
const IDONTKNOW_REQUEUE_OFFSET = 4
const HINT_HARD_REQUEUE_OFFSET = 6   // hint-assisted "Hard" re-shows this session instead of advancing
const ALMOST_REQUEUE_OFFSET = 4      // self-graded "Almost" re-shows this session; the re-rating schedules
const DRILL_OFFSET             = 3   // A-vs-B confusion drill lands this many cards ahead (before A/B recur)

interface SessionCard {
  card:            Card
  state:           CardState
  pipeline:        Pipeline
  gradingSettings: GradingSettings
  deckId:          string
  deckName:        string
  deckCards:       Card[]
  sourceLanguage:  string
  targetLanguage:  string
  /** For graduated cards: whether this review should use typed or self-graded production. Null pre-graduation. */
  productionMode:  ProductionMode | null
  /** Which interval track triggered this queue entry ('typed' | 'recall' | 'legacy'). Undefined for pipeline cards. */
  reviewTrack?: 'typed' | 'recall' | 'legacy' | 'smart'
  /** True when this entry is for the reverse-direction (Spanish→English) recall row. */
  isReverse?: boolean
  idontknow?: true
  /** Answer counter when this card lapsed into the relearn pool (drives the batch-size resurface window). */
  relearnLapsedAt?: number
  /** When set, this queue item is an A-vs-B discrimination drill (card is A; otherFront is B's word). */
  drill?: { otherFront: string; otherId: string }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

const ALL_ELECTIVE_LIMIT = 20
type StudyCategory = 'new' | 'learning' | 'graduated' | 'due' | 'dormant'

export default function AllDueSessionPage() {
  return (
    <Suspense fallback={<div className="text-ink-muted pt-16 text-center">Loading session…</div>}>
      <AllDueSessionInner />
    </Suspense>
  )
}

function AllDueSessionInner() {
  const router   = useRouter()
  const supabase = createClient()
  const searchParams = useSearchParams()
  const categoryParam = searchParams.get('category')
  const category: StudyCategory | null =
    categoryParam === 'new' || categoryParam === 'learning' || categoryParam === 'graduated' || categoryParam === 'due' || categoryParam === 'dormant'
      ? categoryParam : null
  const sourceLang = searchParams.get('source')
  const targetLang = searchParams.get('target')
  const dirParam   = searchParams.get('dir') as 'forward' | 'reverse' | null
  // Optional card-type filter for "Study all due" → Typing / Self-graded buckets.
  const presentParam = searchParams.get('present') as 'typing' | 'selfgraded' | null
  const filterByPresent = <T extends { productionMode: 'typed' | 'self-graded' | null }>(items: T[]): T[] =>
    presentParam === 'typing'     ? items.filter(i => i.productionMode === 'typed')
    : presentParam === 'selfgraded' ? items.filter(i => i.productionMode === 'self-graded')
    : items
  const backHref = sourceLang && targetLang ? `/library?source=${sourceLang}&target=${targetLang}` : '/study'

  const [queue,           setQueue]           = useState<SessionCard[]>([])
  const [index,           setIndex]           = useState(0)
  const reviewTimer = useActiveTimer(30_000)
  useEffect(() => { reviewTimer.current?.restart() }, [index])
  const [loading,         setLoading]         = useState(true)
  const [userId,          setUserId]          = useState('')
  const [done,            setDone]            = useState(false)
  const [electiveSession, setElectiveSession] = useState(false)
  const [studyModeAutoplay, setStudyModeAutoplay] = useState(true)
  const [answerError,     setAnswerError]     = useState<string | null>(null)
  const [submitting,      setSubmitting]      = useState(false)
  const [infoOpen,        setInfoOpen]        = useState(false)
  const [dormantNotice,   setDormantNotice]   = useState(false)
  useEffect(() => {
    if (!dormantNotice) return
    const t = setTimeout(() => setDormantNotice(false), 2800)
    return () => clearTimeout(t)
  }, [dormantNotice])
  const [schedulerParams, setSchedulerParams] = useState<SchedulerParams>(DEFAULT_SCHEDULER_PARAMS)
  const [forwardTypedEnabled, setForwardTypedEnabled] = useState(true)
  const [forwardRecallEnabled, setForwardRecallEnabled] = useState(true)
  /** Persisted typed-answer overrides, keyed by `${cardId}:${answerSide}` -> set of accepted normalized answers. */
  const [overrides,       setOverrides]       = useState<Map<string, Set<string>>>(new Map())
  /** Graduated cards in the relearn loop — held out of the main queue until their real-clock dueAt
   *  passes (resurfaced this session) or their batch-size window lapses (rolled to a later session). */
  const [relearnPool,     setRelearnPool]     = useState<SessionCard[]>([])
  const reviewCountRef = useRef(0)                    // monotonic count of answers given this session
  const batchSizeRef   = useRef(ALL_ELECTIVE_LIMIT)   // resurface window = the session's batch size
  const indexRef       = useRef(0)                    // current queue index (for async drill insertion)
  const [showIPA,  setShowIPA]  = useState(() => typeof window !== 'undefined' && localStorage.getItem('lexify_ipa') === '1')
  const [ipaCache, setIpaCache] = useState<Map<string, string>>(new Map())
  type UndoEntry = { queueIndex: number; prevState: CardState; newState: CardState; eventId: string | null; overrideAdd: { cardId: string; answerSide: CardSide; answerText: string } | null; userAnswer: string; wasCorrect: boolean; selfGraded: boolean }
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  // First Undo press lands here: re-show the just-rated card answered (FlashcardMode revealed) so the
  // learner can re-pick a rating. A second Undo press clears this → the real card remounts blank.
  const [reRate, setReRate] = useState<{ queueIndex: number; userAnswer: string; wasCorrect: boolean; selfGraded: boolean } | null>(null)
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([])
  // An override the current card newly added this attempt (so undo removes exactly it).
  const pendingOverrideAddRef = useRef<{ cardId: string; answerSide: CardSide; answerText: string } | null>(null)

  const tzRef       = useRef('UTC')
  const turnoverRef = useRef(0)
  // Persisted load context, reused by the on-complete "more due?" re-check.
  const decksRef      = useRef<Deck[] | null>(null)
  const enabledMapRef = useRef<Map<string, EnabledTracks> | null>(null)
  const paramMapRef   = useRef<Map<string, SchedulerParamsRow> | null>(null)
  // Per-(pair,track) FSRS interval calibration (measured-vs-target retention), keyed `${src}|${tgt}:${field}`.
  const calMapRef     = useRef<Map<string, number>>(new Map())
  // Per-(pair,track) FSRS target retention, keyed `${src}|${tgt}:${field}`.
  const retMapRef     = useRef<Map<string, number>>(new Map())
  const [moreDue, setMoreDue] = useState(-1)   // -1 = not yet checked (avoids a wrong-state button flash)
  // Hint usage for the current card's review — consumed once in handleAnswer.
  const hintRef     = useRef<{ level: number; growthFactor: number } | null>(null)
  const handleHint  = useCallback((level: number, growthFactor: number) => {
    hintRef.current = { level, growthFactor }
  }, [])
  const nearMissRef = useRef(false)
  const handleNearMiss = useCallback((nearMiss: boolean) => { nearMissRef.current = nearMiss }, [])
  const typedPenaltyRef = useRef<{ weight: number; category: TypedErrorCategory | null } | null>(null)
  const handleTypedPenalty = useCallback((weight: number, category: TypedErrorCategory | null) => {
    typedPenaltyRef.current = { weight, category }
  }, [])
  // Per-pair typed-answer strictness (forward_typed row), keyed `${src}|${tgt}`.
  const [strictnessMap, setStrictnessMap] = useState<Map<string, TypedStrictness>>(new Map())
  // Per-pair scheduler params (forward_typed row), keyed `${src}|${tgt}` — so a
  // mixed all-due session schedules each card with ITS pair's constants/retention.
  const [paramsByPair, setParamsByPair] = useState<Map<string, SchedulerParamsRow>>(new Map())

  const handleOverrideAnswer = useCallback((cardId: string, answerSide: CardSide, answerText: string, accept: boolean) => {
    const repo = new SupabaseTypedAnswerOverrideRepository()
    const key  = `${cardId}:${answerSide}`
    // Remember a NEW "mark correct" so undo can revert exactly this add (pre-existing overrides stay).
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

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/auth'); return }
      setUserId(session.user.id)

      const deckRepo     = new SupabaseDeckRepository()
      const cardRepo     = new SupabaseCardRepository()
      const stateRepo    = new SupabaseCardStateRepository()
      const pipelineRepo = new SupabasePipelineRepository()
      const prefRepo     = new SupabaseDeckPreferencesRepository()

      // One wave for everything that needs only the user id. These used to run as FOUR sequential
      // stages (overrides → decks/pipeline/profile → scheduler params → confusion links), each
      // waiting on the one before it despite no data dependency — pure latency on the path to the
      // first card. Same restructuring as the study dashboard's load().
      const [existingOverrides, decks, pipeline, profileData, allParamRows, intraLinksAll] = await Promise.all([
        new SupabaseTypedAnswerOverrideRepository().listForUser(session.user.id),
        deckRepo.list(session.user.id),
        pipelineRepo.getDefault(),
        loadProfileRow(() => supabase.from('profiles').select('timezone, day_turnover_hour, study_mode_autoplay, audio_source_default, audio_source_by_language').eq('user_id', session.user.id).single()),
        new SupabaseUserSchedulerParamsRepository().listForUser(session.user.id),
        new SupabaseCardConfusionLinkRepository().listForUser(session.user.id).catch(() => []),
      ])
      const overrideMap = new Map<string, Set<string>>()
      for (const o of existingOverrides) {
        const key = `${o.cardId}:${o.answerSide}`
        const set = overrideMap.get(key) ?? new Set<string>()
        set.add(o.answerText)
        overrideMap.set(key, set)
      }
      setOverrides(overrideMap)

      const tz           = (profileData.data?.timezone as string | null) ?? deviceTimeZone()
      const turnoverHour = (profileData.data?.day_turnover_hour as number | null) ?? 0
      tzRef.current       = tz
      turnoverRef.current = turnoverHour
      setStudyModeAutoplay((profileData.data?.study_mode_autoplay as boolean | null) ?? true)
      setAudioSourceDefault(profileData.data?.audio_source_default as string | null)
      setAudioSourceByLanguage(profileData.data?.audio_source_by_language as Record<string, string> | null)
      const now   = new Date()
      const today = getToday(tz, turnoverHour)

      // Compare by local calendar date rather than UTC timestamp so any card
      // whose due date falls on today (or earlier) is available all day,
      // regardless of what time-of-day it was snapped to.
      const isDueByDate = (dateStr: string | null | undefined): boolean => {
        if (!dateStr) return false
        return new Date(dateStr).toLocaleDateString('en-CA', { timeZone: tz }) <= today
      }

      // Scheduler params for the primary language pair (URL params if provided, else first deck).
      // The row is almost always already in the listForUser result above — the old getOrCreate here
      // cost 2 extra serial round trips (upsert + select) per session start. Only a genuinely new
      // pair (no row yet) still awaits the create.
      const primaryPair = sourceLang && targetLang
        ? { src: sourceLang, tgt: targetLang }
        : decks.length > 0 ? { src: decks[0]!.sourceLanguage, tgt: decks[0]!.targetLanguage } : null
      if (primaryPair) {
        try {
          const paramsRow =
            allParamRows.find(r => r.sourceLanguage === primaryPair.src && r.targetLanguage === primaryPair.tgt && r.answerField === 'forward_typed')
            ?? await new SupabaseUserSchedulerParamsRepository().getOrCreate(session.user.id, primaryPair.src, primaryPair.tgt, 'forward_typed')
          setSchedulerParams(paramsRow)
          setForwardTypedEnabled(paramsRow.forwardTypedEnabled ?? true)
          setForwardRecallEnabled(paramsRow.forwardRecallEnabled ?? true)
        } catch { /* fall back to defaults */ }
      }

      // Per-pair enabled review tracks — a disabled track's due cards are ghosted
      // (filtered from Due Now) but their scheduling is preserved.
      const enabledTracksMap = buildEnabledTracksMap(allParamRows)
      calMapRef.current = buildCalibrationMap(allParamRows)
      retMapRef.current = buildRetentionMap(allParamRows)
      const sMap = new Map<string, TypedStrictness>()
      const pMap = new Map<string, SchedulerParamsRow>()
      for (const r of allParamRows) {
        if (r.answerField !== 'forward_typed') continue
        sMap.set(`${r.sourceLanguage}|${r.targetLanguage}`, {
          spelling: r.strictSpelling, accents: r.strictAccents, articles: r.strictArticles,
        })
        pMap.set(`${r.sourceLanguage}|${r.targetLanguage}`, r)
      }
      setStrictnessMap(sMap)
      setParamsByPair(pMap)
      const tracksFor = (src: string, tgt: string): EnabledTracks | undefined =>
        enabledTracksMap.get(`${src}|${tgt}`)
      const smartThresholdFor = (src: string, tgt: string): number =>
        pMap.get(`${src}|${tgt}`)?.smartTypingThresholdDays ?? DEFAULT_SCHEDULER_PARAMS.smartTypingThresholdDays
      // Persist for the on-complete "more due?" re-check (Continue button).
      decksRef.current = decks; enabledMapRef.current = enabledTracksMap; paramMapRef.current = pMap
      // Intra-language confusion links → interleave confusable pairs so they land next to each other.
      const intraLinks = intraLinksAll.filter(l => l.kind === 'intra')

      // Second wave: the whole scope's cards, states and deck prefs in THREE bulk queries instead of
      // 2-3 per deck. The old per-deck for…of serialized ~2 round trips per deck (a dozen decks ≈ two
      // dozen sequential round trips before the queue could build). Cards come back WITHOUT the
      // base64 audio blobs (SESSION_CARD_COLUMNS) — stored clips are hydrated for queued cards below.
      const deckIds = decks.map(d => d.id)
      const [cardsByDeck, allStatesList, prefsByDeck] = await Promise.all([
        cardRepo.listForDecks(deckIds),
        stateRepo.listAllForUser(session.user.id),
        prefRepo.listForDecks(session.user.id, deckIds),
      ])
      const statesByCard = new Map<string, typeof allStatesList>()
      for (const s of allStatesList) {
        const arr = statesByCard.get(s.cardId)
        if (arr) arr.push(s); else statesByCard.set(s.cardId, [s])
      }
      const statesForDeck = (deckCards: { id: string }[]) => deckCards.flatMap(c => statesByCard.get(c.id) ?? [])

      // Stored-clip hydration for the trimmed session reads (see SESSION_CARD_COLUMNS). Patches both
      // audioData AND audioSources — the ℹ modal's "Use this" writes `{...audioSources, [src]: …}`
      // back, so a null audioSources there would clobber the other providers' stored clips.
      const applyAudioHydration = (patch: AudioPatch) => {
        setQueue(prev => prev.map(item => {
          const card = applyAudioPatch(item.card, patch)
          if (card === item.card && !item.deckCards.some(c => patch.has(c.id))) return item
          return { ...item, card, deckCards: item.deckCards.map(c => applyAudioPatch(c, patch)) }
        }))
      }
      const hydrateQueueAudio = async (finalQueue: SessionCard[]) => {
        const first = finalQueue[0]
        if (first && needsAudioHydration(first.card)) {
          // The first card autoplays on mount — wait for its one stored clip so playback doesn't
          // fall back to regenerating via TTS (cost, and a Forvo recording can't be regenerated).
          const patch = await hydrateSessionAudio([first.card], applyAudioHydration)
          const p = patch.get(first.card.id)
          if (p) first.card = { ...first.card, audioData: p.audioData, audioSources: p.audioSources }
        }
        // Everything else lands in the background and patches the queue as it arrives.
        void hydrateSessionAudio(finalQueue.slice(1).map(i => i.card), applyAudioHydration)
      }

      // ?category= elective study: build queue from only that category across
      // all decks (or, when source/target are given, just that language pair).
      // Sessions scoped to a language pair are not capped.
      if (category) {
        const categoryCards: SessionCard[] = []
        const hasLangFilter = !!(sourceLang && targetLang)
        for (const deck of decks) {
          if (hasLangFilter && (deck.sourceLanguage !== sourceLang || deck.targetLanguage !== targetLang)) continue
          const cards  = cardsByDeck.get(deck.id) ?? []
          const states = statesForDeck(cards)
          const stateMap          = new Map(states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]))
          const reverseStatesList = states.filter(s => s.reviewDirection === 'reverse')
          const common     = { pipeline, gradingSettings: deck.gradingSettings, deckId: deck.id, deckName: deck.name, deckCards: cards, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage }
          const deckCommon = { pipeline, gradingSettings: deck.gradingSettings, deckId: deck.id, deckName: deck.name, deckCards: cards, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage }
          for (const card of cards) {
            const state = stateMap.get(card.id)
            if (category === 'new' && !state) {
              categoryCards.push({ ...common, card, state: initialCardState(session.user.id, card.id, pipeline.id), productionMode: null })
            } else if (category === 'learning' && state && !state.graduated) {
              categoryCards.push({ ...common, card, state, productionMode: null })
            } else if (category === 'graduated' && state?.graduated && !state.dormant) {
              categoryCards.push({ ...common, card, state, productionMode: decideProductionMode(state, now, Math.random, schedulerParams) })
            } else if (category === 'dormant' && state?.dormant) {
              categoryCards.push({ ...common, card, state, productionMode: decideProductionMode(state, now, Math.random, schedulerParams) })
            } else if (category === 'due' && state?.graduated && !state.dormant && dirParam !== 'reverse') {
              const en = tracksFor(deck.sourceLanguage, deck.targetLanguage)
              // Production is one lane (typed/smart mutually exclusive): the due date may sit in the
              // typed OR smart column, but it's reviewed on whichever lane is enabled.
              const prodTrack = activeProductionTrack(en)
              const prodDueDate = state.smartDueAt ?? state.typedDueAt ?? state.dueAt
              if (prodTrack && isDueByDate(prodDueDate)) categoryCards.push({ ...common, card, state, reviewTrack: prodTrack, productionMode: forwardProductionMode(state, prodTrack, smartThresholdFor(deck.sourceLanguage, deck.targetLanguage)) })
              if (isDueByDate(state.recallDueAt) && trackEnabled(en, 'recall', false)) categoryCards.push({ ...common, card, state, reviewTrack: 'recall', productionMode: 'self-graded' })
            }
          }
          if (category === 'due' && dirParam !== 'forward') {
            for (const reverseState of reverseStatesList) {
              if (!trackEnabled(tracksFor(deck.sourceLanguage, deck.targetLanguage), 'recall', true)) continue
              if (reverseState.dormant) continue   // recognition paused (per-direction dormancy)
              if (!isDueByDate(reverseState.recallDueAt ?? reverseState.dueAt)) continue
              const revCard = cards.find(c => c.id === reverseState.cardId)
              if (revCard) categoryCards.push({ ...deckCommon, card: revCard, state: reverseState, productionMode: 'self-graded', reviewTrack: 'recall', isReverse: true })
            }
          }
        }
        const dedupedCards = filterByPresent(dedupeDueReviews(categoryCards))
        const finalQueue = interleaveConfusablePairs(hasLangFilter ? shuffle(dedupedCards) : shuffle(dedupedCards).slice(0, ALL_ELECTIVE_LIMIT), intraLinks)
        if (finalQueue.length === 0) { setDone(true); setLoading(false); return }
        setElectiveSession(true)
        await hydrateQueueAudio(finalQueue)
        setQueue(finalQueue)
        setLoading(false)
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
        const cards  = cardsByDeck.get(deck.id) ?? []
        const states = statesForDeck(cards)
        const prefs  = prefsByDeck.get(deck.id) ?? null

        const forwardStates     = states.filter(s => s.reviewDirection !== 'reverse')
        const reverseStatesList = states.filter(s => s.reviewDirection === 'reverse')
        const stateMap = forwardStateMap(forwardStates)
        const cardsPerSession   = prefs?.cardsPerSession   ?? null
        const learningBatchMode = prefs?.learningBatchMode ?? false
        batchSizeRef.current = cardsPerSession && cardsPerSession > 0 ? cardsPerSession : ALL_ELECTIVE_LIMIT

        // When a per-session limit is set, cap BOTH new intros and the
        // in-pipeline backlog to the active learning set; otherwise use the
        // daily new-card budget.
        let limitedLearningSet: Set<string> | null = null
        let newCardBudget = 0
        if (cardsPerSession && cardsPerSession > 0) {
          limitedLearningSet = computeActiveLearningSet(
            cards, id => stateMap.get(id), cardsPerSession, learningBatchMode,
          )
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
            deckId:          deck.id,
            deckName:        deck.name,
            deckCards:       cards,
            sourceLanguage:  deck.sourceLanguage,
            targetLanguage:  deck.targetLanguage,
          }

          if (!state) {
            if (limitedLearningSet) {
              if (!limitedLearningSet.has(card.id)) continue
            } else {
              if (newCardBudget <= 0) continue
              newCardBudget--
            }
            allCards.push({ ...common, state: initialCardState(session.user.id, card.id, pipeline.id), productionMode: null })
          } else if (!state.graduated) {
            // In pipeline — include only if within the active learning set.
            if (limitedLearningSet && !limitedLearningSet.has(card.id)) continue
            allCards.push({ ...common, state, productionMode: null })
          } else if (state.graduated && state.dormant) {
            // Dormant cards never become due automatically.
          } else if (state.graduated) {
            const en = tracksFor(deck.sourceLanguage, deck.targetLanguage)
            const prodTrack = activeProductionTrack(en)
            const prodDueDate = state.smartDueAt ?? state.typedDueAt ?? state.dueAt
            if (prodTrack && isDueByDate(prodDueDate)) allCards.push({ ...common, state, reviewTrack: prodTrack, productionMode: forwardProductionMode(state, prodTrack, smartThresholdFor(deck.sourceLanguage, deck.targetLanguage)) })
            if (isDueByDate(state.recallDueAt) && trackEnabled(en, 'recall', false)) allCards.push({ ...common, state, productionMode: 'self-graded', reviewTrack: 'recall' })
          }
        }

        // Add due reverse-direction rows for this deck (unless the reverse track is disabled)
        const deckCommon = { pipeline, gradingSettings: deck.gradingSettings, deckId: deck.id, deckName: deck.name, deckCards: cards, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage }
        const reverseEnabled = trackEnabled(tracksFor(deck.sourceLanguage, deck.targetLanguage), 'recall', true)
        for (const reverseState of reverseStatesList) {
          if (!reverseEnabled) break
          if (reverseState.dormant) continue   // recognition paused (per-direction dormancy)
          if (!isDueByDate(reverseState.recallDueAt ?? reverseState.dueAt)) continue
          const card = cards.find(c => c.id === reverseState.cardId)
          if (card) allCards.push({ ...deckCommon, card, state: reverseState, productionMode: 'self-graded', reviewTrack: 'recall', isReverse: true })
        }
      }

      if (allCards.length === 0) { setDone(true); setLoading(false); return }

      // Collapse multiple due tracks for the same card+direction into one review.
      const dedupedAll = filterByPresent(dedupeDueReviews(allCards))

      // Shuffle all seen cards; keep new cards in order at the start
      const newCards  = dedupedAll.filter(c => !c.state.lastReviewedAt)
      const seenCards = shuffle(dedupedAll.filter(c => c.state.lastReviewedAt))
      const finalQueue = interleaveConfusablePairs([...newCards, ...seenCards], intraLinks)
      await hydrateQueueAudio(finalQueue)
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

  // Relearn resurfacing. A lapsed (Again/Hard) graduated card KEEPS coming back THIS session until it
  // exits the relearn loop (Good×2 / Easy, or 3 Agains → ladder) — it is never deferred to a later
  // session, so difficult cards can't slip by. It resurfaces mid-session once its real-clock time has
  // passed; and if the main queue empties while relearns are still pending, the soonest is flushed to
  // the end (so the session doesn't end with unresolved relearns).
  useEffect(() => {
    if (loading || done) return
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
      // Queue exhausted but relearns still pending → flush the soonest (never roll over to a later session).
      const soonest = [...relearnPool].sort((a, b) => dueMs(a) - dueMs(b))[0]!
      setQueue(prev => [...prev, soonest])
      setRelearnPool(prev => prev.filter(c => c !== soonest))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue.length, done, loading, relearnPool])

  // On completion of a Due Now session, re-check whether more cards are due in this same scope +
  // present filter (e.g. new cards became due, or a relearn's timer elapsed) → show "Continue".
  useEffect(() => {
    if (!done || category !== 'due' || !decksRef.current) return
    let cancelled = false
    ;(async () => {
      const decks = decksRef.current!, tz = tzRef.current
      const today = getToday(tz, turnoverRef.current)
      const dueByDate = (d?: string | null) => !!d && new Date(d).toLocaleDateString('en-CA', { timeZone: tz }) <= today
      const wantTyping = presentParam === 'typing', wantSelf = presentParam === 'selfgraded'
      const stateRepo = new SupabaseCardStateRepository()
      // Only the in-scope decks, fetched IN PARALLEL (sequential per-deck round-trips were the latency).
      const scopedDecks = decks.filter(d => !(sourceLang && targetLang) || (d.sourceLanguage === sourceLang && d.targetLanguage === targetLang))
      const perDeck = await Promise.all(scopedDecks.map(d => stateRepo.listByDeck(userId, d.id).catch(() => [] as CardState[])))
      if (cancelled) return
      let count = 0
      for (let di = 0; di < scopedDecks.length; di++) {
        const deck = scopedDecks[di]!
        const en = enabledMapRef.current?.get(`${deck.sourceLanguage}|${deck.targetLanguage}`)
        const threshold = paramMapRef.current?.get(`${deck.sourceLanguage}|${deck.targetLanguage}`)?.smartTypingThresholdDays ?? 20
        const states = perDeck[di]!
        for (const s of states) {
          if (!s.graduated) continue
          if (s.reviewDirection === 'reverse') {
            if (wantTyping || dirParam === 'forward') continue                 // reverse is self-graded
            // Per-direction dormancy: gate on the REVERSE row's own flag, matching the queue builder.
            // (This block previously checked the FORWARD row's dormancy and never the reverse row's,
            // so a paused-recognition card could still be counted here and inflate "Continue (N)".)
            if (s.dormant) continue
            if (!trackEnabled(en, 'recall', true)) continue
            if (dueByDate(s.recallDueAt ?? s.dueAt)) count++
          } else {
            if (s.dormant || dirParam === 'reverse') continue
            const prodTrack = activeProductionTrack(en)
            const prodDue = !!prodTrack && dueByDate(s.smartDueAt ?? s.typedDueAt ?? s.dueAt)
            const recallDue = dueByDate(s.recallDueAt) && trackEnabled(en, 'recall', false)
            if (prodDue) {
              const typed = forwardProductionMode(s, prodTrack!, threshold) === 'typed'
              if (wantTyping ? typed : wantSelf ? !typed : true) count++
            } else if (recallDue && !wantTyping) count++          // recall is self-graded
          }
        }
      }
      if (!cancelled) setMoreDue(count)
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

  useEffect(() => { indexRef.current = index }, [index])

  useEffect(() => {
    localStorage.setItem('lexify_ipa', showIPA ? '1' : '0')
  }, [showIPA])

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

  useEffect(() => {
    if (!showIPA) return
    const current = queue[index]
    if (!current) return
    const { card, sourceLanguage } = current
    if (ipaCache.has(card.id) || card.ipa) return
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
  }, [showIPA, queue[index]?.card.id])

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
    const { card, state, sourceLanguage, targetLanguage } = current
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
      const { card, state, pipeline, gradingSettings, productionMode, reviewTrack, isReverse, deckCards, sourceLanguage, targetLanguage } = current

      // A fresh answer invalidates any pending redo, and captures a just-added override for undo.
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
      if (state.graduated && !wasCorrect && !isReverse && reviewTrack !== 'recall' && productionMode === 'typed' && userAnswer.trim()) {
        const drillSource = current
        void respondToProductionConfusion({
          userId, cardAId: card.id, sourceLanguageA: sourceLanguage, typed: userAnswer, expectedFront: card.front,
          gradingSettings, tz: tzRef.current, turnover: turnoverRef.current,
        }).then(d => { if (d) queueDrill(drillSource, d.cardBId, d.cardBFront) })
      }

      // This card's own language-pair scheduler constants (retention, graduation
      // ranges, max interval) — a mixed all-due session may span several pairs.
      const cardParams = paramsByPair.get(`${sourceLanguage}|${targetLanguage}`) ?? schedulerParams
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
          ? deckCards.find(c => c.front.trim().toLowerCase() === userAnswer.trim().toLowerCase())?.id ?? null
          : deckCards.find(c => c.back.trim().toLowerCase()  === userAnswer.trim().toLowerCase())?.id ?? null
        const isWordMixup = step.stepType !== 'typing'
          || isDifferentWordMistake(userAnswer, reviewAnswerSide === 'front' ? card.front : card.back, gsWithLang)
        new SupabaseCardConfusionRepository().record(card.id, userAnswer.trim(), reviewAnswerSide, isWordMixup, confusedWithCardId)
          .catch(err => console.error('Failed to record card confusion:', err))
      }

      const nowDate    = new Date()
      const reviewMode = classifyReviewMode(state, nowDate)
      const isRecallReview = reviewTrack === 'recall' || !!isReverse
      const wasTyped   = state.graduated ? (isRecallReview ? false : productionMode === 'typed') : null

      // Hint (Due Now only): dampens interval growth on a correct answer; ignored on `again`.
      const hint = state.graduated ? hintRef.current : null
      hintRef.current = null
      const nearMiss = nearMissRef.current
      nearMissRef.current = false

      // Per-category typed penalty: an accepted accent/article/spelling slip counts as
      // correct but dampens the interval by its weight; a lenient slip has weight 0.
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
        }, grade, { ...DEFAULT_FSRS_CONFIG, requestRetention: retentionFor(retMapRef.current, sourceLanguage, targetLanguage, isReverse ? 'reverse_recall' : 'forward_recall'), retentionCalibration: calibrationFor(calMapRef.current, sourceLanguage, targetLanguage, isReverse ? 'reverse_recall' : 'forward_recall') }, { softLapse: nearMiss, hintGrowthFactor: hint?.growthFactor })
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
          ...(isReverse ? { dueAt: newRecallDueAt } : {}),
        }
        await stateRepo.upsert(recallNewState)
        setUndoStack(prev => [...prev.slice(-9), { queueIndex: index, prevState: { ...state }, newState: recallNewState, eventId: reviewEvent.id, overrideAdd: undoOverride, userAnswer, wasCorrect, selfGraded: productionMode === 'self-graded' }])
        setRedoStack([])
        setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: recallNewState } : item))
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
      // Because it IS target-language production, three Agains in a row un-graduate.
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
        }, grade, { ...DEFAULT_FSRS_CONFIG, requestRetention: retentionFor(retMapRef.current, sourceLanguage, targetLanguage, 'forward_smart'), retentionCalibration: calibrationFor(calMapRef.current, sourceLanguage, targetLanguage, 'forward_smart') }, { softLapse: nearMiss, hintGrowthFactor: hint?.growthFactor })

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

        // Re-derive presentation from the new state: a lapse (relearning / interval back below
        // threshold) reverts the smart card to typed until it climbs past the threshold again.
        const smartMode = forwardProductionMode(smartNewState, 'smart', cardParams.smartTypingThresholdDays)
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

      // A wrong pipeline typing answer is a "struggle" feeding the cumulative error count.
      const pipelineErrorInc = (!state.graduated && step.stepType === 'typing' && !wasCorrect) ? 1 : 0

      let newState = progressAfterReview(state, pipeline, { wasCorrect, rating, wrongSeverity, wasTyped: wasTyped ?? false }, nowDate)

      if (state.graduated && !newState.graduated) {
        eventRepo.markLapsed(reviewEvent.id, userId).catch(() => {})
      }

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
        }, grade, { ...DEFAULT_FSRS_CONFIG, requestRetention: retentionFor(retMapRef.current, sourceLanguage, targetLanguage, 'forward_typed'), retentionCalibration: calibrationFor(calMapRef.current, sourceLanguage, targetLanguage, 'forward_typed') }, { softLapse: nearMiss, hintGrowthFactor: hint?.growthFactor })
        if (fsrs.sendToLadder) {
          // Un-graduate and restart the CURRENT ladder (drop any stale climb row).
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
            relearningStep:        fsrs.dueInMinutes != null ? 1 : 0,
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

      if (!state.graduated && newState.graduated && newState.dueAt) {
        const errors    = state.pipelineErrorCount ?? 0
        const [minDays, maxDays] = graduationIntervalRange(errors, cardParams)
        const idealDays = Math.floor((minDays + maxDays) / 2)
        const idealDueAt = new Date(nowDate.getTime() + idealDays * 24 * 60 * 60 * 1000).toISOString()
        const smoothed = (maxDays - minDays >= 1)
          ? await smoothDueDate(userId, idealDueAt, minDays, maxDays, idealDays, stateRepo)
          : idealDueAt
        newState = { ...newState, dueAt: smoothed, intervalDays: idealDays, scheduledIntervalDays: idealDays, typedDueAt: smoothed, typedIntervalDays: idealDays, graduationErrorCount: errors, pipelineErrorCount: 0, intervalHistory: appendHistory(newState.intervalHistory, idealDays) }
      }

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
            const newRecallInt = Math.min(Math.round((newState.recallIntervalDays) * growthRatio), cardParams.maxIntervalDays)
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
        }, softWrongRecallRating, { ...DEFAULT_FSRS_CONFIG, requestRetention: retentionFor(retMapRef.current, sourceLanguage, targetLanguage, isReverse ? 'reverse_recall' : 'forward_recall'), retentionCalibration: calibrationFor(calMapRef.current, sourceLanguage, targetLanguage, isReverse ? 'reverse_recall' : 'forward_recall') }, {})
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

      // Dormancy: auto-go dormant after N production reviews (this path = forward production).
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

      setUndoStack(prev => [...prev.slice(-9), { queueIndex: index, prevState: { ...state }, newState, eventId: reviewEvent.id, overrideAdd: undoOverride, userAnswer, wasCorrect, selfGraded: productionMode === 'self-graded' }])
      setRedoStack([])

      // 10-minute "Again" relearn loop: hold the card in the relearn pool until
      // its dueAt passes. The pool-injection useEffect above reintroduces it
      // once the main queue runs out, ordered by elapsed percentage.
      if (newState.graduated && newState.relearningStep > 0) {
        const requeued: SessionCard = { ...current, state: newState, productionMode: decideProductionMode(newState, nowDate), relearnLapsedAt: reviewCountRef.current }
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

  const handleUndo = useCallback(async () => {
    // Two-stage undo. First press (below) reverts the rating in the DB and re-shows the card ANSWERED
    // (reRate set) so a different rating can be picked. A second press, while that answered view is up,
    // just clears it → the real card component remounts blank for a full re-do. The schedule is already
    // reverted from the first press, so this stage touches no data.
    if (reRate) { setReRate(null); return }
    const entry = undoStack[undoStack.length - 1]
    if (!entry || submitting) return
    setUndoStack(prev => prev.slice(0, -1))
    setRedoStack(prev => [...prev, entry])
    try {
      const stateRepo = new SupabaseCardStateRepository()
      await stateRepo.upsert(entry.prevState)
      // Delete the logged review (undo+redo counts once) and roll back a just-added override.
      if (entry.eventId) new SupabaseReviewEventRepository().delete(entry.eventId).catch(() => {})
      if (entry.overrideAdd) handleOverrideAnswer(entry.overrideAdd.cardId, entry.overrideAdd.answerSide, entry.overrideAdd.answerText, false)
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
      setQueue(prev => prev.map((item, i) => i === entry.queueIndex ? { ...item, state: entry.newState } : item))
      const nextIdx = entry.queueIndex + 1
      if (nextIdx >= queue.length && relearnPool.length === 0) { setDone(true) } else { setIndex(nextIdx) }
    } catch (err) { console.error('Redo failed:', err) }
  }, [redoStack, submitting, queue.length, relearnPool.length])

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
      const requeued: SessionCard = { ...current, state: counted, idontknow: true, relearnLapsedAt: reviewCountRef.current }
      if (counted.graduated && counted.relearningStep > 0) {
        // Graduated card entered relearn loop — hold in pool until timer elapses
        setQueue(prev => prev.map((item, i) => i === index ? { ...current, state: counted } : item))
        setRelearnPool(prev => [...prev, requeued])
      } else {
        // Pre-graduation or relapsed back into pipeline — reinsert ahead, displace last card.
        setQueue(prev => {
          const next = [...prev]
          next[index] = { ...current, state: counted }
          if (index + 1 < next.length) {
            const insertPos = Math.min(index + 1 + IDONTKNOW_REQUEUE_OFFSET, next.length)
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
      // If sibling is also in the queue, update its state there too
      setQueue(prev => prev.map(item => item.card.id === siblingCardId ? { ...item, state: newState } : item))
    } catch (err) {
      console.error('Failed to credit sibling card:', err)
    }
  }, [queue, index, userId])

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
    stateRepo.delete(userId, current.card.id, 'reverse').catch(console.error)
    setIndex(i => i + 1)
  }, [queue, index, userId])



  const handleChoicesCached = useCallback((cardId: string, choices: Card['choices']) => {
    setQueue(prev => prev.map(item => {
      if (item.card.id !== cardId) return item
      const card = { ...item.card, choices }
      return { ...item, card, deckCards: item.deckCards.map(c => c.id === cardId ? card : c) }
    }))
  }, [])

  // ── Card info/edit modal wiring ─────────────────────────────────────────────
  const applyInfoCardChange = useCallback((updated: Card, prevId?: string) => {
    const oldId = prevId ?? updated.id
    setQueue(prev => prev.map(item => ({
      ...item,
      card:      item.card.id === oldId ? updated : item.card,
      deckCards: item.deckCards.map(c => c.id === oldId ? updated : c),
    })))
  }, [])

  const applyInfoStateChange = useCallback((updated: CardState, prevId?: string) => {
    const oldId = prevId ?? updated.cardId
    setQueue(prev => prev.map(item => item.card.id === oldId ? { ...item, state: updated } : item))
  }, [])

  const handleInfoSave = useCallback(async (cardId: string, front: string, back: string) => {
    const item = queue.find(i => i.card.id === cardId)
    if (!item) return
    const cardRepo  = new SupabaseCardRepository()
    const stateRepo = new SupabaseCardStateRepository()
    const { card: updated, forked } = await cardRepo.forkInDeck(item.deckId, cardId, userId, { front, back })
    if (forked) {
      await stateRepo.copy(userId, cardId, updated.id)
      applyInfoStateChange({ ...item.state, cardId: updated.id }, cardId)
    }
    applyInfoCardChange(updated, cardId)
  }, [queue, userId, applyInfoCardChange, applyInfoStateChange])

  const handleInfoDelete = useCallback((cardId: string) => {
    setInfoOpen(false)
    setQueue(prev => prev.filter(item => item.card.id !== cardId))
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
      ? { front: newText, audioGenerated: false as const, audioData: null, choices: null }
      : { back: newText, choices: null }
    const updated = await cardRepo.update(cardId, patch)
    setQueue(prev => prev.map(it => ({
      ...it,
      card:      it.card.id === cardId ? updated : it.card,
      deckCards: it.deckCards.map(c => c.id === cardId ? updated : c),
    })))
    if (promptSide === 'front') {
      void prefetchAudio([{ card: updated, sourceLanguage: currentItem.sourceLanguage }], handleAudioCached)
    }
    for (const side of ['front', 'back'] as const) {
      void ensureChoicesGenerated(updated, side, currentItem.deckCards, currentItem.sourceLanguage, currentItem.targetLanguage)
        .then(ai => { if (ai) handleChoicesCached(cardId, ai) })
    }
  }, [queue, handleAudioCached, handleChoicesCached])

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

  useEffect(() => {
    const sourceLanguage = sourceLang ?? queue[0]?.sourceLanguage
    const targetLanguage = targetLang ?? queue[0]?.targetLanguage
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

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading session…</div>

  if (done) {
    const CATEGORY_LABELS: Record<StudyCategory, string> = { new: 'Unlearned', learning: 'Learning', graduated: 'Graduated', due: 'Due Now', dormant: 'Dormant' }
    const pairLabel = sourceLang && targetLang ? `${langName(sourceLang)} / ${langName(targetLang)}` : null
    const backLabel = pairLabel ? `Back to ${pairLabel}` : 'Back to study'
    return (
      <div className="max-w-md mx-auto pt-20 text-center space-y-6">
        <div className="text-5xl">🎉</div>
        <h2 className="text-2xl font-semibold text-ink">Session complete!</h2>
        <p className="text-ink-muted">You reviewed {queue.length} card{queue.length !== 1 ? 's' : ''}{pairLabel ? ` in ${pairLabel}` : ' across all decks'}.</p>
        <div className="flex gap-3 justify-center flex-wrap">
          {category === 'due' ? (
            moreDue < 0 ? (
              // Still checking for leftover cards — hold the buttons so we never flash a wrong state.
              <p className="text-sm text-ink-faint">Checking for more…</p>
            ) : (
              <>
                <Link href="/study" className={moreDue > 0 ? 'btn-ghost' : 'btn-primary'}>Back to study</Link>
                {moreDue > 0 && (
                  <button onClick={() => window.location.reload()} className="btn-primary">Continue ({moreDue})</button>
                )}
              </>
            )
          ) : (
            <>
              <Link href={backHref} className="btn-primary">{backLabel}</Link>
              {electiveSession && category && (
                <button
                  onClick={() => router.push(
                    sourceLang && targetLang
                      ? `/study/all/session?category=${category}&source=${sourceLang}&target=${targetLang}`
                      : `/study/all/session?category=${category}`
                  )}
                  className="btn-ghost"
                >
                  Study ahead ({CATEGORY_LABELS[category]})
                </button>
              )}
            </>
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
          <Link href={backHref} className="text-sm text-ink-muted hover:text-ink">✕ End session</Link>
          <div className="absolute left-1/2 -translate-x-1/2 text-xs text-ink-muted">{index + 1} / {queue.length}</div>
          <div className="text-xs text-warning">Confusion drill</div>
        </div>
        <UndoFab show={undoStack.length > 0 || reRate !== null} onUndo={() => void handleUndo()} />
        <ConfusionDrill card={current.card} otherFront={current.drill.otherFront} deckName={current.deckName}
          onDone={() => setIndex(i => i + 1)}
          onPromptEdit={t => handlePromptEdit(current.card.id, 'back', t)}
          onInfo={() => setInfoOpen(true)} />
        {infoOpen && (
          <CardEditModal
            card={current.card} state={current.state} userId={userId} deckId={current.deckId}
            deckCards={current.deckCards} sourceLanguage={current.sourceLanguage} targetLanguage={current.targetLanguage}
            onSave={handleInfoSave} onCardChange={applyInfoCardChange} onStateChange={applyInfoStateChange}
            onDelete={handleInfoDelete} onClose={() => setInfoOpen(false)} initialShowStats
          />
        )}
      </div>
    )
  }

  const { card, state, pipeline, gradingSettings, deckId, deckName, deckCards, sourceLanguage, targetLanguage, isReverse: currentIsReverse } = current
  const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!
  const reviewPromptSide: CardSide = state.graduated ? (currentIsReverse ? 'front' : 'back') : step.promptSide
  const reviewAnswerSide: CardSide = state.graduated ? (currentIsReverse ? 'back'  : 'front') : step.answerSide
  const stepWillComplete = !state.graduated && state.correctInStep + 1 >= step.requiredCorrect

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
  const hintable = isGraduatedDueByDate(state, tzRef.current, getToday(tzRef.current, turnoverRef.current))

  return (
    <div className="space-y-8">
      {dormantNotice && (
        <div className="fixed left-1/2 -translate-x-1/2 top-6 z-50 px-4 py-2 rounded-card bg-surface-raised border border-line/70 text-sm text-ink shadow-lg">
          💤 Card is now dormant
        </div>
      )}
      <div className="relative flex items-center justify-between">
        <Link href={backHref} className="text-sm text-ink-muted hover:text-ink">✕ End session</Link>
        <div className="absolute left-1/2 -translate-x-1/2 text-xs text-ink-muted">{index + 1} / {queue.length}</div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-ink-muted">{state.graduated ? (currentIsReverse ? 'Reverse recall' : current.reviewTrack === 'recall' ? 'Recall' : 'Review') : `Step ${state.currentStepOrder + 1} · ${step.stepType}`}</div>
        </div>
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
      {reRate && reRate.queueIndex === index ? (
        // First-Undo re-rate view: the card shown answered so a different rating can be picked.
        // Rendered via FlashcardMode's revealed state regardless of the original mode (typed or
        // self-graded). Re-rating runs handleAnswer from the reverted state with the stored answer.
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
        <MultipleChoiceMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide} answerSide={step.answerSide}
          deckCards={deckCards} sourceLanguage={sourceLanguage} targetLanguage={targetLanguage} deckName={deckName}
          autoPlayAudio={studyModeAutoplay && (gradingSettings.autoPlayAudio ?? true)}
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
      ) : !state.graduated ? (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          promptLanguage={step.promptSide === 'front' ? sourceLanguage : undefined}
          answerLanguage={step.promptSide === 'back' ? sourceLanguage : targetLanguage}
          gradingSettings={gradingSettings} autoPlayAudio={studyModeAutoplay && (gradingSettings.autoPlayAudio ?? true)} gradedReview={false} deckName={deckName}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${step.answerSide}`) ?? [])}
          synonyms={step.answerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
          deckSiblings={deckSiblings(card, step.answerSide, deckCards)}
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
        <FlashcardMode key={`${card.id}-${index}`} card={card} promptSide={reviewPromptSide} deckName={deckName}
          onRate={rating => handleAnswer(rating, rating !== 'again')}
          onAlmost={state.graduated ? handleAlmost : undefined}
          onPromptEdit={t => handlePromptEdit(card.id, reviewPromptSide, t)}
          onAnswerEdit={t => handlePromptEdit(card.id, reviewAnswerSide, t)}
          onInfo={() => setInfoOpen(true)}
          hintable={hintable} onHint={handleHint}
          answerLanguage={reviewAnswerSide === 'front' ? sourceLanguage : targetLanguage}
          ipaText={currentIpaText} onToggleIPA={ipaToggle} />
      ) : (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={reviewPromptSide}
          promptLanguage={reviewPromptSide === 'front' ? sourceLanguage : undefined}
          answerLanguage={reviewPromptSide === 'back' ? sourceLanguage : targetLanguage}
          gradingSettings={gradingSettings} autoPlayAudio={studyModeAutoplay && (gradingSettings.autoPlayAudio ?? true)} gradedReview={true} deckName={deckName}
          overrideAnswers={Array.from(overrides.get(`${card.id}:${reviewAnswerSide}`) ?? [])}
          synonyms={reviewAnswerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
          deckSiblings={deckSiblings(card, reviewAnswerSide, deckCards)}
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
          strictness={strictnessMap.get(`${sourceLanguage}|${targetLanguage}`) ?? DEFAULT_TYPED_STRICTNESS}
          softWrongEnabled={softWrongEnabled}
          ipaText={currentIpaText} onToggleIPA={ipaToggle} />
      )}

      <UndoFab show={undoStack.length > 0 || reRate !== null} onUndo={() => void handleUndo()} />

      {infoOpen && (
        <CardEditModal
          card={card}
          state={state}
          userId={userId}
          deckId={deckId}
          deckCards={deckCards}
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
