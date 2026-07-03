'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Card, Rating } from '@/domain'
import { displayText } from '@/lib/cardText'
import { hintPlan, hintGrowthFactor } from '@/lib/hints'
import { RatingButtons } from './RatingButtons'
import { EditablePromptPanel } from './EditablePromptPanel'
import { CardInfoButton } from './CardInfoButton'

/**
 * Flip-card recall, used for post-graduation "recognition" reviews
 * (rare — only if a custom pipeline ends on a recognition step).
 * Shows Again/Hard/Good/Easy once the answer is revealed.
 */
export function FlashcardMode({ card, promptSide, deckName, onRate, onPromptEdit, onInfo, hintable, onHint, answerLanguage }: {
  card: Card; promptSide: 'front' | 'back'; deckName?: string; onRate: (r: Rating) => void
  onPromptEdit?: (newText: string) => void
  onInfo?: () => void
  /** Whether the "Hint" button is offered (Due Now reviews only). */
  hintable?: boolean
  onHint?: (level: number, growthFactor: number) => void
  answerLanguage?: string
}) {
  const [revealed, setRevealed] = useState(false)
  // Set when the learner revealed via "Don't know" (a self-declared miss):
  // show the answer + Continue instead of the self-rating buttons.
  const [dontKnow, setDontKnow] = useState(false)
  const [hintLevel, setHintLevel] = useState(0)
  useEffect(() => { setRevealed(false); setDontKnow(false); setHintLevel(0) }, [card.id])
  const prompt = displayText(promptSide === 'front' ? card.front : card.back)
  const answer = displayText(promptSide === 'front' ? card.back  : card.front)
  const rawAnswer = promptSide === 'front' ? card.back : card.front

  const plan = useMemo(() => hintPlan(rawAnswer, answerLanguage), [rawAnswer, answerLanguage])
  const canHint = !!hintable && plan.maxLevel > 0 && hintLevel < plan.maxLevel
  function useHintPress() {
    const next = hintLevel + 1
    if (next > plan.maxLevel) return
    setHintLevel(next)
    onHint?.(next, hintGrowthFactor(next, plan.isShortWord))
  }
  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
      <div className="panel relative min-h-[160px] flex items-center justify-center text-center">
        {onInfo && <CardInfoButton onClick={onInfo} />}
        {onPromptEdit
          ? <EditablePromptPanel text={prompt} onEdit={t => onPromptEdit(t)} />
          : <p className="text-2xl font-medium text-ink">{prompt}</p>}
      </div>
      {!revealed ? (
        <div className="flex flex-col items-center gap-3">
          {hintLevel > 0 && (
            <p className="text-xl font-mono text-ink-muted">{plan.levelText[hintLevel - 1]}<span className="text-ink-faint">…</span></p>
          )}
          <div className="flex items-center gap-3">
            {canHint && (
              <button onClick={useHintPress} className="btn-ghost" title="Reveal the start of the answer (reduces interval growth)">Hint</button>
            )}
            <button onClick={() => setRevealed(true)} className="btn-primary px-10">Show answer</button>
          </div>
          <button onClick={() => { setDontKnow(true); setRevealed(true) }} className="text-xs text-ink-faint hover:text-ink-muted">Don&apos;t know</button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="panel min-h-[100px] flex items-center justify-center text-center bg-surface-raised">
            <p className="text-xl text-ink">{answer}</p>
          </div>
          {dontKnow ? (
            <div className="flex justify-center">
              <button onClick={() => onRate('again')} className="btn-primary px-10">Continue</button>
            </div>
          ) : (
            <RatingButtons onRate={onRate} />
          )}
        </div>
      )}
    </div>
  )
}
