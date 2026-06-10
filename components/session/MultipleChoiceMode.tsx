'use client'

import { useEffect, useState } from 'react'
import type { Card, CardChoices, CardSide, Rating } from '@/domain'
import { getMultipleChoiceOptions } from '@/lib/distractors'

const FEEDBACK_MS = 650

/**
 * Multiple-choice recall, used for pre-graduation "recognition" steps.
 * Shows the prompt plus 4 options (1 correct + up to 3 distractors,
 * AI-generated and cached per card, or deck-based fallback). Selecting an
 * option gives immediate color-coded feedback, then auto-advances —
 * no rating buttons.
 */
export function MultipleChoiceMode({ card, promptSide, answerSide, deckCards, sourceLanguage, targetLanguage, deckName, onChoicesCached, onRate }: {
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
}) {
  const [choices,  setChoices]  = useState<string[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setChoices(null)
    setSelected(null)
    getMultipleChoiceOptions(card, answerSide, deckCards, sourceLanguage, targetLanguage)
      .then(({ options, cachedChoices }) => {
        if (cancelled) return
        setChoices(options)
        if (cachedChoices) onChoicesCached?.(card.id, cachedChoices)
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id])

  const prompt  = promptSide === 'front' ? card.front : card.back
  const correct = answerSide === 'front' ? card.front : card.back

  function choose(choice: string) {
    if (selected) return
    setSelected(choice)
    const wasCorrect = choice.trim().toLowerCase() === correct.trim().toLowerCase()
    setTimeout(() => onRate(wasCorrect ? 'good' : 'again', wasCorrect, choice), FEEDBACK_MS)
  }

  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
      <div className="panel min-h-[120px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{prompt}</p>
      </div>
      {!choices ? (
        <div className="text-center text-ink-muted text-sm py-8">Loading choices…</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {choices.map(choice => {
            const isCorrect  = choice.trim().toLowerCase() === correct.trim().toLowerCase()
            const isSelected = choice === selected
            let style = 'border-white/10 hover:border-accent/40 hover:bg-surface-raised/50 text-ink'
            if (selected) {
              if (isCorrect)       style = 'border-success/60 bg-success/10 text-success'
              else if (isSelected) style = 'border-danger/60 bg-danger/10 text-danger'
              else                 style = 'border-white/5 text-ink-faint opacity-50'
            }
            return (
              <button key={choice} onClick={() => choose(choice)} disabled={!!selected}
                className={`panel text-left py-4 px-5 transition-colors text-base ${style}`}>
                {choice}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
