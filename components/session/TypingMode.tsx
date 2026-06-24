'use client'

import { useEffect, useRef, useState } from 'react'
import type { Card, GradingSettings, GradingIssueType, GradingStatus, Rating } from '@/domain'
import { gradeTyping, normalizeAnswer } from '@/engine/grading'
import { speak } from '@/lib/speak'
import { RatingButtons } from './RatingButtons'
import { EditablePromptPanel } from './EditablePromptPanel'

/**
 * Type-the-answer recall component.
 *
 * Three-state grading:
 *   correct   → green; rating buttons (post-grad, default Good) / Continue (pre-grad)
 *   almost    → amber; reason shown; rating buttons (post-grad, default Hard) /
 *               retype required (pre-grad, counts as 'again')
 *   incorrect → red; retype required (both modes, counts as 'again')
 *
 * No "?" button — typed cards always require an attempt.
 * Persisted overrides (Override as correct / Override as incorrect) still work.
 */
export function TypingMode({
  card, promptSide, promptLanguage, gradingSettings, gradedReview,
  deckName, overrideAnswers, synonyms, onOverrideAnswer, onRate, onRepeat, onIDontKnow, onAdvance, onPromptEdit, answerLanguage, autoPlayAudio = true,
}: {
  card:             Card
  promptSide:       'front' | 'back'
  promptLanguage?:  string
  gradingSettings:  GradingSettings
  gradedReview:     boolean
  deckName?:        string
  overrideAnswers?: string[]
  synonyms?:        string[]
  onOverrideAnswer?: (normalizedAnswer: string, accept: boolean) => void
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string, issueType?: GradingIssueType) => void
  onRepeat?: () => void
  onIDontKnow?: () => void
  onAdvance?: () => void
  onPromptEdit?: (newText: string) => void
  answerLanguage?: string
  /** When false, suppresses automatic audio playback; the manual speaker button still works. */
  autoPlayAudio?: boolean
}) {
  type LocalResult = {
    status:        GradingStatus
    reason:        string
    issueType:     GradingIssueType
    correct:       boolean          // true iff effective status === 'correct'
    expected:      string
    viaOverride:   boolean
    viaSynonym:    boolean
    normalizedUser: string
  }

  const [input,      setInput]      = useState('')
  const [result,     setResult]     = useState<LocalResult | null>(null)
  const [override,   setOverride]   = useState<boolean | null>(null)
  const [retype,     setRetype]     = useState('')
  const [revealed,   setRevealed]   = useState(false)
  const [composing,  setComposing]  = useState(false)
  const continueRef = useRef<HTMLButtonElement>(null)
  const retypeRef   = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setInput('')
    setResult(null)
    setOverride(null)
    setRetype('')
    setRevealed(false)
    setComposing(false)
  }, [card.id])

  // Auto-play when the prompt IS the source language (e.g. Korean shown, type English).
  useEffect(() => {
    if (autoPlayAudio && promptLanguage) speak(card.front, promptLanguage, card.audioData)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id])

  const prompt   = promptSide === 'front' ? card.front : card.back
  const expected = promptSide === 'front' ? card.back  : card.front

  const finalCorrect = override ?? result?.correct ?? false

  // Post-grad: no retype — wrong answers auto-submit 'again' via a Continue button.
  // Pre-grad:  retype for both 'incorrect' and 'almost'.
  const needsRetype = !!result && !finalCorrect && !gradedReview

  const retypeCorrect = needsRetype &&
    gradeTyping(retype, expected, gradingSettings).status === 'correct'

  const suggestedRating: Rating =
    finalCorrect              ? 'good' :
    result?.status === 'almost' ? 'hard' :
                                  'again'

  useEffect(() => {
    if (!result || needsRetype) return
    const t = setTimeout(() => continueRef.current?.focus(), 100)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!result, needsRetype])

  // Delay focus on the retype input so IME composition has fully settled before
  // the new input receives focus. Without the delay, the composing syllable that
  // was pending when the user pressed Enter gets inserted into the retype box.
  useEffect(() => {
    if (!needsRetype) return
    const t = setTimeout(() => retypeRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [needsRetype])

  function check() {
    const base = gradeTyping(input, expected, gradingSettings)
    const viaOverride = base.status !== 'correct' &&
      (overrideAnswers ?? []).includes(base.normalizedUser)
    const viaSynonym  = base.status !== 'correct' && !viaOverride &&
      (synonyms ?? []).some(s => gradeTyping(input, s, gradingSettings).status === 'correct')

    const effectivelyCorrect = base.correct || viaOverride || viaSynonym
    setResult({
      status:         effectivelyCorrect ? 'correct' : base.status,
      reason:         base.reason,
      issueType:      base.issueType,
      correct:        effectivelyCorrect,
      expected,
      viaOverride,
      viaSynonym,
      normalizedUser: base.normalizedUser,
    })
    setOverride(null)
    setRetype('')
    // Auto-play when typing the source language (e.g. typed Korean correctly).
    if (autoPlayAudio && effectivelyCorrect && answerLanguage) {
      speak(card.front, answerLanguage, card.audioData)
    }
  }

  function advanceRetype() {
    if (!retypeCorrect) return
    onRate('again', false, input, result?.issueType)
  }

  function tryAdvance(rating: Rating) {
    onRate(rating, finalCorrect, input, result?.issueType)
  }

  function setOverrideAndPersist(next: boolean | null) {
    if (result) {
      const { normalizedUser, viaOverride } = result
      if (next === true && override !== true) {
        onOverrideAnswer?.(normalizedUser, true)
      } else if (next === false && override !== false) {
        if (viaOverride) onOverrideAnswer?.(normalizedUser, false)
      } else if (next === null) {
        if (override === true) onOverrideAnswer?.(normalizedUser, false)
        else if (override === false && viaOverride) onOverrideAnswer?.(normalizedUser, true)
      }
    }
    setOverride(next)
  }

  // ── Feedback panel styling ─────────────────────────────────────────────────
  const feedbackClass = finalCorrect
    ? 'border-success/30 bg-success/5'
    : (result?.status === 'almost' && override !== false)
      ? 'border-warning/30 bg-warning/5'
      : 'border-danger/30 bg-danger/5'

  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}

      {/* Prompt */}
      <div className="panel relative min-h-[120px] flex items-center justify-center text-center">
        <EditablePromptPanel text={prompt} onEdit={t => onPromptEdit?.(t)} />
        {promptLanguage && (
          <button
            onClick={() => speak(prompt, promptLanguage, card.audioData)}
            title="Listen"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 text-ink-faint hover:text-ink-muted transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 0 0 1.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06ZM18.584 5.106a.75.75 0 0 1 1.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 0 1-1.06-1.06 8.25 8.25 0 0 0 0-11.668.75.75 0 0 1 0-1.06Z" />
              <path d="M15.932 7.757a.75.75 0 0 1 1.061 0 6 6 0 0 1 0 8.486.75.75 0 0 1-1.06-1.061 4.5 4.5 0 0 0 0-6.364.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        )}
        {!result && !revealed && !gradedReview && onIDontKnow && (
          <button
            onClick={() => { onIDontKnow(); setRevealed(true) }}
            title="I don't know"
            className="absolute bottom-3 right-3 text-lg text-danger/70 hover:text-danger transition-colors leading-none"
          >
            ?
          </button>
        )}
      </div>

      {/* Input + feedback */}
      <div className="space-y-3">
        {revealed ? (
          <>
            <input
              className="input text-center text-lg font-mono border-danger/60 bg-danger/5"
              value={expected}
              readOnly
              disabled
            />
            <div className="flex justify-center">
              <button ref={continueRef} onClick={onAdvance} className="btn-primary px-10" autoFocus>
                Continue
              </button>
            </div>
          </>
        ) : (
        <>
        <input
          className={`input text-center text-lg font-mono ${
            !result ? '' :
            finalCorrect ? 'border-success/60 bg-success/5' :
            result.status === 'almost' && override !== false ? 'border-warning/60 bg-warning/5' :
            'border-danger/60 bg-danger/5'
          }`}
          placeholder="Type your answer…"
          value={input}
          onChange={e => { if (!result) setInput(e.target.value) }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={e => {
            // Ignore Enter while IME is composing — the composing syllable would
            // otherwise leak into the retype input that appears next.
            if (e.key === 'Enter' && !result && !composing) check()
          }}
          disabled={!!result}
          autoFocus={!revealed}
        />

        {!result ? (
          <div className="flex gap-3 justify-center">
            <button onClick={check} disabled={!input.trim()} className="btn-primary">Check</button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Result panel */}
            <div className={`panel text-center py-3 ${feedbackClass}`}>
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
              ) : result.status === 'almost' && override !== false ? (
                <div className="space-y-1">
                  <p className="text-warning font-medium">Almost!</p>
                  {result.reason && <p className="text-ink-muted text-sm">{result.reason}</p>}
                  <p className="text-ink-muted text-sm">
                    Answer: <span className="text-ink font-mono">{result.expected}</span>
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-danger font-medium">
                    Not quite
                    {override === false && <span className="text-ink-faint font-normal"> (marked wrong)</span>}
                  </p>
                  <p className="text-ink-muted text-sm">
                    Answer: <span className="text-ink font-mono">{result.expected}</span>
                  </p>
                </div>
              )}
            </div>

            {/* Override controls */}
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

            {/* Retype (for incorrect, and for "almost" in pre-grad mode) */}
            {needsRetype && (
              <div className="space-y-2">
                <p className="text-xs text-ink-muted text-center">Type the correct answer to continue:</p>
                <input
                  ref={retypeRef}
                  className={`input text-center text-lg font-mono ${retypeCorrect ? 'border-success/60 bg-success/5' : ''}`}
                  placeholder="Retype the answer…"
                  value={retype}
                  onChange={e => setRetype(e.target.value)}
                  onCompositionStart={() => setComposing(true)}
                  onCompositionEnd={() => setComposing(false)}
                  onKeyDown={e => { if (e.key === 'Enter' && !composing) advanceRetype() }}
                />
                {retypeCorrect && (
                  <div className="flex justify-center">
                    <button onClick={advanceRetype} className="btn-primary px-10">Continue</button>
                  </div>
                )}
              </div>
            )}

            {/* Rating buttons / Continue (shown when no retype needed) */}
            {!needsRetype && (
              gradedReview ? (
                finalCorrect ? (
                  <RatingButtons onRate={tryAdvance} suggestedRating={suggestedRating} />
                ) : (
                  <div className="flex justify-center">
                    <button
                      ref={continueRef}
                      onClick={() => tryAdvance('again')}
                      className="btn-primary px-10"
                    >
                      Continue
                    </button>
                  </div>
                )
              ) : (
                <div className="flex justify-center gap-3">
                  {onRepeat && finalCorrect && (
                    <button
                      onClick={() => { setResult(null); setInput(''); onRepeat() }}
                      className="btn-ghost px-6"
                    >
                      Repeat
                    </button>
                  )}
                  <button
                    ref={continueRef}
                    onClick={() => tryAdvance(finalCorrect ? 'good' : 'again')}
                    className="btn-primary px-10"
                  >
                    Continue
                  </button>
                </div>
              )
            )}
          </div>
        )}
        </>
        )}
      </div>
    </div>
  )
}
