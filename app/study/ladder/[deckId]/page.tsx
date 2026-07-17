'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
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
import { pickNextCard, reshowDelayMs, type QueueItem } from '@/lib/ladderSession'
import { prefetchAudio } from '@/lib/distractors'
import { initialCardState } from '@/engine/pipeline'
import { LadderStudyCard } from '@/components/ladder/LadderStudyCard'
import { CardEditModal } from '@/components/CardEditModal'
import type { Card, CardChoices, Deck, Ladder, RungType } from '@/domain'

const DAY_MS = 86_400_000
const RUNG_LABEL: Record<RungType, string> = { mcq: 'multiple choice', typing: 'typing', self_graded: 'self-graded', dictation: 'dictation' }

function LadderStudyInner() {
  const { deckId } = useParams<{ deckId: string }>()
  const category = useSearchParams().get('category') // 'new' | 'learning' | null
  const [userId, setUserId] = useState<string | null>(null)
  const [deck, setDeck] = useState<Deck | null>(null)
  const [ladder, setLadder] = useState<Ladder | null>(null)
  const [cardsById, setCardsById] = useState<Map<string, Card>>(new Map())
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [states, setStates] = useState<Map<string, ClimbState>>(new Map())
  const [graduated, setGraduated] = useState(0)
  const [answered, setAnswered] = useState(0)    // questions answered this batch (drives round checkpoints)
  const [paused, setPaused] = useState(false)    // showing the "round complete — continue?" checkpoint
  const [hasMore, setHasMore] = useState(false)  // more cards to learn beyond this batch
  const progressPctRef = useRef(0)               // monotonic progress % (never regresses on drop-back)
  const startStepsRef  = useRef(0)               // rung-steps already done when the session started (baseline)
  const [loading, setLoading] = useState(true)
  const [infoOpen, setInfoOpen] = useState(false)
  const [overrides, setOverrides] = useState<Map<string, Set<string>>>(new Map())

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

  // Edit a multiple-choice option in place (empty newText deletes a distractor).
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
      const d = await new SupabaseDeckRepository().get(deckId)
      if (!d) { setLoading(false); return }
      setDeck(d)
      const cards = await new SupabaseCardRepository().listByDeck(deckId)
      setCardsById(new Map(cards.map(c => [c.id, c])))

      // Persisted typed-answer overrides (so the pipeline honours answers you've marked OK).
      const overrideRows = await new SupabaseTypedAnswerOverrideRepository().listForUser(uid)
      const overrideMap = new Map<string, Set<string>>()
      for (const o of overrideRows) {
        const key = `${o.cardId}:${o.answerSide}`
        const set = overrideMap.get(key) ?? new Set<string>()
        set.add(o.answerText)
        overrideMap.set(key, set)
      }
      setOverrides(overrideMap)
      const ladderRepo = new SupabaseLadderRepository()
      const [pair, def] = await Promise.all([ladderRepo.getForPair(uid, d.sourceLanguage, d.targetLanguage), ladderRepo.getDefault(uid)])
      const effLadder = resolveEffectiveLadder(pair, def)
      setLadder(effLadder)

      const cardStates = await new SupabaseCardStateRepository().listByDeck(uid, deckId)
      const gradSet = new Set(cardStates.filter(s => s.reviewDirection !== 'reverse' && s.graduated).map(s => s.cardId))
      // Cards already IN the pipeline via a card_state (booted back from Due Now, or a legacy learner)
      // but WITHOUT a climb row. They are "Learning" — they belong in the pipeline at the initial rung,
      // NOT treated as fresh new cards (otherwise the batch cap ignores them and over-fills the pipeline).
      const learningStateSet = new Set(cardStates.filter(s => s.reviewDirection !== 'reverse' && !s.graduated).map(s => s.cardId))
      const climb = await new SupabaseLadderClimbRepository().listForCards(uid, cards.map(c => c.id))

      const shuffle = <T,>(a: T[]) => a.sort(() => Math.random() - 0.5)
      const learning: string[] = []  // already in the pipeline (climbing, or a state-learner at rung 1)
      const fresh: string[] = []      // never started
      const reconciled = new Map(climb)
      for (const c of cards) {
        if (gradSet.has(c.id)) continue                        // truly graduated → not in learning
        const cl = climb.get(c.id)
        if (cl && !cl.graduated) { learning.push(c.id); continue }   // mid-climb → resume where it is
        // No active climb (none, or a stale "graduated" one). A card_state learner starts the ladder at
        // its initial rung and counts as learning; a stale climb is reset; a truly fresh card stays fresh.
        const alreadyLearning = learningStateSet.has(c.id)
        if (cl || alreadyLearning) reconciled.set(c.id, initialClimbState())
        ;(alreadyLearning ? learning : fresh).push(c.id)
      }
      setStates(reconciled)

      const prefsRepo = new SupabaseDeckPreferencesRepository()
      const prefs = await prefsRepo.get(uid, deckId)
      setAudioPlaybackRate(prefs?.audioSpeed ?? 1)
      setAudioVolume(prefs?.audioVolume ?? 1)
      const audioPref = await createClient().from('profiles').select('audio_source_default, audio_source_by_language').eq('user_id', uid).single()
      setAudioSourceDefault(audioPref.data?.audio_source_default as string | null)
      setAudioSourceByLanguage(audioPref.data?.audio_source_by_language as Record<string, string> | null)

      let q: string[]
      if (category === 'new')          q = shuffle(fresh)
      else if (category === 'learning') q = shuffle(learning)
      else {
        // Normal intake: apply the deck's card-intake settings.
        const cap = prefs?.cardsPerSession ?? null  // "Limit cards in learning" → the cap
        if (cap != null && cap > 0) {
          if (prefs!.learningBatchMode) {
            // "Wait for full batch to graduate": strict groups — the current group must
            // ALL graduate before a fresh group of `cap` is introduced.
            q = learning.length > 0 ? shuffle(learning) : shuffle(fresh).slice(0, cap)
          } else {
            // Top-up: keep up to `cap` different cards in the pipeline, refilling as
            // cards graduate (in-progress first, then fresh to reach the cap).
            q = [...shuffle(learning), ...shuffle(fresh)].slice(0, cap)
          }
        } else {
          const newLimit = prefs ? prefsRepo.effectiveDailyLimit(prefs) : 20
          q = [...shuffle(learning), ...shuffle(fresh).slice(0, Math.max(0, newLimit))]
        }
      }
      const items: QueueItem[] = q.map(cardId => ({ cardId, readyAt: 0, ratedAt: 0 }))
      // Baseline: rung-steps already completed by resumed cards, so the bar measures progress made
      // THIS session (starts at 0%) rather than counting cards that resumed partway up the ladder.
      const ladderLen0 = Math.max(1, effLadder.rungs.length)
      startStepsRef.current = items.reduce((s, it) => s + Math.min(reconciled.get(it.cardId)?.rungIndex ?? 0, ladderLen0), 0)
      progressPctRef.current = 0
      setAnswered(0); setPaused(false)
      setQueue(items); setTotal(items.length)
      setHasMore((fresh.length + learning.length) > items.length)  // cards left over beyond this batch
      setCurrentId(pickNextCard(items, Date.now())?.cardId ?? null)
      setLoading(false)

      // Generate/cache audio for the queued cards (Forvo-preferred if the setting is on).
      const qSet = new Set(q)
      void prefetchAudio(
        cards.filter(c => qSet.has(c.id)).map(c => ({ card: c, sourceLanguage: c.sourceLanguage })),
        (cardId, audioData) => setCardsById(prev => {
          const c = prev.get(cardId)
          return c ? new Map(prev).set(cardId, { ...c, audioData, audioGenerated: true }) : prev
        }),
      )
    })()
  }, [deckId, category])

  const currentCard = currentId ? cardsById.get(currentId) : undefined
  const currentClimb = currentId ? applyWindow(states.get(currentId) ?? initialClimbState(), Date.now()) : null
  const currentRung = ladder && currentClimb ? ladder.rungs[currentClimb.rungIndex] : undefined

  function onChoicesCached(cardId: string, choices: CardChoices) {
    setCardsById(prev => { const c = prev.get(cardId); if (!c) return prev; return new Map(prev).set(cardId, { ...c, choices }) })
  }

  async function graduate(cardId: string, target: IntervalRange | null, native: IntervalRange | null) {
    if (!userId || !deck) return
    const repo = new SupabaseCardStateRepository()
    const now = new Date()
    const due = (days: number) => new Date(now.getTime() + days * DAY_MS).toISOString()
    const base = initialCardState(userId, cardId, deck.pipelineId)
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
    await new SupabaseLadderClimbRepository().save(userId, currentId, deckId, res.state).catch(console.error)
    setStates(prev => new Map(prev).set(currentId, res.state))

    let nextQueue: QueueItem[]
    if (res.state.graduated) {
      await graduate(currentId, res.state.targetInterval, res.state.nativeInterval)
      setGraduated(g => g + 1)
      nextQueue = queue.filter(e => e.cardId !== currentId)
    } else {
      // Hold the card until its Again/Hard/Good window is (nearly) up; 0 = show freely.
      // Advancing a rung uses this ladder's configurable between-rung wait.
      const delay = res.reshow === 'advanced'
        ? (ladder.betweenRungWaitSeconds ?? 180) * 1000
        : reshowDelayMs(res.reshow)
      nextQueue = queue.map(e => e.cardId === currentId
        ? { cardId: currentId, readyAt: delay > 0 ? now + delay : 0, ratedAt: delay > 0 ? now : 0 }
        : e)
    }
    setQueue(nextQueue)
    const nextId = pickNextCard(nextQueue, now, currentId)?.cardId ?? null
    setCurrentId(nextId)

    // Round checkpoint: after every `total` answered questions (the batch size), pause and
    // offer a continue-next-round screen — but only if cards still remain (else the normal
    // "Session complete" screen takes over).
    const nextAnswered = answered + 1
    setAnswered(nextAnswered)
    if (nextId && total > 0 && nextAnswered % total === 0) setPaused(true)
  }

  // Repeat: don't advance or redo in place — re-queue the current card at the same rung
  // and move on. Held for the ladder's between-rung wait (same 3-min-default timer) so it
  // spaces out rather than reappearing right away.
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

  if (loading) return <p className="p-6 text-sm text-ink-faint">Loading…</p>
  if (!deck || !ladder) return <p className="p-6 text-sm text-danger">Deck not found.</p>

  if (!currentCard || !currentRung || !currentClimb) {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-6">
        <h1 className="text-xl font-semibold text-ink">Session complete</h1>
        <p className="text-ink-muted">{graduated > 0 ? `Graduated ${graduated} card${graduated === 1 ? '' : 's'}.` : 'Nothing to learn right now.'}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <a href={`/study/${deckId}`} className="btn-ghost">Back to deck</a>
          {hasMore && (
            <button onClick={() => window.location.reload()} className="btn-primary">Continue</button>
          )}
        </div>
      </div>
    )
  }

  // Round checkpoint — a breather every `total` answered questions, resuming the same batch.
  if (paused) {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-6">
        <h1 className="text-xl font-semibold text-ink">Round complete</h1>
        <p className="text-ink-muted">{graduated}/{total} card{total === 1 ? '' : 's'} graduated so far. Keep going?</p>
        <div className="flex flex-wrap justify-center gap-3">
          <a href={`/study/${deckId}`} className="btn-ghost">Back to deck</a>
          <button onClick={() => setPaused(false)} className="btn-primary">Continue</button>
        </div>
      </div>
    )
  }

      // Progress = fraction of the rung-steps REMAINING at session start that are now done — so the
      // bar starts at 0% (not counting cards that resumed partway up) and hits 100% when all graduate.
      // Monotonic so a drop-back never walks it backwards.
      const ladderLen = Math.max(1, ladder.rungs.length)
      const stepsDone = graduated * ladderLen + queue.reduce((sum, e) => sum + Math.min(states.get(e.cardId)?.rungIndex ?? 0, ladderLen), 0)
      const totalSteps = total * ladderLen
      const remaining = Math.max(1, totalSteps - startStepsRef.current)
      const rawPct = ((stepsDone - startStepsRef.current) / remaining) * 100
      progressPctRef.current = Math.max(progressPctRef.current, Math.max(0, rawPct))
      const pct = Math.round(progressPctRef.current)
      return (
    <div className="space-y-8 max-w-2xl mx-auto">
      <div className="relative flex items-center justify-between">
        <a href={`/study/${deckId}`} className="text-sm text-ink-muted hover:text-ink">✕ End session</a>
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

      <LadderStudyCard
        key={`${currentId}:${currentClimb.rungIndex}`}
        card={currentCard} rung={currentRung} deckCards={[...cardsById.values()]} deckName={deck.name}
        sourceLanguage={deck.sourceLanguage} targetLanguage={deck.targetLanguage} gradingSettings={deck.gradingSettings}
        overrides={overrides} onOverrideAnswer={handleOverrideAnswer} onChoiceEdit={handleChoiceEdit}
        onCardEdit={async (id, side, newText) => {
          const cardRepo = new SupabaseCardRepository()
          const existing = cardsById.get(id)
          if (!existing) return
          if (!newText) {   // blank → delete the card
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
          card={currentCard} state={undefined} userId={userId} deckId={deckId}
          deckCards={[...cardsById.values()]} sourceLanguage={deck.sourceLanguage} targetLanguage={deck.targetLanguage}
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

export default function LadderStudyPage() {
  return <Suspense fallback={<p className="p-6 text-sm text-ink-faint">Loading…</p>}><LadderStudyInner /></Suspense>
}
