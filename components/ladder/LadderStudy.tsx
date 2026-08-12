'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { routes } from '@/lib/routes'
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
import { SupabaseLadderEventRepository } from '@/lib/data/ladderEvents'
import { resolveEffectiveLadder } from '@/lib/ladder'
import { reviewRung, applyWindow, initialClimbState, type ClimbState, type RungAttemptOutcome, type IntervalRange } from '@/engine/ladderEngine'
import { stepPathway, initialRouteState, type RouteState, type PathwayEvent } from '@/engine/pathwayEngine'
import { SupabasePathwayRepository } from '@/lib/data/pathways'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { resolveEffectivePathway, ladderToPathway } from '@/lib/pathway'
import type { Pathway, PathwayState, Rung, ErrorType } from '@/domain'
import { pickNextCard, rungReshowMs, type QueueItem } from '@/lib/ladderSession'
import { prefetchAudio } from '@/lib/distractors'
import { hydrateSessionAudio, needsAudioHydration, applyAudioPatch, type AudioPatch } from '@/lib/sessionAudio'
import { snapDueAtToStartOfDay, getToday, localDateWithTurnover } from '@/lib/dates'
import { carriedGoal, plannedGoalSum, fullDebtGoal, isAutoGraduated, fullDebtExemptionAdjustment, owedGoalForDate, effectiveDebtSince } from '@/lib/goalCarryover'
import { SupabaseGoalScheduleRepository, progressForSchedules } from '@/lib/data/goalSchedules'
import { scheduleStatus } from '@/lib/goalSchedule'
import { fetchAllRows } from '@/lib/supabasePaged'
import type { CardState } from '@/domain'
import { initialCardState } from '@/engine/pipeline'
import { LadderStudyCard } from '@/components/ladder/LadderStudyCard'
import { apiUrl } from '@/lib/apiBase'
import { UndoFab } from '@/components/session/UndoFab'
import { CardEditModal } from '@/components/CardEditModal'
import { isOfflineActive } from '@/lib/offline/mode'
import { useActiveTimer } from '@/lib/activeTimer'
import type { Card, CardChoices, Deck, Ladder, RungType } from '@/domain'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'

// Ladder session id persists across refreshes (so a reload continues the same replay) as long as
// you're studying the same scope and haven't been away longer than this gap.
const SESSION_KEY = 'lexify-ladder-session'
const SESSION_GAP_MS = 45 * 60_000
const newSessionId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.round(Math.random() * 1e9)}`

const RUNG_LABEL: Record<RungType, string> = {
  mcq: 'Recognize', typing: 'Type', self_graded: 'Recall', dictation: 'Dictation',
}

/** Adapt a pathway State to the Rung shape `LadderStudyCard` expects (it only reads presentation
 *  fields). The ladder-only fields are filler — the card renderer never touches them. */
function stateAsRung(s: PathwayState): Rung {
  return {
    id: s.id, type: s.type, direction: s.direction, distractorSource: s.distractorSource,
    strictness: s.strictness, selfRated: s.selfRated, intervalInit: s.intervalInit,
    advanceTimes: 1, advanceInARow: true, dropBacks: [],
  }
}

/** What set of cards this ladder session covers. Decks in a folder / pair share a
 *  language pair, so they share one ladder — only the per-card deck varies. */
type LadderScope =
  | { kind: 'deck';   deckId: string }
  | { kind: 'folder'; folderId: string }
  | { kind: 'all';    source: string; target: string }

function backHref(scope: LadderScope): string {
  if (scope.kind === 'deck')   return routes.deck(scope.deckId)
  if (scope.kind === 'folder') return routes.library(scope.folderId)
  return `/library?source=${scope.source}&target=${scope.target}`
}

export function LadderStudy({ scope }: { scope: LadderScope }) {
  const category = useSearchParams().get('category') // 'new' | 'learning' | 'starred' | null
  const [userId, setUserId] = useState<string | null>(null)
  const [decksById, setDecksById] = useState<Map<string, Deck>>(new Map())
  const [deckByCard, setDeckByCard] = useState<Map<string, string>>(new Map())
  const [ladder, setLadder] = useState<Ladder | null>(null)
  const [cardsById, setCardsById] = useState<Map<string, Card>>(new Map())
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  // Session-sticky "show IPA": once you turn IPA on for any card, every card shows it until you turn it
  // off — no need to keep re-toggling. We also transcribe upcoming cards ahead of time (see below).
  const [ipaOn, setIpaOn] = useState(false)
  const [total, setTotal] = useState(0)
  const [states, setStates] = useState<Map<string, ClimbState | RouteState>>(new Map())
  // Pathway mode (per-pair): when set, this scope studies via the branched pathway engine instead of the
  // linear ladder. All ladder code paths below stay untouched; pathway logic lives in parallel branches.
  const [pathway, setPathway] = useState<Pathway | null>(null)
  const isPathway = pathway !== null
  const [graduated, setGraduated] = useState(0)
  const [answered, setAnswered] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const progressPctRef = useRef(0)
  const startStepsRef  = useRef(0)
  const tzRef          = useRef('UTC')
  const turnoverRef    = useRef(0)
  const sessionIdRef   = useRef<string>(newSessionId())
  const shownAtRef     = useRef<number>(Date.now())
  const reviewTimer    = useActiveTimer()
  // Pre-set dormancy (threshold/flag) per card, captured at load — preserved through graduation so a
  // dormancy set before studying isn't wiped when the card graduates.
  const dormancyByCardRef = useRef<Map<string, { threshold: number | null; dormant: boolean }>>(new Map())
  // Rolling pipeline (pipeline cap ON + "wait for full batch" OFF): keep ≤cap cards in the pipeline and
  // pull in a new fresh card each time one graduates, until the whole set is done.
  const rollingRef = useRef(false)
  const pendingFreshRef = useRef<string[]>([])
  // An override the CURRENT card newly added this attempt (so undo can remove exactly it).
  const pendingOverrideAddRef = useRef<{ cardId: string; answerSide: CardSide; answerText: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  // The card_states row for whichever card the ℹ modal is showing. The ladder doesn't otherwise
  // keep states in memory, but the modal needs one to render the Learning-track badge and to
  // reflect a track switch — without it the badge is computed from `undefined` and sticks on "Normal".
  const [infoState, setInfoState] = useState<CardState | undefined>(undefined)
  const [overrides, setOverrides] = useState<Map<string, Set<string>>>(new Map())
  const [undoStack, setUndoStack] = useState<Array<{
    cardId: string; prevClimb: ClimbState | RouteState | undefined; prevQueueItem: QueueItem | undefined
    wasGraduated: boolean; prevAnswered: number
    eventIdP: Promise<string | null> | null   // the logged ladder_event (deleted on undo)
    /** The in-flight graduation write. Undo AWAITS it before deleting card_states — deleting first
     *  would let the still-landing upserts resurrect the graduation as ghost rows. */
    gradP: Promise<unknown> | null
    overrideAdd: { cardId: string; answerSide: CardSide; answerText: string } | null  // override to roll back
  }>>([])

  // The deck a given card belongs to (for climb-save, grading, distractors).
  const deckFor = useCallback((cardId: string): Deck | undefined => {
    const dId = deckByCard.get(cardId)
    return dId ? decksById.get(dId) : undefined
  }, [deckByCard, decksById])

  // Stable key for what's being studied — used to decide whether a reload continues the same session.
  const scopeKeyStr = scope.kind === 'deck' ? `deck:${scope.deckId}`
    : scope.kind === 'folder' ? `folder:${scope.folderId}`
    : `all:${scope.source}|${scope.target}`

  const touchSession = useCallback(() => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ id: sessionIdRef.current, scope: scopeKeyStr, lastAt: Date.now() })) } catch { /* ignore */ }
  }, [scopeKeyStr])

  // The session an action at `now` belongs to: continue the persisted one when the SAME scope was last
  // active less than SESSION_GAP_MS ago, else start a new session. The 45-minute gap is measured from
  // the LAST activity (not the session's start), so a 20-min study + 30-min pause + more study stays one
  // session (30 < 45), while a pause ≥ 45 min opens a new one. Re-checked on every review, so it holds
  // even if the page was left open across the pause (no remount needed).
  const resolveSessionId = useCallback((now: number): string => {
    try {
      const prev = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as { id?: string; scope?: string; lastAt?: number } | null
      if (prev?.id && prev.scope === scopeKeyStr && now - (prev.lastAt ?? 0) < SESSION_GAP_MS) return prev.id
    } catch { /* ignore */ }
    return newSessionId()
  }, [scopeKeyStr])

  // On mount, adopt the right session for "now" (continues one movie across a refresh / short pause).
  useEffect(() => {
    sessionIdRef.current = resolveSessionId(Date.now())
    touchSession()
  }, [scopeKeyStr, resolveSessionId, touchSession])

  const handleOverrideAnswer = useCallback((cardId: string, answerSide: CardSide, answerText: string, accept: boolean) => {
    if (!userId) return
    const key = `${cardId}:${answerSide}`
    const already = overrides.get(key)?.has(answerText) ?? false
    // Remember a NEW "mark correct" so undo can revert exactly this add (pre-existing overrides stay).
    if (accept && !already) pendingOverrideAddRef.current = { cardId, answerSide, answerText }
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
  }, [userId, overrides])

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
      // Everything below is guarded: any throw in here (a rejected query, a bad scope) used to leave
      // `loading` stuck true forever, showing an endless "Loading session…" with no explanation.
      try {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      const uid = session.user.id; setUserId(uid)

      // ── Fire everything that needs only the user id NOW, await in dependency order below ──
      // These four used to run as separate serial stages sprinkled through this function (overrides
      // after the card load, language pairs after the ladder, prefs and profile after the climb),
      // each adding a full round trip to the time before the first card could render.
      const offline = isOfflineActive()
      const overridesP = new SupabaseTypedAnswerOverrideRepository().listForUser(uid)
      const pairsListP = offline ? Promise.resolve([]) : new SupabaseLanguagePairRepository().list(uid).catch(() => [])
      const prefsP = (scope.kind === 'deck' && !offline) ? new SupabaseDeckPreferencesRepository().get(uid, scope.deckId) : Promise.resolve(null)
      // ONE profiles select for audio + timezone + the goal/carryover flags (this function used to
      // select profiles twice). Falls back to the core columns if a not-yet-migrated goal column
      // errors the full select — the same hardening the study dashboard has (see CLAUDE.md landmine).
      const PROFILE_CORE = 'audio_source_default, audio_source_by_language, timezone, day_turnover_hour'
      const profileP = offline ? Promise.resolve(null) : (async () => {
        const full = await createClient().from('profiles').select(`${PROFILE_CORE}, goal_carry_shortfall, goal_carry_surplus, goal_full_debt, goal_full_debt_since, goal_full_debt_resets, full_debt_skip_shortfall_days, full_debt_skip_surplus_days, goal_deferrals`).eq('user_id', uid).maybeSingle()
        if (full.data) return full.data as Record<string, unknown>
        const core = await createClient().from('profiles').select(PROFILE_CORE).eq('user_id', uid).maybeSingle()
        return (core.data as Record<string, unknown> | null) ?? null
      })()

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
      // Bulk reads: ONE paged card query for the whole scope + one states query, instead of 3 per
      // deck (cards + the 2-step listByDeck states lookup) — a 20-deck folder was 60 requests.
      // Cards come back WITHOUT audio blobs (SESSION_CARD_COLUMNS); queued clips hydrate below.
      // The ladder fetch rides along — it only needs the primary deck's pair, known already.
      const cardRepo = new SupabaseCardRepository()
      const stateRepo = new SupabaseCardStateRepository()
      const primary = decks[0]!
      const ladderRepo = new SupabaseLadderRepository()
      const [cardsByDeck, allStatesList, pair, def] = await Promise.all([
        cardRepo.listForDecks(decks.map(d => d.id)),
        stateRepo.listAllForUser(uid),
        ladderRepo.getForPair(uid, primary.sourceLanguage, primary.targetLanguage),
        ladderRepo.getDefault(uid),
      ])
      const statesByCard = new Map<string, typeof allStatesList>()
      for (const s of allStatesList) {
        const arr = statesByCard.get(s.cardId)
        if (arr) arr.push(s); else statesByCard.set(s.cardId, [s])
      }
      const perDeck = decks.map(d => {
        const cards = cardsByDeck.get(d.id) ?? []
        return { deck: d, cards, states: cards.flatMap(c => statesByCard.get(c.id) ?? []) }
      })
      const allCards: Card[] = []
      const cardDeck = new Map<string, string>()
      const gradSet = new Set<string>()
      const learningStateSet = new Set<string>()
      const pipelineStateSet = new Set<string>()   // ANY non-graduated forward state (incl. pristine / booted)
      for (const { deck, cards, states: cs } of perDeck) {
        for (const c of cards) { if (!cardDeck.has(c.id)) { allCards.push(c); cardDeck.set(c.id, deck.id) } }
        for (const s of cs) {
          if (s.reviewDirection === 'reverse') continue
          dormancyByCardRef.current.set(s.cardId, { threshold: s.dormancyThreshold ?? null, dormant: s.dormant })
          // For the DEFAULT queue, a pristine state (no reps/progress) is still "fresh" (budget-capped);
          // but it IS in the pipeline for "Study Learning".
          if (s.graduated) gradSet.add(s.cardId)
          else { pipelineStateSet.add(s.cardId); if (s.reps > 0 || s.currentStepOrder > 0) learningStateSet.add(s.cardId) }
        }
      }
      setCardsById(new Map(allCards.map(c => [c.id, c])))
      setDeckByCard(cardDeck)

      // Persisted typed-answer overrides (fired in the first wave).
      const overrideRows = await overridesP
      const overrideMap = new Map<string, Set<string>>()
      for (const o of overrideRows) {
        const key = `${o.cardId}:${o.answerSide}`
        const set = overrideMap.get(key) ?? new Set<string>()
        set.add(o.answerText); overrideMap.set(key, set)
      }
      setOverrides(overrideMap)

      // One ladder for the whole scope (decks share a pair) — fetched in the bulk wave above.
      const effLadder = resolveEffectiveLadder(pair, def)
      setLadder(effLadder)

      // Pathway mode? Per-pair flag on the primary pair (offline is always ladder — pathways aren't bundled).
      setPathway(null)
      let effPathway: Pathway | null = null
      if (!offline) {
        const pairsList = await pairsListP
        const mode = pairsList.find(pp => pp.sourceLanguage === primary.sourceLanguage && pp.targetLanguage === primary.targetLanguage)?.learningMode ?? 'ladder'
        if (mode === 'pathway') {
          const pathRepo = new SupabasePathwayRepository()
          const [pp, dp] = await Promise.all([pathRepo.getForPair(uid, primary.sourceLanguage, primary.targetLanguage), pathRepo.getDefault(uid)])
          effPathway = resolveEffectivePathway(pp, dp) ?? ladderToPathway(effLadder)
          setPathway(effPathway)
        }
      }
      const onPathway = effPathway !== null
      const freshState = (): ClimbState | RouteState => onPathway ? initialRouteState(effPathway!) : initialClimbState()
      // A stored climb from the *other* mode has the wrong shape (rungIndex vs stateId) — restart it fresh.
      const rightShape = (cl: ClimbState | RouteState | undefined): boolean =>
        cl != null && (onPathway ? 'stateId' in cl : 'rungIndex' in cl)
      // A climb can also be DEAD: right shape, but its position no longer exists because the
      // pathway/ladder was edited mid-climb (a RouteState pointing at a deleted state id, or a
      // rungIndex past the end of a shortened ladder). Those cards used to fall through every queue
      // ("Nothing to study" on a deck full of learners). Treat them exactly like wrong-shape climbs:
      // restart JUST those cards from the start of the current shape — everything else keeps its place.
      const validPosition = (cl: ClimbState | RouteState | undefined): boolean => {
        if (!rightShape(cl)) return false
        if (onPathway) return effPathway!.states.some(st => st.id === (cl as RouteState).stateId)
        return (cl as ClimbState).rungIndex < effLadder.rungs.length
      }

      const climb = await new SupabaseLadderClimbRepository().listForCards(uid, allCards.map(c => c.id))

      // Deck order is preserved end-to-end: `allCards` is built deck-by-deck (deck position) and
      // card-by-card (card position) from `listForDecks`, so `fresh`/`learning` come out in the
      // order the words appear in the list, and nothing reorders them. You get the list front to
      // back. Caps (batch size, daily limit, stop-at-goal) still limit HOW MANY cards enter, but
      // they take them off the TOP of the list rather than sampling at random. `pickNextCard` serves
      // unseen cards (readyAt === 0) in queue order, so the ordering survives into the session.
      const learning: string[] = []
      const fresh: string[] = []
      const reconciled = new Map<string, ClimbState | RouteState>(climb)
      /** Cards whose stored climb was unusable and was restarted — repaired in the DB below. */
      const repaired: string[] = []
      for (const c of allCards) {
        if (gradSet.has(c.id)) continue
        const cl = climb.get(c.id)
        if (validPosition(cl) && !cl!.graduated) { learning.push(c.id); continue }
        const alreadyLearning = learningStateSet.has(c.id)
        if (cl || alreadyLearning) {
          reconciled.set(c.id, freshState())   // wrong-shape / dead-position / graduated-orphan / restart
          if (cl && !cl.graduated) repaired.push(c.id)
        }
        ;(alreadyLearning ? learning : fresh).push(c.id)
      }
      setStates(reconciled)

      // Persist the repairs. Without this the broken row survives until the card is next ANSWERED,
      // so every other surface (deck counts, the logs, another device) keeps reading the dead
      // position. Only cards that were actually stuck are touched; a healthy climb is never rewritten.
      if (repaired.length > 0) {
        const climbRepo = new SupabaseLadderClimbRepository()
        void Promise.all(repaired.map(id =>
          // `cardDeck`, not the `deckByCard` STATE — setDeckByCard above hasn't flushed yet.
          climbRepo.save(uid, id, cardDeck.get(id) ?? '', reconciled.get(id)!).catch(() => {}),
        ))
      }

      // Audio + timezone prefs (fired in the first wave). Per-deck intake caps only apply to
      // single-deck scope.
      const prefsRepo = new SupabaseDeckPreferencesRepository()
      const prefs = await prefsP
      setAudioPlaybackRate(prefs?.audioSpeed ?? 1)
      setAudioVolume(prefs?.audioVolume ?? 1)
      const profileRow = await profileP
      // Offline: no AI audio, and use the device's own timezone (device-local time is authoritative offline).
      if (offline) {
        setAudioSourceDefault('browser')
        setAudioSourceByLanguage(null)
        try { tzRef.current = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { tzRef.current = 'UTC' }
        turnoverRef.current = 0
      } else {
        setAudioSourceDefault((profileRow?.audio_source_default as string | null) ?? null)
        setAudioSourceByLanguage((profileRow?.audio_source_by_language as Record<string, string> | null) ?? null)
        tzRef.current       = (profileRow?.timezone as string | null) ?? deviceTimeZone()
        turnoverRef.current = (profileRow?.day_turnover_hour as number | null) ?? 0
      }

      // "Stop at daily goal": cap TOTAL new-card intake so graduatedToday(pair) + inPipeline +
      // newlyIntroduced never exceeds this language's daily goal. Only the default queue on a
      // single-deck ladder (a per-deck pref). goalToday 0 (no goal today) → no cap. Capping the fresh
      // POOL makes the batch/rolling/refill logic below respect it automatically (pending refill draws
      // from this pool, so the session stops introducing once the budget is exhausted).
      let eligibleFresh = fresh
      const wantGoalCap = !!prefs?.capNewToGoal && scope.kind === 'deck'
        && category !== 'new' && category !== 'learning' && !offline
      if (wantGoalCap) {
        const src = primary.sourceLanguage, tgt = primary.targetLanguage
        const todayStr = getToday(tzRef.current, turnoverRef.current)
        const yesterdayStr = new Date(new Date(todayStr + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10)
        const weekday  = new Date(todayStr + 'T12:00:00Z').getUTCDay()
        const db = createClient()
        // Goal/carryover flags come from the merged first-wave profile select (with its
        // core-columns fallback), so this block no longer issues its own profiles query — which
        // also hardens the stop-at-goal cap against the not-yet-migrated-column landmine.
        const profRes = { data: profileRow as {
          goal_carry_shortfall?: boolean; goal_carry_surplus?: boolean
          goal_full_debt?: boolean; goal_full_debt_since?: string | null; goal_full_debt_resets?: Record<string, string> | null
          full_debt_skip_shortfall_days?: string[] | null; full_debt_skip_surplus_days?: string[] | null
          goal_deferrals?: string[] | null
        } | null }
        const [pairRes, gradRes] = await Promise.all([
          db.from('language_pairs').select('goals')
            .eq('owner_id', uid).eq('source_language', src).eq('target_language', tgt).maybeSingle(),
          db.from('card_states').select('graduated_at, accelerated_mode, cards!inner(source_language, target_language)')
            .eq('user_id', uid).eq('graduated', true).neq('review_direction', 'reverse').not('graduated_at', 'is', null)
            .eq('cards.source_language', src).eq('cards.target_language', tgt)
            .gte('graduated_at', new Date(Date.now() - 72 * 3600 * 1000).toISOString()),
        ])
        const goals = pairRes.data?.goals as Record<string, number | null> | null
        const configuredForWeekday = (wd: number) => { const g = goals?.[String(wd)]; return typeof g === 'number' ? g : 0 }
        // Deferrals ("move today's load to tomorrow") shift a day's goal to the next day — thread the
        // same owed(D) through the base + planned so the cap targets the true owed amount.
        const deferrals = (profRes.data?.goal_deferrals as string[] | null) ?? []
        const owed = (d: string) => owedGoalForDate(d, configuredForWeekday, (ds) => deferrals.includes(`${src}|${tgt}|${ds}`))
        const baseGoalToday = owed(todayStr)
        let gradTodayPair = 0, gradYestPair = 0
        for (const row of gradRes.data ?? []) {
          const r = row as unknown as { graduated_at: string; accelerated_mode: string | null }
          if (!r.graduated_at) continue
          if (isAutoGraduated(r.accelerated_mode)) continue
          const d = localDateWithTurnover(r.graduated_at, tzRef.current, turnoverRef.current)
          if (d === todayStr) gradTodayPair++
          else if (d === yesterdayStr) gradYestPair++
        }
        const fullDebtOn = profRes.data?.goal_full_debt ?? false
        // This scope is a single language pair, so its own reset date (if any) is the one that counts.
        const fullDebtSince = effectiveDebtSince(
          (profRes.data?.goal_full_debt_since as string | null) ?? null,
          (profRes.data?.goal_full_debt_resets as Record<string, string> | null) ?? {},
          `${src}|${tgt}`,
        )
        // A live schedule OWNS this pair's goal, so the intake cap must follow it rather than the
        // weekday numbers + carryover. Online only, and never fatal: a missing goal_schedules table
        // (migration 114 unapplied) falls straight through to the carryover path below.
        const sched = await new SupabaseGoalScheduleRepository()
          .getForPair(uid, src, tgt).catch(() => null)

        let goalToday: number
        if (sched) {
          const done = await progressForSchedules({
            userId: uid, schedules: [sched], timezone: tzRef.current, turnoverHour: turnoverRef.current,
          }).then(m => m.get(`${src}|${tgt}`) ?? 0).catch(() => 0)
          goalToday = scheduleStatus({ schedule: sched, today: todayStr, doneSoFar: done, doneToday: gradTodayPair }).goal
        } else if (fullDebtOn && fullDebtSince) {
          // Unbounded: the whole running deficit/surplus since the enable date lands on today's goal.
          const lower = new Date(new Date(fullDebtSince + 'T00:00:00Z').getTime() - 48 * 3600 * 1000).toISOString()
          const rows = await fetchAllRows<{ graduated_at: string; accelerated_mode: string | null }>(
            (from, to) => db.from('card_states').select('graduated_at, accelerated_mode, cards!inner(source_language, target_language)')
              .eq('user_id', uid).eq('graduated', true).neq('review_direction', 'reverse').not('graduated_at', 'is', null)
              .eq('cards.source_language', src).eq('cards.target_language', tgt)
              .gte('graduated_at', lower).order('graduated_at', { ascending: true }).range(from, to),
          )
          const skipShortfallDays = (profRes.data?.full_debt_skip_shortfall_days as string[] | null) ?? []
          const skipSurplusDays   = (profRes.data?.full_debt_skip_surplus_days   as string[] | null) ?? []
          const exemptDaySet = new Set([...skipShortfallDays, ...skipSurplusDays])
          let gradsSince = 0
          const exemptDayGrads = new Map<string, number>()
          for (const row of rows) {
            const r = row as unknown as { graduated_at: string; accelerated_mode: string | null }
            if (!r.graduated_at) continue
            if (isAutoGraduated(r.accelerated_mode)) continue
            const d = localDateWithTurnover(r.graduated_at, tzRef.current, turnoverRef.current)
            if (d >= fullDebtSince && d < todayStr) {
              gradsSince++
              if (exemptDaySet.has(d)) exemptDayGrads.set(d, (exemptDayGrads.get(d) ?? 0) + 1)
            }
          }
          goalToday = fullDebtGoal({
            baseGoal: baseGoalToday,
            plannedThroughYesterday: plannedGoalSum(owed, fullDebtSince, yesterdayStr),
            gradsThroughYesterday: gradsSince,
            exemptionAdjustment: fullDebtExemptionAdjustment({
              skipShortfallDays, skipSurplusDays,
              goalForDay: owed, gradsForDay: (d) => exemptDayGrads.get(d) ?? 0,
              since: fullDebtSince, through: yesterdayStr,
            }),
          }).goal
        } else {
          // Yesterday-only carryover (the two per-day toggles).
          const yOwed = owed(yesterdayStr)
          goalToday = carriedGoal({
            baseGoal: baseGoalToday,
            yesterdayGoal: yOwed > 0 ? yOwed : null,
            yesterdayCount: gradYestPair,
            carryShortfall: profRes.data?.goal_carry_shortfall ?? false,
            carrySurplus: profRes.data?.goal_carry_surplus ?? false,
          }).goal
        }
        if (goalToday > 0) {
          // learning.length = cards already in this deck's pipeline (they'll graduate today), so front-load
          // only enough fresh cards to reach the goal — never past it.
          const budget = Math.max(0, goalToday - gradTodayPair - learning.length)
          eligibleFresh = fresh.slice(0, budget)   // first `budget` in list order, not a random sample
        }
      }

      let q: string[]
      rollingRef.current = false
      pendingFreshRef.current = []
      if (category === 'new')          q = [...fresh]
      else if (category === 'learning') {
        // "Study Learning" = every card the deck's Learning filter shows: a non-graduated forward state
        // (pristine/booted included) or a climb in progress. Not budget-capped — climb them all to grad.
        // Cards without a climb entry run from rung 0 via the initialClimbState fallback in render.
        q = allCards
          .filter(c => { const cl = climb.get(c.id); return !gradSet.has(c.id) && (pipelineStateSet.has(c.id) || (!!cl && !cl.graduated)) })
          .map(c => c.id)
      }
      else if (category === 'starred') {
        // Every non-graduated starred card — fresh or mid-climb — through the pair's CURRENT
        // ladder/pathway. (Graduated starred cards are the review session's half of the split.)
        // Not budget-capped: starring is explicit.
        q = allCards.filter(c => c.starred && !gradSet.has(c.id)).map(c => c.id)
      }
      else {
        const cap = prefs?.cardsPerSession ?? null
        if (cap != null && cap > 0) {
          if (prefs!.learningBatchMode) {
            // Batch: a fixed group of `cap`, wait for the whole batch to graduate before the next batch.
            q = learning.length > 0 ? [...learning] : eligibleFresh.slice(0, cap)
          } else {
            // Rolling: keep ≤cap in the pipeline, refill from the rest as cards graduate → work through
            // the whole set (progress is out of the full set, not a batch of `cap`).
            const all = [...learning, ...eligibleFresh]
            q = all.slice(0, cap)
            pendingFreshRef.current = all.slice(cap)
            rollingRef.current = pendingFreshRef.current.length > 0
          }
        } else {
          const newLimit = prefs ? prefsRepo.effectiveDailyLimit(prefs) : 20
          q = [...learning, ...eligibleFresh.slice(0, Math.max(0, newLimit))]
        }
      }
      const items: QueueItem[] = q.map(cardId => ({ cardId, readyAt: 0, ratedAt: 0 }))
      const ladderLen0 = Math.max(1, effLadder.rungs.length)
      startStepsRef.current = items.reduce((s, it) => s + Math.min((reconciled.get(it.cardId) as ClimbState | undefined)?.rungIndex ?? 0, ladderLen0), 0)
      progressPctRef.current = 0
      setAnswered(0)
      setQueue(items); setTotal(rollingRef.current ? items.length + pendingFreshRef.current.length : items.length)
      // Rolling mode already holds the whole set (queue + pending) → nothing more to load afterwards.
      setHasMore(rollingRef.current ? false : (eligibleFresh.length + learning.length) > items.length)

      // Stored-clip hydration for the trimmed card read (SESSION_CARD_COLUMNS). Without it,
      // LadderStudyCard's play path would treat a stored clip as missing, REGENERATE via TTS and
      // write the regenerated clip back over the stored one (its fetch-on-miss does cardRepo.update)
      // — a Forvo native recording would be permanently replaced. The first card's clip is awaited
      // (it autoplays on mount); the rest of the queue hydrates in the background.
      const applyAudioHydration = (patch: AudioPatch) => setCardsById(prev => {
        let changed = false
        const next = new Map(prev)
        for (const [id] of patch) {
          const c = next.get(id)
          if (c) { next.set(id, applyAudioPatch(c, patch)); changed = true }
        }
        return changed ? next : prev
      })
      const firstId = pickNextCard(items, Date.now())?.cardId ?? null
      const firstCard = firstId ? allCards.find(c => c.id === firstId) : undefined
      if (firstCard && needsAudioHydration(firstCard)) await hydrateSessionAudio([firstCard], applyAudioHydration)
      setCurrentId(firstId)
      setLoading(false)

      const qSet = new Set(q)
      void hydrateSessionAudio(allCards.filter(c => qSet.has(c.id) && c.id !== firstId), applyAudioHydration)
      void prefetchAudio(
        allCards.filter(c => qSet.has(c.id)).map(c => ({ card: c, sourceLanguage: c.sourceLanguage })),
        (cardId, audioData) => setCardsById(prev => {
          const c = prev.get(cardId)
          return c ? new Map(prev).set(cardId, { ...c, audioData, audioGenerated: true }) : prev
        }),
      )
      } catch (e) {
        console.error('Ladder session failed to load:', e)
        setLoadError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    })()
  }, [scope, category])

  const currentCard = currentId ? cardsById.get(currentId) : undefined
  const currentStored = currentId ? states.get(currentId) : undefined
  // Ladder derivations (null in pathway mode; the ladder branches below are gated on !isPathway).
  const currentClimb = (!isPathway && currentId) ? applyWindow((currentStored as ClimbState) ?? initialClimbState(), Date.now()) : null
  const currentRung = (!isPathway && ladder && currentClimb) ? ladder.rungs[currentClimb.rungIndex] : undefined
  // Pathway derivations (null in ladder mode).
  const currentRoute = (isPathway && currentId) ? ((currentStored as RouteState) ?? initialRouteState(pathway!)) : null
  const currentPathState = (isPathway && pathway && currentRoute) ? pathway.states.find(s => s.id === currentRoute.stateId) : undefined
  // The presentation the card renderer shows, and whether there's a card to show at all.
  const presentationRung: Rung | undefined = isPathway ? (currentPathState ? stateAsRung(currentPathState) : undefined) : currentRung
  const currentDeck = currentId ? deckFor(currentId) : undefined

  // Reset the per-card timer + pending override whenever a new card is shown.
  useEffect(() => { shownAtRef.current = Date.now(); reviewTimer.current?.restart(); pendingOverrideAddRef.current = null }, [currentId])

  // Get ahead of the curve: while IPA is on, transcribe the next few upcoming cards that don't have IPA
  // yet (cache + persist), so it's ready the instant they appear — no waiting per card.
  useEffect(() => {
    if (!ipaOn) return
    let cancelled = false
    ;(async () => {
      const ahead = queue.map(q => q.cardId).filter(id => id !== currentId).slice(0, 6)
      for (const id of ahead) {
        if (cancelled) return
        const c = cardsById.get(id)
        if (!c || c.ipa) continue
        try {
          const res = await fetch(apiUrl('/api/ipa'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: c.front, language: c.sourceLanguage }),
          })
          const d = await res.json() as { ok: boolean; ipa?: string }
          if (cancelled || !d.ok || !d.ipa) continue
          setCardsById(prev => { const cc = prev.get(id); return cc && !cc.ipa ? new Map(prev).set(id, { ...cc, ipa: d.ipa! }) : prev })
          new SupabaseCardRepository().update(id, { ipa: d.ipa }).catch(() => {})
        } catch { /* best-effort — offline / transient */ }
      }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ipaOn, currentId, queue])

  /** Star / unstar from the card's top-left corner. Writes only the flag; the ladder's own state
   *  is untouched, so starring never affects a climb. */
  async function handleToggleStar(cardId: string, next: boolean) {
    await new SupabaseCardRepository().setStarred(cardId, next)
    setCardsById(prev => {
      const c = prev.get(cardId); if (!c) return prev
      return new Map(prev).set(cardId, { ...c, starred: next })
    })
  }

  function onChoicesCached(cardId: string, choices: CardChoices) {
    setCardsById(prev => { const c = prev.get(cardId); if (!c) return prev; return new Map(prev).set(cardId, { ...c, choices }) })
  }

  /** Fetch the forward card_states row backing the ℹ modal. Undefined is a valid result — a card
   *  still climbing the ladder has no row yet, and the modal renders the un-started case fine. */
  async function loadInfoState(cardId: string) {
    setInfoState(undefined)
    if (!userId) return
    try {
      const s = await new SupabaseCardStateRepository().get(userId, cardId, 'forward')
      setInfoState(s ?? undefined)
    } catch {
      setInfoState(undefined)  // modal still opens; the badge just falls back to "not started"
    }
  }

  async function graduate(cardId: string, target: IntervalRange | null, native: IntervalRange | null) {
    if (!userId) return
    const deck = deckFor(cardId)
    const repo = new SupabaseCardStateRepository()
    const now = new Date()
    const due = (days: number) =>
      snapDueAtToStartOfDay(new Date(now.getTime() + days * DAY_MS).toISOString(), tzRef.current, turnoverRef.current)
    const base = initialCardState(userId, cardId, deck?.pipelineId ?? DEFAULT_PIPELINE_ID)
    const dorm = dormancyByCardRef.current.get(cardId)  // preserve a dormancy set before studying
    const tDays = target?.min ?? 1
    const nDays = native?.min ?? 1
    await repo.upsert({ ...base, graduated: true, graduatedAt: now.toISOString(), reps: 1, lastRating: 'good', lastReviewedAt: now.toISOString(),
      dormancyThreshold: dorm?.threshold ?? null, dormant: dorm?.dormant ?? false,
      reviewDirection: 'forward', intervalDays: tDays, scheduledIntervalDays: tDays, typedIntervalDays: tDays, dueAt: due(tDays), typedDueAt: due(tDays) })
    await repo.upsert({ ...base, graduated: true, graduatedAt: now.toISOString(), reps: 1, lastRating: 'good', lastReviewedAt: now.toISOString(),
      reviewDirection: 'reverse', intervalDays: nDays, scheduledIntervalDays: nDays, recallIntervalDays: nDays, dueAt: due(nDays), recallDueAt: due(nDays) })
  }

  // Pathway sibling of onOutcome: run the graph engine, then the same queue/graduate/reshow plumbing.
  // Error-type transitions aren't fed yet (errorTypes: []) — that plumbing is Phase 2.
  async function onOutcomePathway(outcome: RungAttemptOutcome, overridden: boolean, almost: boolean, errorTypes: ErrorType[]) {
    if (!userId || !pathway || !currentId || !currentRoute) return
    const now = Date.now()
    sessionIdRef.current = resolveSessionId(now)
    const res = stepPathway(pathway, currentRoute, { outcome: outcome as PathwayEvent['outcome'], errorTypes }, now)
    const loggedOutcome: RungAttemptOutcome = almost && outcome === 'miss' ? 'almost' : outcome
    const logDeck = deckFor(currentId)
    // Position = STATE INDEX in the pathway's state list (graduated = one past the end), so the
    // Analytics replay has real movement to animate — 0→0 on every event gave it nothing.
    const fromIdx = Math.max(0, pathway.states.findIndex(st => st.id === currentRoute.stateId))
    const toIdx = res.graduated
      ? pathway.states.length
      : Math.max(0, pathway.states.findIndex(st => st.id === res.route.stateId))
    const eventIdP = new SupabaseLadderEventRepository().log(userId, {
      sessionId: sessionIdRef.current, cardId: currentId, deckId: deckByCard.get(currentId) ?? null,
      label: cardsById.get(currentId)?.front ?? null,
      sourceLanguage: logDeck?.sourceLanguage ?? null, targetLanguage: logDeck?.targetLanguage ?? null,
      fromRung: fromIdx, toRung: toIdx, rungCount: pathway.states.length, rungType: currentPathState?.type ?? null,
      outcome: loggedOutcome, advanced: res.moved, graduated: res.graduated, overridden,
      durationMs: reviewTimer.current?.read() ?? 0,
      pathway: true,
      stateName: res.graduated ? null : (pathway.states[toIdx]?.name ?? null),
    }).catch(() => null)
    touchSession()
    const overrideAdd = pendingOverrideAddRef.current?.cardId === currentId ? pendingOverrideAddRef.current : null
    pendingOverrideAddRef.current = null
    // Graduation persists in the BACKGROUND. Awaiting it between the state updates left the
    // graduated card remounted blank for two round trips — the "flash" the user reported. Undo
    // awaits this promise before deleting card_states, so the write can't race the undo.
    const gradP = res.graduated
      ? graduate(currentId, res.route.targetInterval, res.route.nativeInterval).catch(console.error)
      : null
    setUndoStack(prev => [...prev.slice(-19), {
      cardId: currentId, prevClimb: states.get(currentId), prevQueueItem: queue.find(e => e.cardId === currentId),
      wasGraduated: res.graduated, prevAnswered: answered, eventIdP, overrideAdd, gradP,
    }])
    await new SupabaseLadderClimbRepository().save(userId, currentId, deckByCard.get(currentId) ?? '', res.route).catch(console.error)

    let nextQueue: QueueItem[]
    if (res.graduated) {
      nextQueue = queue.filter(e => e.cardId !== currentId)
      if (rollingRef.current && pendingFreshRef.current.length > 0) {
        const nextFresh = pendingFreshRef.current.shift()!
        nextQueue = [...nextQueue, { cardId: nextFresh, readyAt: 0, ratedAt: 0 }]
      }
    } else {
      const delay = res.reshowSeconds * 1000
      nextQueue = queue.map(e => e.cardId === currentId
        ? { cardId: currentId, readyAt: delay > 0 ? now + delay : 0, ratedAt: delay > 0 ? now : 0 }
        : e)
    }
    // ONE synchronous batch — React renders the next card directly, never the graduated card alone.
    if (res.graduated) setGraduated(g => g + 1)
    setStates(prev => new Map(prev).set(currentId, res.route))
    setQueue(nextQueue)
    setCurrentId(pickNextCard(nextQueue, now, currentId)?.cardId ?? null)
    setAnswered(a => a + 1)
  }

  async function onOutcome(outcome: RungAttemptOutcome, overridden = false, almost = false, errorTypes: ErrorType[] = []) {
    if (isPathway) { await onOutcomePathway(outcome, overridden, almost, errorTypes); return }
    if (!userId || !ladder || !currentId || !currentClimb) return
    const now = Date.now()
    // Attribute this review to the current session, opening a new one only if ≥ 45 min passed since the
    // last activity (measured from when studying stopped, whether or not the page was reloaded).
    sessionIdRef.current = resolveSessionId(now)
    const res = reviewRung(ladder, currentClimb, outcome, now)
    // The engine keeps the real outcome ('miss'); the LOG marks a near-miss as 'almost' for the replay
    // colour without changing drop-back behaviour.
    const loggedOutcome: RungAttemptOutcome = almost && outcome === 'miss' ? 'almost' : outcome

    // Log this rung attempt so Analytics → Logs can show session stats + a replay. Capture the id so
    // undo can delete it (undo+redo counts once).
    const rungCount = ladder.rungs.length
    const logDeck = deckFor(currentId)
    const eventIdP = new SupabaseLadderEventRepository().log(userId, {
      sessionId: sessionIdRef.current, cardId: currentId, deckId: deckByCard.get(currentId) ?? null,
      label: cardsById.get(currentId)?.front ?? null,
      sourceLanguage: logDeck?.sourceLanguage ?? null, targetLanguage: logDeck?.targetLanguage ?? null,
      fromRung: currentClimb.rungIndex, toRung: res.state.graduated ? rungCount : res.state.rungIndex, rungCount,
      rungType: ladder.rungs[currentClimb.rungIndex]?.type ?? null,
      outcome: loggedOutcome, advanced: res.advanced, graduated: res.state.graduated, overridden,
      durationMs: reviewTimer.current?.read() ?? 0,  // active time only — idle gaps > 40s excluded
    }).catch(() => null)
    touchSession()  // slide the freshness window so a refresh keeps continuing this session

    const overrideAdd = pendingOverrideAddRef.current?.cardId === currentId ? pendingOverrideAddRef.current : null
    pendingOverrideAddRef.current = null
    // Graduation persists in the BACKGROUND — see the pathway branch note. Undo awaits gradP.
    const gradP = res.state.graduated
      ? graduate(currentId, res.state.targetInterval, res.state.nativeInterval).catch(console.error)
      : null
    setUndoStack(prev => [...prev.slice(-19), {
      cardId: currentId, prevClimb: states.get(currentId), prevQueueItem: queue.find(e => e.cardId === currentId),
      wasGraduated: res.state.graduated, prevAnswered: answered, eventIdP, overrideAdd, gradP,
    }])
    await new SupabaseLadderClimbRepository().save(userId, currentId, deckByCard.get(currentId) ?? '', res.state).catch(console.error)

    let nextQueue: QueueItem[]
    if (res.state.graduated) {
      nextQueue = queue.filter(e => e.cardId !== currentId)
      // Rolling pipeline: as this card graduates, pull in the next fresh card so the pipeline stays full
      // (≤ cap) and we keep flowing through the whole set instead of stopping at a batch of `cap`.
      if (rollingRef.current && pendingFreshRef.current.length > 0) {
        const nextFresh = pendingFreshRef.current.shift()!
        nextQueue = [...nextQueue, { cardId: nextFresh, readyAt: 0, ratedAt: 0 }]
      }
    } else {
      const rung = ladder.rungs[currentClimb.rungIndex]!
      const delay = rungReshowMs(rung, res, ladder.betweenRungWaitSeconds ?? 180)
      nextQueue = queue.map(e => e.cardId === currentId
        ? { cardId: currentId, readyAt: delay > 0 ? now + delay : 0, ratedAt: delay > 0 ? now : 0 }
        : e)
    }
    // ONE synchronous batch — React renders the next card directly, never the graduated card alone.
    // No pauses: the session runs until the group graduates (whole deck, or the deck-settings batch).
    if (res.state.graduated) setGraduated(g => g + 1)
    setStates(prev => new Map(prev).set(currentId, res.state))
    setQueue(nextQueue)
    setCurrentId(pickNextCard(nextQueue, now, currentId)?.cardId ?? null)
    setAnswered(a => a + 1)
  }

  const handleUndo = useCallback(async () => {
    const entry = undoStack[undoStack.length - 1]
    if (!entry || !userId) return
    setUndoStack(prev => prev.slice(0, -1))
    const { cardId, prevClimb, prevQueueItem, wasGraduated, prevAnswered, eventIdP, overrideAdd, gradP } = entry
    const fallbackItem: QueueItem = prevQueueItem ?? { cardId, readyAt: 0, ratedAt: 0 }
    // Delete the logged attempt (so undo+redo is one attempt) and roll back a just-added override.
    if (eventIdP) eventIdP.then(id => { if (id) new SupabaseLadderEventRepository().deleteById(id).catch(() => {}) })
    if (overrideAdd) handleOverrideAnswer(overrideAdd.cardId, overrideAdd.answerSide, overrideAdd.answerText, false)
    const climbRepo = new SupabaseLadderClimbRepository()
    if (prevClimb) {
      await climbRepo.save(userId, cardId, deckByCard.get(cardId) ?? '', prevClimb).catch(console.error)
      setStates(prev => new Map(prev).set(cardId, prevClimb))
    } else {
      await climbRepo.remove(userId, cardId).catch(console.error)
      setStates(prev => { const m = new Map(prev); m.delete(cardId); return m })
    }
    if (wasGraduated) {
      // The graduation upserts run in the background; deleting before they land would let them
      // re-create the rows we just deleted. Wait for the write, then remove it.
      if (gradP) await gradP
      const stateRepo = new SupabaseCardStateRepository()
      await stateRepo.delete(userId, cardId, 'forward').catch(() => {})
      await stateRepo.delete(userId, cardId, 'reverse').catch(() => {})
      setGraduated(g => Math.max(0, g - 1))
      setQueue(prev => prev.some(e => e.cardId === cardId) ? prev : [...prev, fallbackItem])
    } else {
      setQueue(prev => prev.map(e => e.cardId === cardId ? fallbackItem : e))
    }
    setAnswered(prevAnswered)
    setCurrentId(cardId)
  }, [undoStack, userId, deckByCard, handleOverrideAnswer])

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

  if (loadError) return (
    <div className="pt-16 text-center space-y-3">
      <p className="text-sm text-danger">Couldn&apos;t start this session.</p>
      <p className="text-xs text-ink-faint max-w-md mx-auto">{loadError}</p>
      <button className="btn-primary px-6" onClick={() => window.location.reload()}>Try again</button>
    </div>
  )
  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading session…</div>
  if (decksById.size === 0 || !ladder) return <p className="p-6 text-sm text-danger">Nothing to study here.</p>

  if (!currentCard || !presentationRung || !currentDeck || (isPathway ? !currentRoute : !currentClimb)) {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-6">
        <h1 className="text-xl font-semibold text-ink">Session complete</h1>
        <p className="text-ink-muted">{graduated > 0 ? `Graduated ${graduated} card${graduated === 1 ? '' : 's'}.` : 'Nothing to learn right now.'}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <a href={back} className="btn-ghost">Back</a>
          {hasMore && <button onClick={() => window.location.reload()} className="btn-primary">Continue</button>}
        </div>
      </div>
    )
  }

  // Progress: only a LADDER has a fixed length, so only a ladder gets a progress bar. A pathway can
  // branch backwards indefinitely — any percentage would be a guess dressed up as a measurement, and
  // a bar that stalls or slides is worse than no bar. The graduated COUNT is still shown either way,
  // since that's a fact rather than a projection.
  const ladderLen = Math.max(1, isPathway ? 1 : ladder.rungs.length)
  const stepsDone = graduated * ladderLen + queue.reduce((sum, e) => sum + Math.min((states.get(e.cardId) as ClimbState | undefined)?.rungIndex ?? 0, ladderLen), 0)
  const totalSteps = total * ladderLen
  const remaining = Math.max(1, totalSteps - startStepsRef.current)
  const rawPct = ((stepsDone - startStepsRef.current) / remaining) * 100
  progressPctRef.current = Math.max(progressPctRef.current, Math.max(0, rawPct))
  const pct = Math.round(progressPctRef.current)

  // Distractors come from the current card's own deck.
  const curDeckCards = [...cardsById.values()].filter(c => deckByCard.get(c.id) === currentDeck.id)

  return (
    // Full width of the layout's `main`, which shares the navbar's `max-w-5xl mx-auto px-4` — so the
    // progress bar lines up exactly with the logo on the left and the avatar on the right.
    <div className="space-y-8 w-full">
      <div className="relative flex items-center justify-between">
        <a href={back} className="text-base text-ink-muted hover:text-ink">✕ End session</a>
        <div className="absolute left-1/2 -translate-x-1/2 text-sm text-ink-muted">
          {isPathway ? `${graduated}/${total} graduated` : `${pct}% · ${graduated}/${total} graduated`}
        </div>
        <div className="text-sm text-ink-muted">
          {isPathway ? `${currentPathState!.name} · ${RUNG_LABEL[presentationRung.type]}` : `Rung ${currentClimb!.rungIndex + 1} · ${RUNG_LABEL[presentationRung.type]}`}
        </div>
      </div>
      {!isPathway && (
        <div className="h-1.5 bg-surface-raised rounded-full overflow-hidden">
          <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
      {category && (
        <p className="text-xs text-accent text-center">
          {category === 'new' ? 'Studying unlearned cards.' : category === 'starred' ? 'Studying your starred cards.' : 'Studying cards still in the learning pipeline.'}
        </p>
      )}

      <LadderStudyCard
        key={isPathway ? `${currentId}:${currentRoute!.stateId}` : `${currentId}:${currentClimb!.rungIndex}`}
        card={currentCard} rung={presentationRung} deckCards={curDeckCards} deckName={currentDeck.name}
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
        onOutcome={onOutcome} onChoicesCached={onChoicesCached} onInfo={() => { setInfoOpen(true); void loadInfoState(currentCard.id) }}
        onToggleStar={next => handleToggleStar(currentCard.id, next)}
        ipaOn={ipaOn} onToggleIpa={() => setIpaOn(v => !v)}
        onIpaFetched={(id, ipa) => setCardsById(prev => { const c = prev.get(id); return c ? new Map(prev).set(id, { ...c, ipa }) : prev })}
      />

      <UndoFab show={undoStack.length > 0} onUndo={() => void handleUndo()} />

      {infoOpen && userId && (
        <CardEditModal
          card={currentCard} state={infoState} userId={userId} deckId={currentDeck.id}
          deckCards={curDeckCards} sourceLanguage={currentDeck.sourceLanguage} targetLanguage={currentDeck.targetLanguage}
          onSave={async (id, front, back) => {
            await new SupabaseCardRepository().update(id, { front, back })
            setCardsById(prev => { const c = prev.get(id); return c ? new Map(prev).set(id, { ...c, front, back }) : prev })
          }}
          onCardChange={c => setCardsById(prev => new Map(prev).set(c.id, c))}
          onStateChange={s => setInfoState(s)}
          onDelete={cid => { setCardsById(prev => { const m = new Map(prev); m.delete(cid); return m }); setQueue(q => q.filter(x => x.cardId !== cid)); if (currentId === cid) setCurrentId(pickNextCard(queue.filter(x => x.cardId !== cid), Date.now())?.cardId ?? null); setInfoOpen(false) }}
          onClose={() => setInfoOpen(false)}
          initialShowStats
        />
      )}
    </div>
  )
}
