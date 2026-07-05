'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { hintPlan, hintGrowthFactor } from '@/lib/hints'
import type { Card, GradingSettings, GradingIssueType, GradingStatus, Rating, TypedStrictness, TypedErrorCategory } from '@/domain'
import { DEFAULT_TYPED_STRICTNESS } from '@/domain'
import { gradeTyping, normalizeAnswer, resolveTypedPenalty } from '@/engine/grading'
import { speak } from '@/lib/speak'
import { langNativeName } from '@/lib/languages'
import { displayText } from '@/lib/cardText'
import { RatingButtons } from './RatingButtons'
import { EditablePromptPanel } from './EditablePromptPanel'
import { EditableAnswerText } from './EditableAnswerText'
import { CardInfoButton } from './CardInfoButton'

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
  deckName, overrideAnswers, synonyms, deckSiblings, onOverrideAnswer, onAddSynonym, onRate, onRepeat, onIDontKnow, onAdvance, onPromptEdit, onAnswerEdit, onSiblingAnswered, onResetCard, onInfo, hintable, onHint, onNearMiss, onTypedPenalty, strictness = DEFAULT_TYPED_STRICTNESS, answerLanguage, autoPlayAudio = true, ipaText, onToggleIPA, softWrongEnabled,
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
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string, issueType?: GradingIssueType, softWrongRecallRating?: Rating) => void
  onRepeat?: () => void
  onIDontKnow?: () => void
  onAdvance?: () => void
  onPromptEdit?: (newText: string) => void
  /** Called when the user double-clicks the displayed answer text to edit the other side of the card. */
  onAnswerEdit?: (newText: string) => void
  /** Called when a deck-sibling answer is detected; the parent should credit that card. */
  onSiblingAnswered?: (siblingCardId: string) => void
  onResetCard?: () => void
  /** Opens the full card info/edit modal from the prompt-card corner. */
  onInfo?: () => void
  /** Whether the "Hint" button is offered (Due Now reviews only, not the pipeline). */
  hintable?: boolean
  /** Called when a hint is revealed, with the cumulative level and the interval-growth dampening factor. */
  onHint?: (level: number, growthFactor: number) => void
  /** Reports whether the answer being submitted was an "almost" (near-miss) so the calibrator can weight it. */
  onNearMiss?: (nearMiss: boolean) => void
  /** Reports the per-category typed penalty on advance: weight (0 / 0.2 / 0.3 / 1) + slip category (for typing_error_marks). */
  onTypedPenalty?: (weight: number, category: TypedErrorCategory | null) => void
  /** Per-pair strictness — decides whether accent/article/spelling slips cost a scheduling penalty. */
  strictness?: TypedStrictness
  /** Called when the user clicks "Add as synonym" on a wrong answer; receives the normalized typed text. */
  onAddSynonym?: (normalizedText: string) => void
  answerLanguage?: string
  autoPlayAudio?: boolean
  /** IPA transcription for the prompt (source language). Shown inside the prompt card when provided. */
  ipaText?: string
  /** Toggles IPA on/off; when provided a faint "IPA" button appears in the prompt card corner. */
  onToggleIPA?: () => void
  /** When true, an accent/article/typo near-miss splits into recall (rated) + typed ('again') tracks. */
  softWrongEnabled?: boolean
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
  const [hintLevel,  setHintLevel]  = useState(0)
  const mainInputRef = useRef<HTMLInputElement>(null)
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
  // Extra synonyms typed in the canonical box before the canonical itself
  const [extraSynonyms,      setExtraSynonyms]      = useState<string[]>([])
  // Synonyms added via "Add as synonym" button — augments the synonyms prop immediately
  const [addedSynonyms,      setAddedSynonyms]      = useState<string[]>([])
  // How many times a sibling was typed in the canonical input before the canonical itself
  const [canonicalLoopCount, setCanonicalLoopCount] = useState(0)
  const [softWrongRecallRating, setSoftWrongRecallRating] = useState<Rating | null>(null)
  const [softWrongOverrideAtRating, setSoftWrongOverrideAtRating] = useState(false)
  const [overrideAsAlmost, setOverrideAsAlmost] = useState(false)
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
    setExtraSynonyms([])
    setAddedSynonyms([])
    setCanonicalLoopCount(0)
    setSoftWrongRecallRating(null)
    setSoftWrongOverrideAtRating(false)
    setOverrideAsAlmost(false)
  }, [card.id])

  // Combines prop synonyms with any added this session so new additions take effect immediately.
  const effectiveSynonyms = [...(synonyms ?? []), ...addedSynonyms]

  // Merge answerLanguage into gradingSettings so article detection is language-aware.
  // The answer side is native when the prompt is front (card.front = learned
  // language, card.back = the learner's native language) — minor spelling
  // slips in the native language aren't the skill being tested, so they're
  // graded leniently rather than flagged as "almost".
  const effectiveGradingSettings: GradingSettings = {
    ...gradingSettings,
    ...(answerLanguage ? { answerLanguage } : {}),
    isNativeAnswer: promptSide === 'front',
  }

  // Auto-play when the prompt IS the source language (e.g. Korean shown, type English).
  useEffect(() => {
    if (autoPlayAudio && promptLanguage) speak(card.front, promptLanguage, card.audioData)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id])

  const prompt   = displayText(promptSide === 'front' ? card.front : card.back)
  const expected = promptSide === 'front' ? card.back  : card.front   // raw — gradeTyping strips quotes internally

  // ── Hint (Due Now only) ────────────────────────────────────────────────────
  const plan = useMemo(() => hintPlan(expected, answerLanguage), [expected, answerLanguage])
  const canHint = !!hintable && plan.maxLevel > 0 && hintLevel < plan.maxLevel
  function useHintPress() {
    const next = hintLevel + 1
    if (next > plan.maxLevel) return
    setInput(plan.levelText[next - 1] ?? '')
    setHintLevel(next)
    onHint?.(next, hintGrowthFactor(next, plan.isShortWord))
    setTimeout(() => {
      const el = mainInputRef.current
      if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n) }
    }, 0)
  }
  const displayExpected = displayText(expected)                        // for showing to the learner

  const finalCorrect = override ?? result?.correct ?? false

  // Soft-wrong: accent/article/typo near-miss with both dual tracks active.
  // override === null: only when user hasn't overridden at all.
  //   override=true  → user said "correct" → no split, treat as fully correct.
  //   override=false → user said "incorrect" → normal wrong flow.
  // overrideAsAlmost: user manually triggered soft-wrong on a correct answer.
  //   In that case override stays null, so this path works correctly.
  const isSoftWrong = !!(
    softWrongEnabled && result && override === null && (
      (result.status === 'almost' && !result.correct && !result.viaOverride) ||
      overrideAsAlmost
    )
  )

  const needsRetype = !!result && !finalCorrect && !isSoftWrong

  const softWrongNeedsRetype  = isSoftWrong && softWrongRecallRating !== null
  // Retype checks use accent-lenient grading: the point is to type the word, not to nail accents again.
  const retypeGradingSettings: GradingSettings = { ...effectiveGradingSettings, ignoreAccents: true }
  const softWrongRetypeCorrect = softWrongNeedsRetype &&
    gradeTyping(retype, expected, retypeGradingSettings).status === 'correct'

  const retypeCorrect = needsRetype &&
    gradeTyping(retype, expected, retypeGradingSettings).status === 'correct'

  const revealedRetypeCorrect = revealed &&
    gradeTyping(retype, expected, retypeGradingSettings).status === 'correct'

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
    if (!needsRetype && !softWrongNeedsRetype) return
    const t = setTimeout(() => retypeRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [needsRetype, softWrongNeedsRetype])

  useEffect(() => {
    if (!revealed) return
    const t = setTimeout(() => retypeRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [revealed])

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

  // Refocus canonical input after a synonym/sibling loop (canonicalLoopCount incremented)
  useEffect(() => {
    if (canonicalLoopCount === 0) return
    const t = setTimeout(() => canonRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [canonicalLoopCount])

  function gradeAndSetResult(typedInput: string, skipSynonymCheck = false) {
    const base = gradeTyping(typedInput, expected, effectiveGradingSettings)
    const viaOverride = base.status !== 'correct' &&
      (overrideAnswers ?? []).includes(base.normalizedUser)
    const viaSynonym  = !skipSynonymCheck && base.status !== 'correct' && !viaOverride &&
      effectiveSynonyms.some(s => gradeTyping(typedInput, s, effectiveGradingSettings).status === 'correct')
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
    // If the input already matches the expected answer directly, grade it as canonical
    // and skip sibling/synonym phases — prevents the word being its own "synonym".
    const directMatch = gradeTyping(input, expected, effectiveGradingSettings)
    if (directMatch.status === 'correct') {
      gradeAndSetResult(input)
      return
    }

    // Check deck siblings first — they require a two-phase flow.
    const matchedSibling = deckSiblings?.find(
      s => gradeTyping(input, s.answer, effectiveGradingSettings).status === 'correct'
    )
    if (matchedSibling) {
      setSiblingId(matchedSibling.id)
      setSiblingText(input)
      onSiblingAnswered?.(matchedSibling.id)
      return
    }
    // Synonyms: two-phase canonical flow only when typing the target language
    // (promptSide='back' = native language shown, type target/Korean).
    // When typing the native language (promptSide='front'), accept synonyms directly
    // via gradeAndSetResult's viaSynonym path — no need to also type the canonical.
    if (effectiveSynonyms.length > 0 && promptSide === 'back') {
      const matchedSynonym = effectiveSynonyms.find(
        s => gradeTyping(input, s, effectiveGradingSettings).status === 'correct'
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
    // Exact canonical → success
    if (gradeTyping(canonInput, expected, effectiveGradingSettings).status === 'correct') {
      gradeAndSetResult(canonInput, true)
      return
    }
    // Another sibling card → credit the sibling and keep asking for the canonical
    const matchedSibling = deckSiblings?.find(
      s => gradeTyping(canonInput, s.answer, effectiveGradingSettings).status === 'correct'
    )
    if (matchedSibling) {
      onSiblingAnswered?.(matchedSibling.id)
      setExtraSynonyms(prev => [...prev, canonInput])
      setCanonicalLoopCount(c => c + 1)
      setCanonInput('')
      return
    }
    // Another synonym string → show it as an extra box and keep asking for the canonical
    if (effectiveSynonyms.some(s => gradeTyping(canonInput, s, effectiveGradingSettings).status === 'correct')) {
      setExtraSynonyms(prev => [...prev, canonInput])
      setCanonInput('')
      return
    }
    // Wrong answer → fail
    gradeAndSetResult(canonInput, true)
  }

  const inCanonicalPhase = synonymPhase || !!siblingId

  // Per-category penalty for a wrong typed answer. Detection runs in flexible mode
  // with the ignore-toggles OFF so accent/article/typo slips surface as an "almost"
  // regardless of the deck's grading mode; the pair strictness then decides the cost.
  function computeTypedPenalty(answered: string) {
    const detectionSettings: GradingSettings = {
      ...effectiveGradingSettings,
      gradingMode: 'flexible',
      ignoreAccents: false,
      ignoreDefiniteArticles: false,
      ignoreMinorTypos: false,
    }
    return resolveTypedPenalty(gradeTyping(answered, expected, detectionSettings), strictness)
  }

  // Display penalty (only meaningful mid-retype on a graded review) — drives the
  // "Accent — retype it (no penalty)" vs "…(30% penalty)" copy and colour.
  const retypePenalty = (gradedReview && result && !finalCorrect && override !== true)
    ? computeTypedPenalty(inCanonicalPhase ? canonInput : input)
    : null

  function reportNearMiss() {
    onNearMiss?.(!!result && result.status === 'almost' && override !== true)
  }

  function advanceRetype() {
    if (!retypeCorrect) return
    const answered = inCanonicalPhase ? canonInput : input
    const penalty = computeTypedPenalty(answered)
    // Graded (Due Now) reviews: an accepted slip (accent/article/spelling per the
    // pair's strictness) counts as CORRECT with a weighted penalty — no lapse — while
    // still requiring the retype. Full wrong answers (and all pre-graduation typing)
    // keep the old "again" behaviour.
    if (gradedReview && penalty.accepted) {
      onTypedPenalty?.(penalty.weight, penalty.category)
      reportNearMiss()
      onRate('good', true, answered, result?.issueType)
    } else {
      onTypedPenalty?.(1, penalty.category)
      reportNearMiss()
      onRate('again', false, answered, result?.issueType)
    }
  }

  function advanceSoftWrong() {
    if (!softWrongRetypeCorrect || !softWrongRecallRating) return
    const userAns = inCanonicalPhase ? canonInput : input
    onTypedPenalty?.(0.2, null)
    reportNearMiss()
    if (softWrongOverrideAtRating) {
      // Override was active: both tracks get the recall rating
      onRate(softWrongRecallRating, true, userAns, result?.issueType, undefined)
    } else {
      // Normal split: typed gets 'again', recall gets the user's rating
      onRate('again', false, userAns, result?.issueType, softWrongRecallRating)
    }
  }

  function tryAdvance(rating: Rating) {
    onTypedPenalty?.(0, null)
    reportNearMiss()
    onRate(rating, finalCorrect, inCanonicalPhase ? canonInput : input, result?.issueType)
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
            {!result && !revealed && onIDontKnow && (
              <button
                onClick={() => { onIDontKnow(); setRevealed(true) }}
                title="I don't know"
                className="absolute bottom-3 right-3 text-lg text-danger/70 hover:text-danger transition-colors leading-none"
              >
                ?
              </button>
            )}
            {onInfo && <CardInfoButton onClick={onInfo} />}
            {gradedReview && onResetCard && (
              <button
                onClick={() => setResetConfirm(true)}
                title="Reset card to learning pipeline"
                className="absolute top-3 left-3 text-xs text-ink-faint hover:text-ink-muted transition-colors leading-none w-5 h-5 flex items-center justify-center rounded-full border border-white/10 hover:border-white/20"
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
            <p className="text-center text-sm text-ink-muted">
              Answer: <EditableAnswerText text={displayExpected} onEdit={t => onAnswerEdit?.(t)} />
            </p>
            <input
              ref={retypeRef}
              className={`input text-center text-lg font-mono ${revealedRetypeCorrect ? 'border-success/60 bg-success/5' : ''}`}
              placeholder="Type the answer to continue…"
              value={retype}
              onChange={e => setRetype(e.target.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onKeyDown={e => { if (e.key === 'Enter' && !composing && revealedRetypeCorrect) onAdvance?.() }}
            />
            {revealedRetypeCorrect && (
              <div className="flex justify-center">
                <button onClick={onAdvance} className="btn-primary px-10">Continue</button>
              </div>
            )}
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
          ref={mainInputRef}
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

        {/* Extra synonym/sibling boxes (shown as stacked disabled amber inputs) */}
        {(synonymPhase || siblingId) && !result && extraSynonyms.map((s, i) => (
          <input
            key={i}
            className="input text-center text-lg font-mono border-warning/60 bg-warning/5"
            value={s}
            readOnly
            disabled
          />
        ))}

        {/* Sibling phase: success note + canonical input */}
        {siblingId && !result && (
          <div className="space-y-3">
            <div className="panel border-success/30 bg-success/5 text-center py-3 space-y-1">
              <p className="text-success font-medium">
                {extraSynonyms.length > 0 ? 'That\'s another form!' : 'Correct! Also in your deck'}
              </p>
              <p className="text-xs text-ink-muted">
                {extraSynonyms.length > 0 ? 'Now type the main answer for this card:' : 'Now type the answer for this specific card:'}
              </p>
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
              <p className="text-warning font-medium">
                {extraSynonyms.length > 0 ? 'That\'s another synonym!' : 'Synonym accepted!'}
              </p>
              <p className="text-xs text-ink-muted">Now type the main term to continue:</p>
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
            {canHint && (
              <button onClick={useHintPress} className="btn-ghost" title="Reveal the start of the answer (reduces interval growth)">Hint</button>
            )}
            <button onClick={check} disabled={!input.trim()} className="btn-primary">Check</button>
          </div>
        ) : result ? (
          <div className="space-y-4">
            {/* Result panel */}
            <div className={`panel text-center py-3 ${feedbackClass}`}>
              {isSoftWrong ? (
                <div className="space-y-1">
                  <p className="text-warning font-medium">
                    {result.issueType === 'accent' ? 'Accent error' :
                     result.issueType === 'article' ? 'Article error' :
                     'Minor spelling error'}
                  </p>
                  <p className="text-ink-muted text-sm">
                    Answer: <EditableAnswerText text={displayExpected} onEdit={t => onAnswerEdit?.(t)} />
                  </p>
                </div>
              ) : finalCorrect ? (
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
                  {!result.viaSynonym &&
                    (synonymPhase ? canonInput : input).trim() !== displayExpected.trim() && (
                    <p className="text-xs text-ink-muted">
                      Card says: <EditableAnswerText text={displayExpected} onEdit={t => onAnswerEdit?.(t)} />
                    </p>
                  )}
                </div>
              ) : result.status === 'almost' && override !== false ? (
                <div className="space-y-1">
                  <p className="text-warning font-medium">Almost!</p>
                  {result.reason && <p className="text-ink-muted text-sm">{result.reason}</p>}
                  <p className="text-ink-muted text-sm">
                    Answer: <EditableAnswerText text={displayExpected} onEdit={t => onAnswerEdit?.(t)} />
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-danger font-medium">
                    Not quite
                    {override === false && <span className="text-ink-faint font-normal"> (marked wrong)</span>}
                  </p>
                  <p className="text-ink-muted text-sm">
                    Answer: <EditableAnswerText text={displayExpected} onEdit={t => onAnswerEdit?.(t)} />
                  </p>
                </div>
              )}
            </div>

            {retypePenalty && retypePenalty.category && retypePenalty.accepted && (
              <p className={`text-sm text-center ${retypePenalty.weight > 0 ? 'text-warning' : 'text-success'}`}>
                {retypePenalty.category === 'spelling' ? 'Spelling' : retypePenalty.category === 'accent' ? 'Accent' : 'Article'} error
              </p>
            )}

            {isSoftWrong ? (
              <>
                {/* Soft-wrong: override controls (only before recall rating is selected) */}
                {!softWrongRecallRating && (
                  <div className="flex items-center justify-center gap-3">
                    {override !== true && (
                      <button onClick={() => setOverrideAndPersist(true)} className="text-xs text-ink-faint hover:text-success transition-colors">
                        Override as correct
                      </button>
                    )}
                    <button onClick={() => { setOverrideAsAlmost(false); setOverride(false) }} className="text-xs text-ink-faint hover:text-danger transition-colors">
                      Override as incorrect
                    </button>
                    {(overrideAsAlmost || override !== null) && (
                      <button onClick={() => { setOverrideAsAlmost(false); setOverrideAndPersist(null) }} className="text-xs text-ink-faint hover:text-ink-muted transition-colors">
                        Undo
                      </button>
                    )}
                  </div>
                )}

                {/* Soft-wrong step 1: rate recall before retyping */}
                {!softWrongRecallRating && (
                  <RatingButtons
                    onRate={r => { setSoftWrongRecallRating(r); setSoftWrongOverrideAtRating(override === true) }}
                    suggestedRating="good"
                  />
                )}

                {/* Soft-wrong step 2: retype to confirm */}
                {softWrongNeedsRetype && (
                  <div className="space-y-2">
                    <p className="text-xs text-ink-muted text-center">Type the correct answer to continue:</p>
                    <input
                      ref={retypeRef}
                      className={`input text-center text-lg font-mono ${softWrongRetypeCorrect ? 'border-success/60 bg-success/5' : ''}`}
                      placeholder="Retype the answer…"
                      value={retype}
                      onChange={e => setRetype(e.target.value)}
                      onCompositionStart={() => setComposing(true)}
                      onCompositionEnd={() => setComposing(false)}
                      onKeyDown={e => { if (e.key === 'Enter' && !composing) advanceSoftWrong() }}
                    />
                    {softWrongRetypeCorrect && (
                      <div className="flex justify-center">
                        <button onClick={advanceSoftWrong} className="btn-primary px-10">Continue</button>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Override controls */}
                <div className="flex items-center justify-center gap-3">
                  {result.correct && override !== false && (
                    <button onClick={() => setOverrideAndPersist(false)} className="text-xs text-ink-faint hover:text-danger transition-colors">
                      Override as incorrect
                    </button>
                  )}
                  {result.correct && override !== false && softWrongEnabled && (
                    <button onClick={() => setOverrideAsAlmost(true)} className="text-xs text-ink-faint hover:text-warning transition-colors">
                      Override as almost
                    </button>
                  )}
                  {!result.correct && override !== true && (
                    <button onClick={() => setOverrideAndPersist(true)} className="text-xs text-ink-faint hover:text-success transition-colors">
                      Override as correct
                    </button>
                  )}
                  {!result.correct && override !== true && promptSide === 'back' && onAddSynonym && (
                    <button
                      onClick={() => {
                        onAddSynonym(result.normalizedUser)
                        setAddedSynonyms(prev => [...prev, result.normalizedUser])
                        setSynonymPhase(true)
                        setSynonymPhaseText(input)
                        setResult(null)
                        setCanonInput('')
                      }}
                      className="text-xs text-ink-faint hover:text-warning transition-colors"
                    >
                      Add as synonym
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
              </>
            )}
          </div>
        ) : null}
        </>
        )}
      </div>
    </div>
  )
}
