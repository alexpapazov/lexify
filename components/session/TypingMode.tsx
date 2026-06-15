'use client'

import { useEffect, useState } from 'react'
import type { Card, GradingSettings, Rating } from '@/domain'
import { gradeTyping } from '@/engine/grading'
import { RatingButtons } from './RatingButtons'

/**
 * Type-the-answer recall.
 *
 * - The session never auto-advances, in any scenario — the learner always
 *   presses Continue (or Enter, since the relevant button/input is
 *   auto-focused) to move on.
 * - If the answer was wrong (and not overridden as correct), the learner
 *   must retype the correct answer exactly — reinforcing the right form.
 *   Once the retype matches, a Continue button appears (and Enter works)
 *   to advance; it always counts as "Again".
 * - "Override as correct" / "Override as incorrect" buttons let the learner
 *   correct a typo (mark a wrong answer as correct, skipping the retype) or
 *   flag a lucky/right answer as wrong (so it comes back sooner).
 * - Persisted overrides: when "Override as correct" is used on an answer
 *   gradeTyping() marked wrong, that exact (normalized) answer is remembered
 *   for this card+direction (via `onOverrideAnswer`/`overrideAnswers`) — the
 *   next time it's typed, it's automatically accepted. "Override as
 *   incorrect" on such an auto-accepted answer forgets it again. Overriding
 *   a *naturally* correct answer as incorrect stays session-local, as before.
 * - `gradedReview = true` (post-graduation, long-term retention): shows
 *   Again/Hard/Good/Easy instead of a single Continue button.
 */
export function TypingMode({ card, promptSide, gradingSettings, gradedReview, deckName, overrideAnswers, onOverrideAnswer, onRate }: {
  card: Card
  promptSide: 'front' | 'back'
  gradingSettings: GradingSettings
  gradedReview: boolean
  deckName?: string
  /**
   * Normalized typed answers (matching gradeTyping()'s `normalizedUser`)
   * previously persisted via "Override as correct" for this card+direction —
   * treated as correct even though gradeTyping() alone would mark them wrong.
   */
  overrideAnswers?: string[]
  /** Sets (accept=true) or clears (accept=false) a persisted typed-answer override for `normalizedAnswer`. */
  onOverrideAnswer?: (normalizedAnswer: string, accept: boolean) => void
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string) => void
}) {
  const [input,       setInput]       = useState('')
  const [result,      setResult]      = useState<{ correct: boolean; expected: string; viaOverride: boolean; normalizedUser: string } | null>(null)
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
  const needsRetype   = !!result && !finalCorrect
  const retypeCorrect = needsRetype && gradeTyping(retype, expected, gradingSettings).correct

  function advanceRetype() {
    if (!retypeCorrect) return
    // A wrong typed answer always counts as "Again" — no rating choice.
    onRate('again', false, input)
  }

  function check() {
    const base = gradeTyping(input, expected, gradingSettings)
    const viaOverride = !base.correct && (overrideAnswers ?? []).includes(base.normalizedUser)
    setResult({ correct: base.correct || viaOverride, expected, viaOverride, normalizedUser: base.normalizedUser })
    setOverride(null)
    setRetype('')
  }

  function dontKnow() {
    const normalizedUser = gradeTyping(input, expected, gradingSettings).normalizedUser
    setResult({ correct: false, expected, viaOverride: false, normalizedUser })
    setOverride(null)
    setRetype('')
    setInput('')
  }

  function tryAdvance(rating: Rating) {
    onRate(rating, finalCorrect, input)
  }

  // Sets (or clears) the session-local override, and persists/un-persists a
  // remembered typed-answer override to match — see the doc comment above
  // for the exact semantics (matches the "loup/wold" example).
  function setOverrideAndPersist(next: boolean | null) {
    if (result) {
      const { normalizedUser, viaOverride } = result
      if (next === true && override !== true) {
        // Marking a wrong answer as correct — remember it.
        onOverrideAnswer?.(normalizedUser, true)
      } else if (next === false && override !== false) {
        // Marking a (auto-accepted-via-override) correct answer as
        // incorrect — forget it. Naturally-correct answers stay session-local.
        if (viaOverride) onOverrideAnswer?.(normalizedUser, false)
      } else if (next === null) {
        // Undo — reverse whichever persistence change `override` made.
        if (override === true) onOverrideAnswer?.(normalizedUser, false)
        else if (override === false && viaOverride) onOverrideAnswer?.(normalizedUser, true)
      }
    }
    setOverride(next)
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
                <p className="text-success font-medium">
                  Correct!
                  {override === true && <span className="text-ink-faint font-normal"> (marked correct)</span>}
                  {override === null && result.viaOverride && <span className="text-ink-faint font-normal"> (remembered override)</span>}
                </p>
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
                <button onClick={() => setOverrideAndPersist(false)} className="text-xs text-ink-faint hover:text-danger transition-colors">
                  Override as incorrect
                </button>
              )}
              {!result.correct && override !== true && (
                <button onClick={() => setOverrideAndPersist(true)} className="text-xs text-ink-faint hover:text-success transition-colors">
                  Override as correct
                </button>
              )}
              {override !== null && (
                <button onClick={() => setOverrideAndPersist(null)} className="text-xs text-ink-faint hover:text-ink-muted transition-colors">
                  Undo override
                </button>
              )}
            </div>

            {needsRetype && (
              <div className="space-y-2">
                <p className="text-xs text-ink-muted text-center">Type the correct answer to continue:</p>
                <input
                  className={`input text-center text-lg font-mono ${retypeCorrect ? 'border-success/60 bg-success/5' : ''}`}
                  placeholder="Retype the answer…" value={retype}
                  onChange={e => setRetype(e.target.value)}
                  // Grading uses the same rules as the initial check
                  // (accents, articles, slash-alternatives, parentheticals).
                  // Never auto-advances — Enter only continues once the
                  // retype is correct.
                  onKeyDown={e => { if (e.key === 'Enter') advanceRetype() }}
                  autoFocus
                />
                {retypeCorrect && (
                  <div className="flex justify-center">
                    <button onClick={advanceRetype} autoFocus className="btn-primary px-10">
                      Continue
                    </button>
                  </div>
                )}
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
