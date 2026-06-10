'use client'

import { useEffect, useState } from 'react'
import type { Card, GradingSettings, Rating } from '@/domain'
import { gradeTyping } from '@/engine/grading'
import { RatingButtons } from './RatingButtons'

const AUTO_ADVANCE_MS = 900

/**
 * Type-the-answer recall.
 *
 * - `gradedReview = false` (pre-graduation): no rating buttons — correctness
 *   is auto-derived ('good' if correct, 'again' if not) and the session
 *   advances automatically after a short delay.
 * - `gradedReview = true` (post-graduation, long-term retention): shows
 *   Again/Hard/Good/Easy after checking, same as before.
 */
export function TypingMode({ card, promptSide, gradingSettings, gradedReview, deckName, onRate }: {
  card: Card
  promptSide: 'front' | 'back'
  gradingSettings: GradingSettings
  gradedReview: boolean
  deckName?: string
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string) => void
}) {
  const [input,  setInput]  = useState('')
  const [result, setResult] = useState<{ correct: boolean; expected: string } | null>(null)
  useEffect(() => { setInput(''); setResult(null) }, [card.id])

  const prompt   = promptSide === 'front' ? card.front : card.back
  const expected = promptSide === 'front' ? card.back  : card.front

  function finish(correct: boolean, userAnswer: string) {
    setResult({ correct, expected })
    if (!gradedReview) {
      setTimeout(() => onRate(correct ? 'good' : 'again', correct, userAnswer), AUTO_ADVANCE_MS)
    }
  }

  function check() {
    finish(gradeTyping(input, expected, gradingSettings).correct, input)
  }

  function dontKnow() {
    finish(false, '')
    setInput('')
  }

  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
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
            <button onClick={dontKnow} className="text-xs text-ink-faint hover:text-ink-muted pt-2">Don&apos;t know</button>
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
            {gradedReview && <RatingButtons onRate={r => onRate(r, result.correct, input)} />}
          </div>
        )}
      </div>
    </div>
  )
}
