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
import { progressAfterReview, initialCardState, ratingToWasCorrect } from '@/engine/pipeline'
import { gradeTyping } from '@/engine/grading'
import type { Card, CardState, Pipeline, Rating, GradingSettings } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'

interface SessionCard { card: Card; state: CardState; pipeline: Pipeline }

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

// ─── Shared UI ───────────────────────────────────────────────────────────────

function RatingButtons({ onRate }: { onRate: (r: Rating) => void }) {
  const buttons: { rating: Rating; label: string; color: string }[] = [
    { rating: 'again', label: 'Again', color: 'border-danger/60 text-danger hover:bg-danger/10'      },
    { rating: 'hard',  label: 'Hard',  color: 'border-warning/60 text-warning hover:bg-warning/10'   },
    { rating: 'good',  label: 'Good',  color: 'border-success/60 text-success hover:bg-success/10'   },
    { rating: 'easy',  label: 'Easy',  color: 'border-accent/60 text-accent-soft hover:bg-accent/10' },
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

function FlashcardMode({ card, promptSide, onRate }: {
  card: Card; promptSide: 'front' | 'back'; onRate: (r: Rating) => void
}) {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => setRevealed(false), [card.id])
  const prompt = promptSide === 'front' ? card.front : card.back
  const answer = promptSide === 'front' ? card.back  : card.front
  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
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

function TypingMode({ card, promptSide, gradingSettings, onRate }: {
  card: Card; promptSide: 'front' | 'back'; gradingSettings: GradingSettings
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
      <div className="panel min-h-[120px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{prompt}</p>
      </div>
      <div className="space-y-3">
        <input
          className={`input text-center text-lg font-mono ${result ? result.correct ? 'border-success/60 bg-success/5' : 'border-danger/60 bg-danger/5' : ''}`}
          placeholder="Type your answer…" value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !result) check() }} disabled={!!result} autoFocus />
        {!result ? (
          <div className="flex gap-3 justify-center">
            <button onClick={check} disabled={!input.trim()} className="btn-primary">Check</button>
            <button onClick={() => { setResult({ correct: false, expected }); setInput('') }}
              className="text-xs text-ink-faint hover:text-ink-muted pt-2">Don&apos;t know</button>
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

// ─── Session ─────────────────────────────────────────────────────────────────

export default function SessionPage() {
  const { deckId } = useParams<{ deckId: string }>()
  const router     = useRouter()
  const supabase   = createClient()

  const [queue,           setQueue]           = useState<SessionCard[]>([])
  const [index,           setIndex]           = useState(0)
  const [loading,         setLoading]         = useState(true)
  const [userId,          setUserId]          = useState('')
  const [deckName,        setDeckName]        = useState('')
  const [gradingSettings, setGradingSettings] = useState<GradingSettings | null>(null)
  const [done,            setDone]            = useState(false)

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

      const [deck, cards, pipeline, prefs] = await Promise.all([
        deckRepo.get(deckId),
        cardRepo.listByDeck(deckId),
        pipelineRepo.getDefault(),
        prefRepo.get(session.user.id, deckId),
      ])

      if (!deck || cards.length === 0) { router.push(`/study/${deckId}`); return }
      setDeckName(deck.name)
      setGradingSettings(deck.gradingSettings)

      const existingStates = await stateRepo.listByDeck(session.user.id, deckId)
      const stateMap = new Map(existingStates.map(s => [s.cardId, s]))

      const now   = new Date()
      const today = now.toISOString().slice(0, 10)

      const dailyLimit   = Math.min(
        prefs ? prefRepo.effectiveDailyLimit(prefs) : DEFAULT_DAILY_NEW_CARDS,
        cards.length,
      )
      const spilloverOn  = prefs?.spilloverDue ?? false

      const introducedToday    = existingStates.filter(s => s.introducedDate === today).length
      // In-pipeline cards introduced before today (i.e. the "backlog")
      const inPipelineBacklog  = existingStates.filter(s => !s.graduated && s.introducedDate && s.introducedDate < today).length

      // Without spillover: backlog cards count against today's budget
      // With spillover:    backlog is additive — full daily budget for new cards
      const budgetUsed    = spilloverOn ? introducedToday : introducedToday + inPipelineBacklog
      let newCardBudget   = Math.max(0, dailyLimit - budgetUsed)

      // Build three buckets
      const newCards:    SessionCard[] = []
      const inPipeline:  SessionCard[] = []
      const dueCards:    SessionCard[] = []

      for (const card of cards) {
        const state = stateMap.get(card.id)
        if (!state) {
          if (newCardBudget <= 0) continue
          newCardBudget--
          newCards.push({ card, state: initialCardState(session.user.id, card.id, pipeline.id), pipeline })
        } else if (!state.graduated) {
          inPipeline.push({ card, state, pipeline })
        } else if (state.dueAt && new Date(state.dueAt) <= now) {
          dueCards.push({ card, state, pipeline })
        }
      }

      // New cards: keep in deck order (first session = ordered introduction)
      // In-pipeline + due: shuffle so session feels varied
      const finalQueue = [...newCards, ...shuffle(inPipeline), ...shuffle(dueCards)]

      if (finalQueue.length === 0) { setDone(true); setLoading(false); return }
      setQueue(finalQueue)
      setLoading(false)
    }
    load()
  }, [deckId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAnswer = useCallback(async (rating: Rating, wasCorrect: boolean, userAnswer = '') => {
    const current = queue[index]
    if (!current) return

    const { card, state, pipeline } = current
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
        <p className="text-ink-muted">You reviewed {queue.length} card{queue.length !== 1 ? 's' : ''}.</p>
        <div className="flex gap-3 justify-center">
          <Link href={`/study/${deckId}`} className="btn-primary">Back to deck</Link>
          <Link href="/study" className="btn-ghost">All decks</Link>
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
      <p className="text-xs text-ink-faint uppercase tracking-wider text-center">{deckName}</p>

      {step.stepType === 'recognition' ? (
        <FlashcardMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          onRate={rating => handleAnswer(rating, ratingToWasCorrect(rating))} />
      ) : (
        <TypingMode key={`${card.id}-${index}`} card={card} promptSide={step.promptSide}
          gradingSettings={gradingSettings!}
          onRate={(rating, wasCorrect, userAnswer) => handleAnswer(rating, wasCorrect, userAnswer)} />
      )}
    </div>
  )
}
