'use client'

import { useEffect, useState } from 'react'
import type { Card, Rating } from '@/domain'
import { displayText } from '@/lib/cardText'
import { RatingButtons } from './RatingButtons'
import { EditablePromptPanel } from './EditablePromptPanel'

/**
 * Flip-card recall, used for post-graduation "recognition" reviews
 * (rare — only if a custom pipeline ends on a recognition step).
 * Shows Again/Hard/Good/Easy once the answer is revealed.
 */
export function FlashcardMode({ card, promptSide, deckName, onRate, onPromptEdit }: {
  card: Card; promptSide: 'front' | 'back'; deckName?: string; onRate: (r: Rating) => void
  onPromptEdit?: (newText: string) => void
}) {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => setRevealed(false), [card.id])
  const prompt = displayText(promptSide === 'front' ? card.front : card.back)
  const answer = displayText(promptSide === 'front' ? card.back  : card.front)
  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
      <div className="panel min-h-[160px] flex items-center justify-center text-center">
        {onPromptEdit
          ? <EditablePromptPanel text={prompt} onEdit={t => onPromptEdit(t)} />
          : <p className="text-2xl font-medium text-ink">{prompt}</p>}
      </div>
      {!revealed ? (
        <div className="flex flex-col items-center gap-3">
          <button onClick={() => setRevealed(true)} className="btn-primary px-10">Show answer</button>
          <button onClick={() => setRevealed(true)} className="text-xs text-ink-faint hover:text-ink-muted">Don&apos;t know</button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="panel min-h-[100px] flex items-center justify-center text-center bg-surface-raised">
            <p className="text-xl text-ink">{answer}</p>
          </div>
          <RatingButtons onRate={onRate} />
        </div>
      )}
    </div>
  )
}
