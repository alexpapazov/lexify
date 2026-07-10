'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { SupabaseLadderRepository } from '@/lib/data/ladders'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { resolveEffectiveLadder } from '@/lib/ladder'
import { reviewRung, applyWindow, initialClimbState, type ClimbState, type RungAttemptOutcome, type IntervalRange } from '@/engine/ladderEngine'
import { initialCardState } from '@/engine/pipeline'
import { LadderStudyCard } from '@/components/ladder/LadderStudyCard'
import type { Card, CardChoices, Deck, Ladder } from '@/domain'

const DAY_MS = 86_400_000

export default function LadderStudyPage() {
  const { deckId } = useParams<{ deckId: string }>()
  const [userId, setUserId] = useState<string | null>(null)
  const [deck, setDeck] = useState<Deck | null>(null)
  const [ladder, setLadder] = useState<Ladder | null>(null)
  const [cardsById, setCardsById] = useState<Map<string, Card>>(new Map())
  const [queue, setQueue] = useState<string[]>([])
  const [states, setStates] = useState<Map<string, ClimbState>>(new Map())
  const [graduated, setGraduated] = useState(0)
  const [loading, setLoading] = useState(true)

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
      const ladderRepo = new SupabaseLadderRepository()
      const [pair, def] = await Promise.all([ladderRepo.getForPair(uid, d.sourceLanguage, d.targetLanguage), ladderRepo.getDefault(uid)])
      setLadder(resolveEffectiveLadder(pair, def))

      // Cards already graduated (old pipeline OR ladder) are in long-term review — skip them.
      const cardStates = await new SupabaseCardStateRepository().listByDeck(uid, deckId)
      const gradSet = new Set(cardStates.filter(s => s.reviewDirection !== 'reverse' && s.graduated).map(s => s.cardId))
      const climb = await new SupabaseLadderClimbRepository().listForCards(uid, cards.map(c => c.id))
      setStates(climb)

      // Intake: in-progress ladder cards + new cards up to the deck's daily limit.
      const prefsRepo = new SupabaseDeckPreferencesRepository()
      const prefs = await prefsRepo.get(uid, deckId)
      const newLimit = prefs ? prefsRepo.effectiveDailyLimit(prefs) : 20
      const learning: string[] = []
      const fresh: string[] = []
      for (const c of cards) {
        if (gradSet.has(c.id) || climb.get(c.id)?.graduated) continue
        (climb.has(c.id) ? learning : fresh).push(c.id)
      }
      const shuffle = <T,>(a: T[]) => a.sort(() => Math.random() - 0.5)
      setQueue([...shuffle(learning), ...shuffle(fresh).slice(0, Math.max(0, newLimit))])
      setLoading(false)
    })()
  }, [deckId])

  const currentId = queue[0]
  const currentCard = currentId ? cardsById.get(currentId) : undefined
  const currentClimb = currentId ? applyWindow(states.get(currentId) ?? initialClimbState(), Date.now()) : null
  const currentRung = ladder && currentClimb ? ladder.rungs[currentClimb.rungIndex] : undefined

  function onChoicesCached(cardId: string, choices: CardChoices) {
    setCardsById(prev => { const c = prev.get(cardId); if (!c) return prev; return new Map(prev).set(cardId, { ...c, choices }) })
  }

  // Writes the two graduated review states (forward + reverse) so the card enters Due Now.
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
    const res = reviewRung(ladder, currentClimb, outcome, Date.now())
    await new SupabaseLadderClimbRepository().save(userId, currentId, deckId, res.state).catch(console.error)
    setStates(prev => new Map(prev).set(currentId, res.state))
    if (res.state.graduated) { await graduate(currentId, res.state.targetInterval, res.state.nativeInterval); setGraduated(g => g + 1) }
    setQueue(prev => {
      const rest = prev.slice(1)
      if (res.state.graduated) return rest
      const at = Math.min(3, rest.length)
      return [...rest.slice(0, at), currentId, ...rest.slice(at)]
    })
  }

  if (loading) return <p className="p-6 text-sm text-ink-faint">Loading…</p>
  if (!deck || !ladder) return <p className="p-6 text-sm text-danger">Deck not found.</p>

  if (!currentCard || !currentRung || !currentClimb) {
    return (
      <div className="max-w-lg mx-auto p-6 text-center space-y-3">
        <h1 className="text-xl font-semibold text-ink">Learning complete — {deck.name}</h1>
        <p className="text-ink-muted">{graduated > 0 ? `Graduated ${graduated} card${graduated === 1 ? '' : 's'}.` : 'Nothing to learn right now.'}</p>
        <div className="flex justify-center gap-3">
          <a href={`/study/${deckId}/session?category=due`} className="btn-primary">Review due cards</a>
          <a href={`/study/${deckId}`} className="btn-ghost">Back to deck</a>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto p-6 space-y-5">
      <div className="flex items-center justify-between text-xs text-ink-faint">
        <a href={`/study/${deckId}`} className="hover:text-ink">✕ End</a>
        <span>Rung {currentClimb.rungIndex + 1} of {ladder.rungs.length}</span>
        <span>{graduated} graduated</span>
      </div>
      <LadderStudyCard
        key={`${currentId}:${currentClimb.rungIndex}`}
        card={currentCard} rung={currentRung} deckCards={[...cardsById.values()]} deckName={deck.name}
        sourceLanguage={deck.sourceLanguage} targetLanguage={deck.targetLanguage} gradingSettings={deck.gradingSettings}
        onOutcome={onOutcome} onChoicesCached={onChoicesCached}
      />
    </div>
  )
}
