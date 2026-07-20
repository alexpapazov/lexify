'use client'

import { useMemo, useState } from 'react'
import type { Card } from '@/domain'
import { displayText } from '@/lib/cardText'
import { CardInfoButton } from './CardInfoButton'
import { EditablePromptPanel } from './EditablePromptPanel'

/**
 * Immediate discrimination drill fired when the learner confuses two target words in production
 * (typed B on a card that wanted A). Shows A's meaning and asks them to pick A's word vs B's word —
 * fixing the discrimination while it's fresh. Pure practice: it never reschedules either card.
 */
export function ConfusionDrill({ card, otherFront, deckName, onDone, onPromptEdit, onInfo }: {
  card: Card            // card A (the one under review)
  otherFront: string    // card B's target word (the word they wrongly typed)
  deckName?: string
  onDone: () => void
  onPromptEdit?: (newText: string) => void   // inline-edit card A's shown meaning (card.back)
  onInfo?: () => void                        // open the full card info/edit modal
}) {
  const correct = displayText(card.front)
  const other   = displayText(otherFront)
  const prompt  = displayText(card.back)
  const [picked, setPicked] = useState<string | null>(null)

  // Shuffle the two options once per drill.
  const options = useMemo(() => (Math.random() < 0.5 ? [correct, other] : [other, correct]), [card.id, otherFront]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6 w-full max-w-[850px] mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
      <p className="text-xs text-center text-warning uppercase tracking-wider">Discrimination check · which word is this?</p>
      <div className="panel relative min-h-[120px] flex items-center justify-center text-center">
        {onInfo && <CardInfoButton onClick={onInfo} />}
        {onPromptEdit
          ? <EditablePromptPanel text={prompt} onEdit={onPromptEdit} />
          : <p className="text-2xl font-medium text-ink">{prompt}</p>}
      </div>
      <div className="grid gap-3">
        {options.map(opt => {
          const isCorrect = opt === correct
          const chosen = picked === opt
          const tone = picked === null
            ? 'border-line/15 hover:border-line/30 hover:bg-line/5'
            : isCorrect ? 'border-success/60 bg-success/10 text-ink'
            : chosen ? 'border-danger/60 bg-danger/10 text-ink-muted'
            : 'border-line/10 text-ink-faint'
          return (
            <button
              key={opt}
              disabled={picked !== null}
              onClick={() => setPicked(opt)}
              className={`rounded-lg border px-4 py-3 text-lg font-mono text-center transition-colors disabled:cursor-default ${tone}`}
            >
              {opt}
            </button>
          )
        })}
      </div>
      {picked !== null && (
        <div className="space-y-3 text-center">
          <p className={`text-sm ${picked === correct ? 'text-success' : 'text-danger'}`}>
            {picked === correct ? 'Correct — that’s the one.' : `Not this one — the answer is ${correct}.`}
          </p>
          <button onClick={onDone} className="btn-primary px-10">Continue</button>
        </div>
      )}
    </div>
  )
}
