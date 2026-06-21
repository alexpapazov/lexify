'use client'

import { useEffect, useState } from 'react'
import type { Card, CardChoices, CardSide, Rating } from '@/domain'
import { buildOptions, ensureChoicesGenerated, needsChoices } from '@/lib/distractors'
import { speak } from '@/lib/speak'

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
export function MultipleChoiceMode({ card, promptSide, answerSide, deckCards, sourceLanguage, targetLanguage, deckName, onChoicesCached, onRate, onIDontKnow, onAdvance }: {
  card:           Card
  promptSide:     CardSide
  answerSide:     CardSide
  deckCards:      Card[]
  sourceLanguage: string
  targetLanguage: string
  deckName?:      string
  /** Called when AI generation produced a new choices pool, so the caller can cache it locally too. */
  onChoicesCached?: (cardId: string, choices: CardChoices) => void
  onRate: (r: Rating, wasCorrect: boolean, userAnswer: string) => void
  /** Called when the learner pressed "?" — parent applies a heavy penalty behind the scenes. */
  onIDontKnow?: () => void
  /** Called when Continue is pressed after "?" revealed the answer (penalty already applied via onIDontKnow). */
  onAdvance?: () => void
}) {
  const [choices,   setChoices]   = useState<string[]>(() => buildOptions(card, answerSide, deckCards))
  const [selected,  setSelected]  = useState<string | null>(null)
  const [viaSynonym, setViaSynonym] = useState(false)
  const [revealed,  setRevealed]  = useState(false)

  useEffect(() => {
    setChoices(buildOptions(card, answerSide, deckCards))
    setSelected(null)
    setViaSynonym(false)
    setRevealed(false)

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

  const prompt   = promptSide  === 'front' ? card.front : card.back
  const correct  = answerSide  === 'front' ? card.front : card.back
  const synonyms = (answerSide === 'front' ? card.choices?.frontSynonyms : card.choices?.backSynonyms) ?? []

  function norm(s: string) { return s.trim().toLowerCase() }

  function isSynonym(choice: string): boolean {
    return synonyms.some(s => norm(s) === norm(choice))
  }

  function choose(choice: string) {
    if (selected) return
    setSelected(choice)
    const isExactMatch = norm(choice) === norm(correct)
    setViaSynonym(!isExactMatch && isSynonym(choice))
  }

  function continueNext() {
    if (!selected) return
    const isExactMatch  = norm(selected) === norm(correct)
    const isSyn         = !isExactMatch && isSynonym(selected)
    const wasCorrect    = isExactMatch || isSyn
    onRate(wasCorrect ? 'good' : 'again', wasCorrect, selected)
  }

  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
      <div className="panel relative min-h-[120px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{prompt}</p>
        <button
          onClick={() => speak(prompt, promptSide === 'front' ? sourceLanguage : targetLanguage)}
          title="Listen"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 text-danger/70 hover:text-danger transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
            <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 0 0 1.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06ZM18.584 5.106a.75.75 0 0 1 1.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 0 1-1.06-1.06 8.25 8.25 0 0 0 0-11.668.75.75 0 0 1 0-1.06Z" />
            <path d="M15.932 7.757a.75.75 0 0 1 1.061 0 6 6 0 0 1 0 8.486.75.75 0 0 1-1.06-1.061 4.5 4.5 0 0 0 0-6.364.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
        {!selected && !revealed && onIDontKnow && (
          <button
            onClick={() => { onIDontKnow(); setRevealed(true); setSelected(correct) }}
            title="I don't know"
            className="absolute bottom-3 right-3 text-lg text-danger/70 hover:text-danger transition-colors leading-none"
          >
            ?
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {choices.map(choice => {
          const isCorrect  = norm(choice) === norm(correct)
          const isSelected = choice === selected
          const isSyn      = !isCorrect && isSynonym(choice)
          let style = 'border-white/10 hover:border-accent/40 hover:bg-surface-raised/50 text-ink'
          if (selected) {
            if (isCorrect)        style = 'border-success/60 bg-success/10 text-success'
            else if (isSyn && isSelected) style = 'border-warning/60 bg-warning/10 text-warning'
            else if (isSyn)       style = 'border-warning/30 bg-warning/5 text-warning/60 opacity-60'
            else if (isSelected)  style = 'border-danger/60 bg-danger/10 text-danger'
            else                  style = 'border-white/5 text-ink-faint opacity-50'
          }
          return (
            <button key={choice} onClick={() => choose(choice)} disabled={!!selected}
              className={`panel text-left py-4 px-5 transition-colors text-base ${style}`}>
              {choice}
            </button>
          )
        })}
      </div>

      {selected && viaSynonym && (
        <p className="text-xs text-center text-warning/80">Also accepted — this is a synonym of the correct answer.</p>
      )}

      {selected && (
        <div className="flex justify-center">
          <button onClick={revealed ? onAdvance : continueNext} autoFocus className="btn-primary px-10">
            Continue
          </button>
        </div>
      )}
    </div>
  )
}
