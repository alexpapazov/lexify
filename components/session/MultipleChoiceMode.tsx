'use client'

import { useEffect, useState } from 'react'
import type { Card, CardChoices, CardSide, Rating } from '@/domain'
import { buildOptions, ensureChoicesGenerated, needsChoices } from '@/lib/distractors'

/**
 * Multiple-choice recall, used for pre-graduation "recognition" steps.
 * Shows the prompt plus 4 options (1 correct + up to 3 distractors,
 * AI-generated and cached per card, or deck-based fallback). Selecting an
 * option gives immediate color-coded feedback, then waits for the learner
 * to press Continue (or hit Enter, since the Continue button is
 * auto-focused) before advancing — no auto-advance.
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
  // Show options immediately — cached AI choices if there are enough,
  // otherwise sibling-card values from the deck as a temporary stand-in.
  const [choices,  setChoices]  = useState<string[]>(() => buildOptions(card, answerSide, deckCards))
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    setChoices(buildOptions(card, answerSide, deckCards))
    setSelected(null)

    // If we're still relying on the deck-based fallback, try to generate and
    // permanently cache real AI distractors in the background. This doesn't
    // affect the options already shown for this card — it just means future
    // visits to this card will use the AI-generated choices.
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

  const prompt  = promptSide === 'front' ? card.front : card.back
  const correct = answerSide === 'front' ? card.front : card.back

  function choose(choice: string) {
    if (selected) return
    setSelected(choice)
  }

  function continueNext() {
    if (!selected) return
    const wasCorrect = selected.trim().toLowerCase() === correct.trim().toLowerCase()
    onRate(wasCorrect ? 'good' : 'again', wasCorrect, selected)
  }

  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
      <div className="panel min-h-[120px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{prompt}</p>
      </div>
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
      {selected && (
        <div className="flex justify-center">
          {/* Auto-focused so pressing Enter continues. */}
          <button onClick={continueNext} autoFocus className="btn-primary px-10">
            Continue
          </button>
        </div>
      )}
    </div>
  )
}
