'use client'

import { useEffect, useRef, useState } from 'react'
import type { Card, GradingSettings, GradingIssueType, GradingStatus, Rating } from '@/domain'
import { gradeTyping, normalizeAnswer } from '@/engine/grading'
import { speak } from '@/lib/speak'
import { langNativeName } from '@/lib/languages'
import { displayText } from '@/lib/cardText'
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
  deckName, overrideAnswers, synonyms, deckSiblings, onOverrideAnswer, onRate, onRepeat, onIDontKnow, onAdvance, onPromptEdit, onSiblingAnswered, onResetCard, answerLanguage, autoPlayAudio = true, ipaText, onToggleIPA,
}: {
  card:             Card
  promptSide:       'front' | 'back'
  promptLanguage?:  string
  gradingSettings:  GradingSettings
  gradedReview:     boolean
  deckName?:        string
  overrideAnswers?: string[]
  synonyms?:        string[]
  /** Same-deck cards that map to the same meaning — triggers a two-phase flow where the sibling gets credit and the canonical answer is still required. */
  deckSiblings?:    { id: string; answer: string }[]
  onOverrideAnswer?: (normalizedAnswer: string, accept: boolean) => void
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string, issueType?: GradingIssueType) => void
  onRepeat?: () => void
  onIDontKnow?: () => void
  onAdvance?: () => void
  onPromptEdit?: (newText: string) => void
  /** Called when a deck-sibling answer is detected; the parent should credit that card. */
  onSiblingAnswered?: (siblingCardId: string) => void
  onResetCard?: () => void
  answerLanguage?: string
  autoPlayAudio?: boolean
  /** IPA transcription for the prompt (source language). Shown inside the prompt card when provided. */
  ipaText?: string
  /** Toggles IPA on/off; when provided a faint "IPA" button appears in the prompt card corner. */
  onToggleIPA?: () => void
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
  const [override,        setOverride]        = useState<boolean | null>(null)
  const [retype,          setRetype]          = useState('')
  const [revealed,        setRevealed]        = useState(false)
  const [composing,       setComposing]       = useState(false)
  // Sibling phase: user typed a deck-sibling answer; canonical answer still required
  const [siblingId,       setSiblingId]       = useState<string | null>(null)
  const [siblingText,     setSiblingText]     = useState('')
  const [canonInput,      setCanonInput]      = useState('')
  const [composingCanon,  setComposingCanon]  = useState(false)
  // Synonym phase: user typed a synonym; canonical answer still required
  const [synonymPhase,     setSynonymPhase]     = useState(false)
  const [synonymPhaseText, setSynonymPhaseText] = useState('')
  const [resetConfirm, setResetConfirm] = useState(false)
  const continueRef = useRef<HTMLButtonElement>(null)
  const retypeRef   = useRef<HTMLInputElement>(null)
  const canonRef    = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setInput('')
    setResult(null)
    setOverride(null)
    setRetype('')
    setRevealed(false)
    setComposing(false)
    setSiblingId(null)
    setSiblingText('')
    setCanonInput('')
    setComposingCanon(false)
    setSynonymPhase(false)
    setSynonymPhaseText('')
  }, [card.id])

  // Auto-play when the prompt IS the source language (e.g. Korean shown, type English).
  useEffect(() => {
    if (autoPlayAudio && promptLanguage) speak(card.front, promptLanguage, card.audioData)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id])

  const prompt   = displayText(promptSide === 'front' ? card.front : card.back)
  const expected = promptSide === 'front' ? card.back  : card.front   // raw — gradeTyping strips quotes internally
  const displayExpected = displayText(expected)                        // for showing to the learner

  const finalCorrect = override ?? result?.correct ?? false

  const needsRetype = !!result && !finalCorrect

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

  useEffect(() => {
    if (!needsRetype) return
    const t = setTimeout(() => retypeRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [needsRetype])

  // Focus the canonical input when sibling or synonym phase begins.
  useEffect(() => {
    if (!siblingId) return
    const t = setTimeout(() => canonRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [siblingId])

  useEffect(() => {
    if (!synonymPhase) return
    const t = setTimeout(() => canonRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [synonymPhase])

  function gradeAndSetResult(typedInput: string, skipSynonymCheck = false) {
    const base = gradeTyping(typedInput, expected, gradingSettings)
    const viaOverride = base.status !== 'correct' &&
      (overrideAnswers ?? []).includes(base.normalizedUser)
    const viaSynonym  = !skipSynonymCheck && base.status !== 'correct' && !viaOverride &&
      (synonyms ?? []).some(s => gradeTyping(typedInput, s, gradingSettings).status === 'correct')
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
    if (autoPlayAudio && effectivelyCorrect && answerLanguage) {
      speak(card.front, answerLanguage, card.audioData)
    }
  }

  function check() {
    // Check deck siblings first — they require a two-phase flow.
    const matchedSibling = deckSiblings?.find(
      s => gradeTyping(input, s.answer, gradingSettings).status === 'correct'
    )
    if (matchedSibling) {
      setSiblingId(matchedSibling.id)
      setSiblingText(input)
      onSiblingAnswered?.(matchedSibling.id)
      return
    }
    // Synonyms require a two-phase flow: accept the synonym, then require the canonical.
    if (synonyms?.length) {
      const matchedSynonym = synonyms.find(
        s => gradeTyping(input, s, gradingSettings).status === 'correct'
      )
      if (matchedSynonym) {
        setSynonymPhase(true)
        setSynonymPhaseText(input)
        return
      }
    }
    gradeAndSetResult(input)
  }

  function checkCanonical() {
    gradeAndSetResult(canonInput, synonymPhase)
  }

  function advanceRetype() {
    if (!retypeCorrect) return
    onRate('again', false, synonymPhase ? canonInput : input, result?.issueType)
  }

  function tryAdvance(rating: Rating) {
    onRate(rating, finalCorrect, synonymPhase ? canonInput : input, result?.issueType)
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
        {resetConfirm ? (
          <div className="space-y-3 py-2 w-full">
            <p className="text-sm text-ink">Reset this card to the beginning of the learning pipeline?</p>
            <div className="flex justify-center gap-3">
              <button
                onClick={() => { onResetCard?.(); setResetConfirm(false) }}
                className="btn-primary text-sm px-4 py-1.5"
              >
                Yes, reset
              </button>
              <button
                onClick={() => setResetConfirm(false)}
                className="text-sm text-ink-muted hover:text-ink transition-colors px-4 py-1.5"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
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
            {!result && !revealed && gradedReview && onResetCard && (
              <button
                onClick={() => setResetConfirm(true)}
                title="Reset card to learning pipeline"
                className="absolute top-3 right-3 text-xs text-ink-faint hover:text-ink-muted transition-colors leading-none w-5 h-5 flex items-center justify-center rounded-full border border-white/10 hover:border-white/20"
              >
                ↺
              </button>
            )}
            {ipaText ? (
              <span className="absolute bottom-3 left-3 text-xs text-ink-muted font-mono leading-none"
                onClick={onToggleIPA} title="Hide IPA" style={onToggleIPA ? {cursor:'pointer'} : undefined}>
                [{ipaText}]
              </span>
            ) : onToggleIPA ? (
              <button onClick={onToggleIPA} title="Show IPA transcription"
                className="absolute bottom-3 left-3 text-xs text-ink-faint hover:text-ink-muted transition-colors leading-none">
                IPA
              </button>
            ) : null}
          </>
        )}
      </div>

      {/* Input + feedback */}
      <div className="space-y-3">
        {revealed ? (
          <>
            <input
              className="input text-center text-lg font-mono border-danger/60 bg-danger/5"
              value={displayExpected}
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
        {/* Phase 1 input — shows sibling/synonym answer (amber/green, disabled) or live input */}
        <input
          className={`input text-center text-lg font-mono ${
            siblingId    ? 'border-success/60 bg-success/5' :
            synonymPhase ? 'border-warning/60 bg-warning/5' :
            !result      ? '' :
            finalCorrect ? 'border-success/60 bg-success/5' :
            result.status === 'almost' && override !== false ? 'border-warning/60 bg-warning/5' :
            'border-danger/60 bg-danger/5'
          }`}
          placeholder={answerLanguage ? `Type ${langNativeName(answerLanguage)} answer…` : 'Type your answer…'}
          value={siblingId ? siblingText : synonymPhase ? synonymPhaseText : input}
          onChange={e => { if (!result && !siblingId && !synonymPhase) setInput(e.target.value) }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !result && !composing && !siblingId && !synonymPhase) check()
          }}
          disabled={!!result || !!siblingId || synonymPhase}
          autoFocus={!revealed && !siblingId && !synonymPhase}
        />

        {/* Sibling phase: success note + canonical input */}
        {siblingId && !result && (
          <div className="space-y-3">
            <div className="panel border-success/30 bg-success/5 text-center py-3 space-y-1">
              <p className="text-success font-medium">Correct! Also in your deck</p>
              <p className="text-xs text-ink-muted">Now type the answer for this specific card:</p>
            </div>
            <input
              ref={canonRef}
              className="input text-center text-lg font-mono"
              placeholder={answerLanguage ? `Type ${langNativeName(answerLanguage)} answer…` : 'Type your answer…'}
              value={canonInput}
              onChange={e => setCanonInput(e.target.value)}
              onCompositionStart={() => setComposingCanon(true)}
              onCompositionEnd={() => setComposingCanon(false)}
              onKeyDown={e => { if (e.key === 'Enter' && !composingCanon) checkCanonical() }}
            />
            <div className="flex justify-center">
              <button onClick={checkCanonical} disabled={!canonInput.trim()} className="btn-primary">Check</button>
            </div>
          </div>
        )}

        {/* Canonical input result display (sibling phase, after canonical graded) */}
        {siblingId && result && (
          <input
            className={`input text-center text-lg font-mono ${
              finalCorrect ? 'border-success/60 bg-success/5' :
              result.status === 'almost' && override !== false ? 'border-warning/60 bg-warning/5' :
              'border-danger/60 bg-danger/5'
            }`}
            value={canonInput}
            readOnly
            disabled
          />
        )}

        {/* Synonym phase: accepted note + canonical input */}
        {synonymPhase && !result && (
          <div className="space-y-3">
            <div className="panel border-warning/30 bg-warning/5 text-center py-3 space-y-1">
              <p className="text-warning font-medium">Synonym accepted!</p>
              <p className="text-xs text-ink-muted">Now type the canonical form to continue:</p>
            </div>
            <input
              ref={canonRef}
              className="input text-center text-lg font-mono"
              placeholder={answerLanguage ? `Type ${langNativeName(answerLanguage)} answer…` : 'Type your answer…'}
              value={canonInput}
              onChange={e => setCanonInput(e.target.value)}
              onCompositionStart={() => setComposingCanon(true)}
              onCompositionEnd={() => setComposingCanon(false)}
              onKeyDown={e => { if (e.key === 'Enter' && !composingCanon) checkCanonical() }}
            />
            <div className="flex justify-center">
              <button onClick={checkCanonical} disabled={!canonInput.trim()} className="btn-primary">Check</button>
            </div>
          </div>
        )}

        {/* Canonical input result display (synonym phase, after canonical graded) */}
        {synonymPhase && result && (
          <input
            className={`input text-center text-lg font-mono ${
              finalCorrect ? 'border-success/60 bg-success/5' :
              result.status === 'almost' && override !== false ? 'border-warning/60 bg-warning/5' :
              'border-danger/60 bg-danger/5'
            }`}
            value={canonInput}
            readOnly
            disabled
          />
        )}

        {!siblingId && !synonymPhase && !result ? (
          <div className="flex gap-3 justify-center">
            <button onClick={check} disabled={!input.trim()} className="btn-primary">Check</button>
          </div>
        ) : result ? (
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
                      onClick={() => { setResult(null); setInput(''); setSynonymPhase(false); setSynonymPhaseText(''); setCanonInput(''); onRepeat() }}
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
        ) : null}
        </>
        )}
      </div>
    </div>
  )
}
