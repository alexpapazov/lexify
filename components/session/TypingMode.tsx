'use client'

import { useEffect, useRef, useState } from 'react'
import type { Card, GradingSettings, Rating } from '@/domain'
import { gradeTyping } from '@/engine/grading'
import { speak } from '@/lib/speak'
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
export function TypingMode({ card, promptSide, promptLanguage, gradingSettings, gradedReview, deckName, overrideAnswers, synonyms, onOverrideAnswer, onIDontKnow, onAdvance, onRate }: {
  card: Card
  promptSide: 'front' | 'back'
  /** BCP 47 / ISO 639-1 language code for the prompt text — used for TTS. */
  promptLanguage?: string
  gradingSettings: GradingSettings
  gradedReview: boolean
  deckName?: string
  /**
   * Normalized typed answers (matching gradeTyping()'s `normalizedUser`)
   * previously persisted via "Override as correct" for this card+direction —
   * treated as correct even though gradeTyping() alone would mark them wrong.
   */
  overrideAnswers?: string[]
  /**
   * Accepted synonym/alternate phrasings for the answer side (from
   * card.choices.frontSynonyms / backSynonyms). When the learner types a
   * synonym, the answer is marked correct but shows "The original term is…"
   * so they know the canonical answer. They can still override as incorrect
   * to force exact recall.
   */
  synonyms?: string[]
  /** Sets (accept=true) or clears (accept=false) a persisted typed-answer override for `normalizedAnswer`. */
  onOverrideAnswer?: (normalizedAnswer: string, accept: boolean) => void
  /** Called when the learner pressed "?" — parent applies a heavy penalty behind the scenes. */
  onIDontKnow?: () => void
  /** Called when Continue is pressed after "?" revealed the answer (penalty already applied via onIDontKnow). */
  onAdvance?: () => void
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string) => void
}) {
  const [input,       setInput]       = useState('')
  const [result,      setResult]      = useState<{ correct: boolean; expected: string; viaOverride: boolean; viaSynonym: boolean; normalizedUser: string } | null>(null)
  const [override,    setOverride]    = useState<boolean | null>(null)
  const [retype,      setRetype]      = useState('')
  const [revealed,    setRevealed]    = useState(false)
  const continueRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setInput('')
    setResult(null)
    setOverride(null)
    setRetype('')
    setRevealed(false)
  }, [card.id])

  const prompt   = promptSide === 'front' ? card.front : card.back
  const expected = promptSide === 'front' ? card.back  : card.front

  const finalCorrect = override ?? result?.correct ?? false
  // Wrong answers (and "marked wrong" overrides) require retyping the
  // correct answer before continuing. Typo overrides skip this.
  const needsRetype   = !!result && !finalCorrect

  // Delay-focus the Continue button so the Enter keypress that triggered check()
  // doesn't immediately fire a click on the newly-focused button.
  useEffect(() => {
    if (!result || needsRetype || revealed) return
    const t = setTimeout(() => continueRef.current?.focus(), 100)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!result, needsRetype, revealed])
  const retypeCorrect = needsRetype && gradeTyping(retype, expected, gradingSettings).correct

  function advanceRetype() {
    if (!retypeCorrect) return
    // A wrong typed answer always counts as "Again" — no rating choice.
    onRate('again', false, input)
  }

  function check() {
    const base = gradeTyping(input, expected, gradingSettings)
    const viaOverride = !base.correct && (overrideAnswers ?? []).includes(base.normalizedUser)
    const viaSynonym  = !base.correct && !viaOverride &&
      (synonyms ?? []).some(s => gradeTyping(input, s, gradingSettings).correct)
    setResult({ correct: base.correct || viaOverride || viaSynonym, expected, viaOverride, viaSynonym, normalizedUser: base.normalizedUser })
    setOverride(null)
    setRetype('')
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
      <div className="panel relative min-h-[120px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{prompt}</p>
        {promptLanguage && (
          <button
            onClick={() => speak(prompt, promptLanguage)}
            title="Listen"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 text-ink-faint hover:text-ink-muted transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 0 0 1.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06ZM18.584 5.106a.75.75 0 0 1 1.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 0 1-1.06-1.06 8.25 8.25 0 0 0 0-11.668.75.75 0 0 1 0-1.06Z" />
              <path d="M15.932 7.757a.75.75 0 0 1 1.061 0 6 6 0 0 1 0 8.486.75.75 0 0 1-1.06-1.061 4.5 4.5 0 0 0 0-6.364.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        )}
        {!result && !revealed && onIDontKnow && (
          <button
            onClick={() => { onIDontKnow(); setRevealed(true) }}
            title="I don't know"
            className="absolute bottom-3 right-3 text-lg text-danger/70 hover:text-danger transition-colors leading-none"
          >
            ?
          </button>
        )}
      </div>
      <div className="space-y-3">
        <input
          className={`input text-center text-lg font-mono ${revealed ? 'opacity-50' : result ? result.correct ? 'border-success/60 bg-success/5' : 'border-danger/60 bg-danger/5' : ''}`}
          placeholder="Type your answer…" value={revealed ? expected : input}
          onChange={e => { if (!revealed) setInput(e.target.value) }}
          onKeyDown={e => { if (e.key === 'Enter' && !result && !revealed) check() }}
          disabled={!!result || revealed} autoFocus />
        {revealed ? (
          <div className="space-y-4">
            <div className="panel text-center py-3 border-ink-faint/20 bg-surface-raised/20">
              <p className="text-ink-muted text-sm">Answer: <span className="font-mono text-ink">{expected}</span></p>
            </div>
            <div className="flex justify-center">
              <button onClick={onAdvance} autoFocus className="btn-primary px-10">Continue</button>
            </div>
          </div>
        ) : !result ? (
          <div className="flex gap-3 justify-center">
            <button onClick={check} disabled={!input.trim()} className="btn-primary">Check</button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className={`panel text-center py-3 ${finalCorrect ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}`}>
              {finalCorrect ? (
                <div className="space-y-1">
                  <p className="text-success font-medium">
                    Correct!
                    {override === true && <span className="text-ink-faint font-normal"> (marked correct)</span>}
                    {override === null && result.viaOverride && <span className="text-ink-faint font-normal"> (remembered override)</span>}
                    {override === null && result.viaSynonym && <span className="text-amber-400/80 font-normal"> (synonym)</span>}
                  </p>
                  {result.viaSynonym && override !== false && (
                    <p className="text-xs text-ink-muted">
                      The original term is: <span className="font-mono text-ink">{result.expected}</span>
                    </p>
                  )}
                </div>
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
                  <button ref={continueRef} onClick={() => tryAdvance(finalCorrect ? 'good' : 'again')} className="btn-primary px-10">
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
