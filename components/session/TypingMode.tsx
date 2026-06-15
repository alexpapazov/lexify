'use client'

import { useEffect, useState } from 'react'
import type { Card, GradingSettings, Rating } from '@/domain'
import { gradeTyping } from '@/engine/grading'
import { RatingButtons } from './RatingButtons'

/**
 * Type-the-answer recall.
 *
 * - After checking, the session never auto-advances — the learner presses
 *   Continue (or Enter, since the relevant button is auto-focused) to move
 *   on.
 * - If the answer was wrong (and not overridden as correct), the learner
 *   must retype the correct answer exactly — reinforcing the right form.
 *   Once the retype matches, it auto-advances immediately (no Enter/Continue
 *   needed) and always counts as "Again".
 * - "Mark as correct" / "Mark as wrong" override buttons let the learner
 *   correct a typo (mark a wrong answer as correct, skipping the retype) or
 *   flag a lucky/right answer as wrong (so it comes back sooner).
 * - `gradedReview = true` (post-graduation, long-term retention): shows
 *   Again/Hard/Good/Easy instead of a single Continue button.
 */
export function TypingMode({ card, promptSide, gradingSettings, gradedReview, deckName, onRate }: {
  card: Card
  promptSide: 'front' | 'back'
  gradingSettings: GradingSettings
  gradedReview: boolean
  deckName?: string
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string) => void
}) {
  const [input,       setInput]       = useState('')
  const [result,      setResult]      = useState<{ correct: boolean; expected: string } | null>(null)
  const [override,    setOverride]    = useState<boolean | null>(null)
  const [retype,      setRetype]      = useState('')

  useEffect(() => {
    setInput('')
    setResult(null)
    setOverride(null)
    setRetype('')
  }, [card.id])

  const prompt   = promptSide === 'front' ? card.front : card.back
  const expected = promptSide === 'front' ? card.back  : card.front

  const finalCorrect = override ?? result?.correct ?? false
  // Wrong answers (and "marked wrong" overrides) require retyping the
  // correct answer before continuing. Typo overrides skip this.
  const needsRetype  = !!result && !finalCorrect

  function check() {
    setResult({ correct: gradeTyping(input, expected, gradingSettings).correct, expected })
    setOverride(null)
    setRetype('')
  }

  function dontKnow() {
    setResult({ correct: false, expected })
    setOverride(null)
    setRetype('')
    setInput('')
  }

  function tryAdvance(rating: Rating) {
    onRate(rating, finalCorrect, input)
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
            <div className={`panel text-center py-3 ${finalCorrect ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}`}>
              {finalCorrect ? (
                <p className="text-success font-medium">Correct!{override === true && <span className="text-ink-faint font-normal"> (marked correct)</span>}</p>
              ) : (
                <div className="space-y-1">
                  <p className="text-danger font-medium">Not quite{override === false && <span className="text-ink-faint font-normal"> (marked wrong)</span>}</p>
                  <p className="text-ink-muted text-sm">Answer: <span className="text-ink font-mono">{result.expected}</span></p>
                </div>
              )}
            </div>

            {/* Override controls — fix a typo or flag a lucky guess. */}
            <div className="flex items-center justify-center gap-3">
              {result.correct && override !== false && (
                <button onClick={() => setOverride(false)} className="text-xs text-ink-faint hover:text-danger transition-colors">
                  Actually mark wrong
                </button>
              )}
              {!result.correct && override !== true && (
                <button onClick={() => setOverride(true)} className="text-xs text-ink-faint hover:text-success transition-colors">
                  Actually mark correct (typo)
                </button>
              )}
              {override !== null && (
                <button onClick={() => setOverride(null)} className="text-xs text-ink-faint hover:text-ink-muted transition-colors">
                  Undo override
                </button>
              )}
            </div>

            {needsRetype && (
              <div className="space-y-2">
                <p className="text-xs text-ink-muted text-center">Type the correct answer to continue:</p>
                <input
                  className="input text-center text-lg font-mono"
                  placeholder="Retype the answer…" value={retype}
                  onChange={e => {
                    const value = e.target.value
                    setRetype(value)
                    // A wrong typed answer always counts as "Again" — no
                    // rating choice. Auto-advance as soon as the retype
                    // matches, no Enter/Continue needed.
                    if (value.trim().toLowerCase() === expected.trim().toLowerCase()) {
                      onRate('again', false, input)
                    }
                  }}
                  autoFocus
                />
              </div>
            )}

            {!needsRetype && (
              gradedReview ? (
                <RatingButtons onRate={tryAdvance} />
              ) : (
                <div className="flex justify-center">
                  {/* Auto-focused so pressing Enter continues. */}
                  <button onClick={() => tryAdvance(finalCorrect ? 'good' : 'again')} autoFocus className="btn-primary px-10">
                    Continue
                  </button>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}
