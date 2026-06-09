'use client'

/**
 * Cross-deck study session — pulls due cards from ALL decks.
 * Same engine as the per-deck session, just a different queue-builder.
 */

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }        from '@/lib/data/decks'
import { SupabaseCardRepository }        from '@/lib/data/cards'
import { SupabaseCardStateRepository }   from '@/lib/data/cardStates'
import { SupabaseReviewEventRepository } from '@/lib/data/reviewEvents'
import { SupabasePipelineRepository }    from '@/lib/data/pipelines'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { progressAfterReview, initialCardState, ratingToWasCorrect } from '@/engine/pipeline'
import { gradeTyping } from '@/engine/grading'
import type { Card, CardState, Pipeline, Rating, GradingSettings, Deck } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'

interface SessionCard {
  card:            Card
  state:           CardState
  pipeline:        Pipeline
  gradingSettings: GradingSettings
  deckName:        string
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

// Reuse the same FlashcardMode and TypingMode as per-deck session
// (duplicated here to keep files self-contained — will extract to shared component later)

function RatingButtons({ onRate }: { onRate: (r: Rating) => void }) {
  const buttons: { rating: Rating; label: string; color: string }[] = [
    { rating: 'again', label: 'Again', color: 'border-danger/60 text-danger hover:bg-danger/10'       },
    { rating: 'hard',  label: 'Hard',  color: 'border-warning/60 text-warning hover:bg-warning/10'    },
    { rating: 'good',  label: 'Good',  color: 'border-success/60 text-success hover:bg-success/10'    },
    { rating: 'easy',  label: 'Easy',  color: 'border-accent/60 text-accent-soft hover:bg-accent/10'  },
  ]
  return (
    <div className="flex gap-3 justify-center">
      {buttons.map(({ rating, label, color }) => (
        <button key={rating} onClick={() => onRate(rating)}
          className={`border rounded-lg px-5 py-2 text-sm font-medium transition-colors ${color}`}>
          {label}
        </button>
      ))}
    </div>
  )
}

function FlashcardMode({ card, promptSide, deckName, onRate }: {
  card: Card; promptSide: 'front' | 'back'; deckName: string; onRate: (r: Rating) => void
}) {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => setRevealed(false), [card.id])
  const prompt = promptSide === 'front' ? card.front : card.back
  const answer = promptSide === 'front' ? card.back  : card.front
  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>
      <div className="panel min-h-[160px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{prompt}</p>
      </div>
      {!revealed ? (
        <div className="flex flex-col items-center gap-3">
          <button onClick={() => setRevealed(true)} className="btn-primary px-10">Show answer</button>
          <button onClick={() => onRate('again')} className="text-xs text-ink-faint hover:text-ink-muted">Don&apos;t know</button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="panel min-h-[100px] flex items-center justify-center text-center bg-surface-raised">
            <p className="text-xl text-ink">{answer}</p>
          </div>
          <RatingButtons onRate={onRate} />
        </div>
      )}
    </div>
  )
}

function TypingMode({ card, promptSide, gradingSettings, deckName, onRate }: {
  card: Card; promptSide: 'front' | 'back'; gradingSettings: GradingSettings; deckName: string
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string) => void
}) {
  const [input,  setInput]  = useState('')
  const [result, setResult] = useState<{ correct: boolean; expected: string } | null>(null)
  useEffect(() => { setInput(''); setResult(null) }, [card.id])
  const prompt   = promptSide === 'front' ? card.front : card.back
  const expected = promptSide === 'front' ? card.back  : card.front
  function check() { setResult({ correct: gradeTyping(input, expected, gradingSettings).correct, expected }) }
  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>
      <div className="panel min-h-[120px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{prompt}</p>
      </div>
      <div className="space-y-3">
        <input className={`input text-center text-lg font-mono ${result ? result.correct ? 'border-success/60 bg-success/5' : 'border-danger/60 bg-danger/5' : ''}`}
          placeholder="Type your answer…" value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !result) check() }} disabled={!!result} autoFocus />
        {!result ? (
          <div className="flex gap-3 justify-center">
            <button onClick={check} disabled={!input.trim()} className="btn-primary">Check</button>
            <button onClick={() => { setResult({ correct: false, expected }); setInput('') }} className="text-xs text-ink-faint hover:text-ink-muted pt-2">Don&apos;t know</button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className={`panel text-center py-3 ${result.correct ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}`}>
              {result.correct ? <p className="text-success font-medium">Correct!</p> : (
                <div className="space-y-1">
                  <p className="text-danger font-medium">Not quite</p>
                  <p className="text-ink-muted text-sm">Answer: <span className="text-ink font-mono">{result.expected}</span></p>
                </div>
              )}
            </div>
            <RatingButtons onRate={r => onRate(r, result.correct, input)} />
          </div>
        )}
      </div>
    </div>
  )
}

export default function AllDueSessionPage() {
  const router   = useRouter()
  const supabase = createClient()
  const [queue,   setQueue]   = useState<SessionCard[]>([])
  const [index,   setIndex]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [userId,  setUserId]  = useState('')
  const [done,    setDone]    = useState(false)

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

      const [decks, pipeline] = await Promise.all([
        deckRepo.list(session.user.id),
        pipelineRepo.getDefault(),
      ])

      const now   = new Date()
      const today = now.toISOString().slice(0, 10)
      const allCards: SessionCard[] = []

      for (const deck of decks) {
        const [cards, states, prefs] = await Promise.all([
          cardRepo.listByDeck(deck.id),
          stateRepo.listByDeck(session.user.id, deck.id),
          prefRepo.get(session.user.id, deck.id),
        ])

        const stateMap   = new Map(states.map(s => [s.cardId, s]))
        const dailyLimit = Math.min(
          prefs ? prefRepo.effectiveDailyLimit(prefs) : DEFAULT_DAILY_NEW_CARDS,
          cards.length,
        )
        const introducedToday = states.filter(s => s.introducedDate === today).length
        let newCardBudget = Math.max(0, dailyLimit - introducedToday)

        for (const card of cards) {
          const state = stateMap.get(card.id)

          if (!state) {
            // New card — only include if under daily limit
            if (newCardBudget <= 0) continue
            newCardBudget--
            allCards.push({
              card,
              state: initialCardState(session.user.id, card.id, pipeline.id),
              pipeline,
              gradingSettings: deck.gradingSettings,
              deckName: deck.name,
            })
          } else if (!state.graduated) {
            // In pipeline — always include
            allCards.push({ card, state, pipeline, gradingSettings: deck.gradingSettings, deckName: deck.name })
          } else if (state.dueAt && new Date(state.dueAt) <= now) {
            // Graduated and due
            allCards.push({ card, state, pipeline, gradingSettings: deck.gradingSettings, deckName: deck.name })
          }
        }
      }

      if (allCards.length === 0) { setDone(true); setLoading(false); return }

      // Shuffle all seen cards; keep new cards in order at the start
      const newCards  = allCards.filter(c => !c.state.lastReviewedAt)
      const seenCards = shuffle(allCards.filter(c => c.state.lastReviewedAt))
      setQueue([...newCards, ...seenCards])
      setLoading(false)
    }
    load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAnswer = useCallback(async (rating: Rating, wasCorrect: boolean, userAnswer = '') => {
    const current = queue[index]
    if (!current) return

    const { card, state, pipeline, gradingSettings } = current
    const stateRepo  = new SupabaseCardStateRepository()
    const eventRepo  = new SupabaseReviewEventRepository()
    const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!

    await eventRepo.create({
      userId: userId, cardId: card.id, mode: step.stepType,
      promptSide: step.promptSide, answerSide: step.answerSide,
      promptShown: step.promptSide === 'front' ? card.front : card.back,
      expected:    step.answerSide === 'front' ? card.front : card.back,
      userAnswer, wasCorrect, rating, responseMs: null,
    })

    const newState = progressAfterReview(state, pipeline, { wasCorrect, rating })
    await stateRepo.upsert(newState)

    if (index + 1 >= queue.length) setDone(true)
    else {
      setQueue(prev => prev.map((item, i) => i === index ? { ...item, state: newState } : item))
      setIndex(i => i + 1)
    }
  }, [queue, index, userId])

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading session…</div>

  if (done) {
    return (
      <div className="max-w-md mx-auto pt-20 text-center space-y-6">
        <div className="text-5xl">🎉</div>
        <h2 className="text-2xl font-semibold text-ink">Session complete!</h2>
        <p className="text-ink-muted">You reviewed {queue.length} card{queue.length !== 1 ? 's' : ''} across all decks.</p>
        <Link href="/study" className="btn-primary inline-block">Back to study</Link>
      </div>
    )
  }

  const current = queue[index]!
  const { card, state, pipeline, gradingSettings, deckName } = current
  const sortedSteps = [...pipeline.steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const step = sortedSteps.find(s => s.stepOrder === state.currentStepOrder) ?? sortedSteps[0]!

  return (
    <div className="space-y-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between">
        <Link href="/study" className="text-sm text-ink-muted hover:text-ink">✕ End session</Link>
        <div className="text-xs text-ink-muted">{index + 1} / {queue.length}</div>
        <div className="text-xs text-ink-muted">{state.graduated ? 'Review' : `Step ${state.currentStepOrder + 1} · ${step.stepType}`}</div>
      </div>
      <div className="h-1 bg-surface-raised rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full transition-all duration-300"
          style={{ width: `${Math.round((index / queue.length) * 100)}%` }} />
      </div>
      {step.stepType === 'recognition' ? (
        <FlashcardMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide} deckName={deckName}
          onRate={rating => handleAnswer(rating, ratingToWasCorrect(rating))} />
      ) : (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          gradingSettings={gradingSettings} deckName={deckName}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      )}
    </div>
  )
}
