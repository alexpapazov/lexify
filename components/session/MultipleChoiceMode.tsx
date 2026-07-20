'use client'

import { useEffect, useRef, useState } from 'react'
import type { Card, CardChoices, CardSide, Rating } from '@/domain'
import { buildOptions, ensureChoicesGenerated, needsChoices } from '@/lib/distractors'
import { speakCard } from '@/lib/speak'
import { displayText, isQuoted } from '@/lib/cardText'
import { EditablePromptPanel } from './EditablePromptPanel'
import { CardInfoButton } from './CardInfoButton'

/**
 * Multiple-choice recall, used for pre-graduation "recognition" steps.
 * Shows the prompt plus 4 options (1 correct + up to 3 distractors,
 * AI-generated and cached per card, or deck-based fallback). Selecting an
 * option gives immediate color-coded feedback, then waits for the learner
 * to press Continue (or hit Enter, since the Continue button is
 * auto-focused) before advancing — no auto-advance.
 *
 * An "I don't know" button appears before a choice is made. Pressing it
 * counts as a heavy penalty (3 agains) handled by the parent. A synonym
 * of the correct answer is accepted as correct and shown in amber.
 */
export function MultipleChoiceMode({ card, promptSide, answerSide, deckCards, sourceLanguage, targetLanguage, deckName, excludeAnswerTexts, splitGlossFromBack, onChoicesCached, onRate, onIDontKnow, onAdvance, onRepeat, onPromptEdit, onChoiceEdit, onInfo, overrideAnswers, onOverrideAnswer, autoPlayAudio = true, ipaText, onToggleIPA }: {
  card:           Card
  promptSide:     CardSide
  answerSide:     CardSide
  deckCards:      Card[]
  sourceLanguage: string
  targetLanguage: string
  deckName?:      string
  /**
   * For synonym-group cards at stage 1 (native→target): fronts of other
   * group members that are ALSO correct — they must not appear as distractors.
   */
  excludeAnswerTexts?: string[]
  /**
   * For synonym-group cards at stages 0 & 4 (target→native): when true,
   * the correct answer displayed in choices is one randomly chosen word from
   * card.back split by comma (e.g. "still, yet" → "still" or "yet"),
   * rather than the full gloss string.
   */
  splitGlossFromBack?: boolean
  /** Called when AI generation produced a new choices pool, so the caller can cache it locally too. */
  onChoicesCached?: (cardId: string, choices: CardChoices) => void
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string) => void
  /** Called when the learner pressed "?" — parent applies a heavy penalty behind the scenes. */
  onIDontKnow?: () => void
  /** Called when Continue is pressed after "?" revealed the answer (penalty already applied via onIDontKnow). */
  onAdvance?: () => void
  /** When provided, a Repeat button appears after a correct answer so the learner can practice the step once more. */
  onRepeat?: () => void
  /** Double-click-to-edit on the prompt panel. newText='' means delete the card. */
  onPromptEdit?: (newText: string) => void
  /** Opens the full card info/edit modal from the prompt-card corner. */
  onInfo?: () => void
  /**
   * Double-click-to-edit on a choice. originalChoice = the current text,
   * newText = edited value ('' means delete distractor), isCorrect = whether it's the right answer.
   */
  onChoiceEdit?: (originalChoice: string, newText: string, isCorrect: boolean) => Promise<void>
  /** Normalized choice texts that have been previously overridden as correct for this card/side. */
  overrideAnswers?: string[]
  /** Called when the learner manually marks a choice correct or incorrect. Receives the normalized choice text. */
  onOverrideAnswer?: (normalizedChoice: string, accept: boolean) => void
  /** When false, suppresses automatic audio playback; the manual speaker button still works. */
  autoPlayAudio?: boolean
  /** IPA transcription for the prompt (source language). Shown inside the prompt card when provided. */
  ipaText?: string
  /** Toggles IPA on/off; when provided a faint "IPA" button appears in the prompt card corner. */
  onToggleIPA?: () => void
}) {
  const correct  = displayText(answerSide === 'front' ? card.front : card.back)

  // Pick one gloss word randomly on mount (stable for this card show via key remount).
  const [glossWord] = useState<string | null>(() => {
    if (!splitGlossFromBack || isQuoted(card.back)) return null
    const words = card.back.split(/[,/]/).map(w => w.trim()).filter(Boolean)
    if (words.length <= 1) return null
    return words[Math.floor(Math.random() * words.length)] ?? null
  })
  const displayCorrect = glossWord ?? correct

  const [choices,   setChoices]   = useState<string[]>(() => {
    const opts = buildOptions(card, answerSide, deckCards, excludeAnswerTexts)
    if (glossWord && norm(glossWord) !== norm(correct)) {
      return opts.map(o => norm(o) === norm(correct) ? glossWord : o)
    }
    return opts
  })
  const [selected,  setSelected]  = useState<string | null>(null)
  const [viaSynonym, setViaSynonym] = useState(false)
  const [revealed,  setRevealed]  = useState(false)
  const [override,  setOverride]  = useState<boolean | null>(null)

  // Inline choice editing (double-click)
  const [editingChoice, setEditingChoice] = useState<string | null>(null)
  const [editValue,     setEditValue]     = useState('')
  const [editSaving,    setEditSaving]    = useState(false)
  const editInputRef   = useRef<HTMLInputElement>(null)
  // Timer to distinguish single click (choose) from double click (edit)
  const clickTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const opts = buildOptions(card, answerSide, deckCards, excludeAnswerTexts)
    if (glossWord && norm(glossWord) !== norm(correct)) {
      setChoices(opts.map(o => norm(o) === norm(correct) ? glossWord : o))
    } else {
      setChoices(opts)
    }
    setSelected(null)
    setViaSynonym(false)
    setRevealed(false)
    setOverride(null)

    // Auto-play when source language is shown as the prompt (e.g. Korean on front).
    if (autoPlayAudio && promptSide === 'front') speakCard(card, sourceLanguage)

    if (!needsChoices(card, answerSide)) return
    let cancelled = false
    ensureChoicesGenerated(card, answerSide, deckCards, sourceLanguage, targetLanguage)
      .then(aiChoices => {
        if (cancelled || !aiChoices) return
        onChoicesCached?.(card.id, aiChoices)
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id])

  const prompt   = displayText(promptSide === 'front' ? card.front : card.back)
  const synonyms = (answerSide === 'front' ? card.choices?.frontSynonyms : card.choices?.backSynonyms) ?? []

  function norm(s: string) { return s.trim().toLowerCase() }

  function isSynonym(choice: string): boolean {
    return synonyms.some(s => norm(s) === norm(choice))
  }

  function choose(choice: string) {
    if (selected) return
    setSelected(choice)
    const isExactMatch = norm(choice) === norm(displayCorrect)
    setViaSynonym(!isExactMatch && isSynonym(choice))
    // Play the card's target word aloud on selection, whichever direction this rung is.
    if (autoPlayAudio) speakCard(card, sourceLanguage)
  }

  function continueNext() {
    if (!selected) return
    const isExactMatch   = norm(selected) === norm(displayCorrect)
    const isSyn          = !isExactMatch && isSynonym(selected)
    const isViaOverride  = !isExactMatch && !isSyn && (overrideAnswers ?? []).some(o => o === norm(selected))
    const naturalCorrect = isExactMatch || isSyn || isViaOverride
    const wasCorrect     = override !== null ? override : naturalCorrect
    onRate(wasCorrect ? 'good' : 'again', wasCorrect, selected)
  }

  function setOverrideAndPersist(next: boolean | null) {
    if (selected) {
      const normalizedChoice = norm(selected)
      const isExactMatch = normalizedChoice === norm(displayCorrect)
      const isSyn = !isExactMatch && isSynonym(selected)
      const isViaOvr = !isExactMatch && !isSyn && (overrideAnswers ?? []).some(o => o === normalizedChoice)
      if (next === true && override !== true) {
        onOverrideAnswer?.(normalizedChoice, true)
      } else if (next === false && override !== false) {
        if (isViaOvr) onOverrideAnswer?.(normalizedChoice, false)
      } else if (next === null) {
        if (override === true) onOverrideAnswer?.(normalizedChoice, false)
        else if (override === false && isViaOvr) onOverrideAnswer?.(normalizedChoice, true)
      }
    }
    setOverride(next)
  }

  function handleChoiceClick(choice: string) {
    if (!onChoiceEdit) { choose(choice); return }
    if (editingChoice) return
    // Delay single-click action so a double-click can cancel it
    clickTimerRef.current = setTimeout(() => { clickTimerRef.current = null; choose(choice) }, 220)
  }

  function handleChoiceDoubleClick(choice: string) {
    if (!onChoiceEdit) return
    if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null }
    setEditingChoice(choice)
    setEditValue(choice)
    setTimeout(() => editInputRef.current?.select(), 0)
  }

  async function commitEditChoice() {
    if (!editingChoice || editSaving) return
    const isCorrect = norm(editingChoice) === norm(displayCorrect)
    const trimmed = editValue.trim()
    if (trimmed === editingChoice) { setEditingChoice(null); return }
    setEditSaving(true)
    try {
      await onChoiceEdit?.(editingChoice, trimmed, isCorrect)
      if (isCorrect) {
        // Replace the old correct answer text in the choices list so it matches the new displayCorrect
        if (trimmed) setChoices(prev => prev.map(c => c === editingChoice ? trimmed : c))
        setSelected(null)
        setViaSynonym(false)
      } else {
        setChoices(prev => {
          if (!trimmed) return prev.filter(c => c !== editingChoice)
          return prev.map(c => c === editingChoice ? trimmed : c)
        })
      }
    } finally {
      setEditSaving(false)
      setEditingChoice(null)
    }
  }

  return (
    <div className="space-y-6 w-full max-w-[850px] mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
      <div className="panel relative min-h-[120px] flex items-center justify-center text-center">
        {onInfo && <CardInfoButton onClick={onInfo} />}
        <EditablePromptPanel text={prompt} onEdit={t => onPromptEdit?.(t)} />
        {promptSide === 'front' && (
          <button
            onClick={() => speakCard(card, sourceLanguage)}
            title="Listen"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 text-ink-faint hover:text-ink-muted transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 0 0 1.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06ZM18.584 5.106a.75.75 0 0 1 1.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 0 1-1.06-1.06 8.25 8.25 0 0 0 0-11.668.75.75 0 0 1 0-1.06Z" />
              <path d="M15.932 7.757a.75.75 0 0 1 1.061 0 6 6 0 0 1 0 8.486.75.75 0 0 1-1.06-1.061 4.5 4.5 0 0 0 0-6.364.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        )}
        {!selected && !revealed && onIDontKnow && (
          <button
            onClick={() => { onIDontKnow(); setRevealed(true); setSelected(displayCorrect) }}
            title="I don't know"
            className="absolute bottom-3 right-3 text-lg text-danger/70 hover:text-danger transition-colors leading-none"
          >
            ?
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
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {choices.map(choice => {
          const isCorrect    = norm(choice) === norm(displayCorrect)
          const isSelected   = choice === selected
          const isSyn        = !isCorrect && isSynonym(choice)
          const isViaOvr     = isSelected && !isCorrect && !isSyn && (overrideAnswers ?? []).some(o => o === norm(choice))
          const isEditing    = editingChoice === choice
          let style = 'border-line/10 hover:border-accent/40 hover:bg-surface-raised/50 text-ink'
          if (selected) {
            if (isCorrect)           style = 'border-success/60 bg-success/10 text-success'
            else if (isSyn && isSelected) style = 'border-warning/60 bg-warning/10 text-warning'
            else if (isSyn)          style = 'border-warning/30 bg-warning/5 text-warning/60 opacity-60'
            else if (isViaOvr)       style = 'border-warning/60 bg-warning/10 text-warning'
            else if (isSelected)     style = 'border-danger/60 bg-danger/10 text-danger'
            else                     style = 'border-line/5 text-ink-faint opacity-50'
          }
          if (isEditing) style = 'border-accent/60 bg-surface-raised'
          return (
            <div
              key={choice}
              className={`panel py-4 px-5 transition-colors text-base ${style} ${!isEditing ? 'cursor-pointer' : ''}`}
              onClick={() => !isEditing && handleChoiceClick(choice)}
              onDoubleClick={() => handleChoiceDoubleClick(choice)}
              title={onChoiceEdit && !isEditing ? 'Double-click to edit' : undefined}
            >
              {isEditing ? (
                <input
                  ref={editInputRef}
                  className="w-full bg-transparent outline-none text-ink text-base"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitEditChoice() }
                    if (e.key === 'Escape') { setEditingChoice(null) }
                  }}
                  onBlur={() => { void commitEditChoice() }}
                  disabled={editSaving}
                  placeholder={isCorrect ? 'Edit answer…' : 'Edit distractor… (clear to remove)'}
                  autoFocus
                />
              ) : (
                choice
              )}
            </div>
          )
        })}
      </div>

      {selected && viaSynonym && (
        <p className="text-xs text-center text-warning/80">Also accepted — this is a synonym of the correct answer.</p>
      )}

      {selected && (() => {
        const normalizedSelected = norm(selected)
        const isExactMatch  = normalizedSelected === norm(displayCorrect)
        const isSyn         = !isExactMatch && isSynonym(selected)
        const isViaOvr      = !isExactMatch && !isSyn && (overrideAnswers ?? []).some(o => o === normalizedSelected)
        const naturalCorrect = isExactMatch || isSyn || isViaOvr
        const finalCorrect   = override !== null ? override : naturalCorrect
        return (
          <div className="space-y-3">
            {isViaOvr && override === null && (
              <p className="text-xs text-center text-warning/80">Also accepted — remembered override.</p>
            )}
            {onOverrideAnswer && (
              <div className="flex items-center justify-center gap-3">
                {naturalCorrect && override !== false && (
                  <button onClick={() => setOverrideAndPersist(false)} className="text-xs text-ink-faint hover:text-danger transition-colors">
                    Override as incorrect
                  </button>
                )}
                {!naturalCorrect && override !== true && (
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
            )}
            <div className="flex justify-center gap-3">
              {!revealed && onRepeat && finalCorrect && (
                <button
                  onClick={() => { setSelected(null); setViaSynonym(false); setOverride(null); onRepeat() }}
                  className="btn-ghost px-6"
                >
                  Repeat
                </button>
              )}
              <button onClick={revealed ? onAdvance : continueNext} autoFocus className="btn-primary px-10">
                Continue
              </button>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
