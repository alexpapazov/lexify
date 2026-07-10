'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseLadderRepository } from '@/lib/data/ladders'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { resolveEffectiveLadder } from '@/lib/ladder'
import { reviewRung, applyWindow, initialClimbState, type ClimbState, type RungAttemptOutcome } from '@/engine/ladderEngine'
import { LadderExercise } from '@/components/ladder/LadderExercise'
import type { Card, Deck, Ladder } from '@/domain'

export default function LadderPracticePage() {
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
      const climb = await new SupabaseLadderClimbRepository().listForCards(uid, cards.map(c => c.id))
      setStates(climb)
      // Queue = cards not yet graduated, shuffled.
      const q = cards.filter(c => !climb.get(c.id)?.graduated).map(c => c.id).sort(() => Math.random() - 0.5)
      setQueue(q)
      setLoading(false)
    })()
  }, [deckId])

  const currentId = queue[0]
  const currentCard = currentId ? cardsById.get(currentId) : undefined
  const currentClimb = currentId ? applyWindow(states.get(currentId) ?? initialClimbState(), Date.now()) : null
  const currentRung = ladder && currentClimb ? ladder.rungs[currentClimb.rungIndex] : undefined

  async function onOutcome(outcome: RungAttemptOutcome) {
    if (!userId || !ladder || !currentId || !currentClimb) return
    const res = reviewRung(ladder, currentClimb, outcome, Date.now())
    await new SupabaseLadderClimbRepository().save(userId, currentId, deckId, res.state).catch(console.error)
    setStates(prev => new Map(prev).set(currentId, res.state))
    setQueue(prev => {
      const rest = prev.slice(1)
      if (res.state.graduated) { setGraduated(g => g + 1); return rest }
      const at = Math.min(3, rest.length)     // rotate this card back into the deck
      return [...rest.slice(0, at), currentId, ...rest.slice(at)]
    })
  }

  if (loading) return <p className="p-6 text-sm text-ink-faint">Loading…</p>
  if (!deck || !ladder) return <p className="p-6 text-sm text-danger">Deck not found.</p>

  if (!currentCard || !currentRung || !currentClimb) {
    return (
      <div className="max-w-lg mx-auto p-6 text-center space-y-3">
        <h1 className="text-xl font-semibold text-ink">Ladder practice — {deck.name}</h1>
        <p className="text-ink-muted">All caught up. {graduated > 0 && `Graduated ${graduated} card${graduated === 1 ? '' : 's'} this session.`}</p>
        <a href={`/study/${deckId}`} className="btn-ghost inline-block">Back to deck</a>
      </div>
    )
  }

  const g = currentClimb.targetInterval && currentClimb.nativeInterval
  return (
    <div className="max-w-lg mx-auto p-6 space-y-5">
      <div className="flex items-center justify-between text-xs text-ink-faint">
        <a href={`/study/${deckId}`} className="hover:text-ink">✕ End</a>
        <span>Rung {currentClimb.rungIndex + 1} of {ladder.rungs.length}</span>
        <span>{graduated} graduated</span>
      </div>
      <p className="text-center text-xs text-ink-faint uppercase tracking-wider">{deck.name}</p>

      <LadderExercise
        key={`${currentId}:${currentClimb.rungIndex}`}
        card={currentCard} rung={currentRung} deckCards={[...cardsById.values()]} onOutcome={onOutcome}
      />

      {g && <p className="text-xs text-ink-faint text-center">Once graduated: target {currentClimb.targetInterval!.min}–{currentClimb.targetInterval!.max}d · native {currentClimb.nativeInterval!.min}–{currentClimb.nativeInterval!.max}d</p>}
    </div>
  )
}
