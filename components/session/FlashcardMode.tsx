'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Card, Rating } from '@/domain'
import { displayText } from '@/lib/cardText'
import { hintPlan, hintGrowthFactor } from '@/lib/hints'
import { speak } from '@/lib/speak'
import { RatingButtons } from './RatingButtons'
import { EditablePromptPanel } from './EditablePromptPanel'
import { EditableAnswerText } from './EditableAnswerText'
import { CardInfoButton } from './CardInfoButton'

/**
 * Flip-card recall, used for post-graduation "recognition" reviews
 * (rare — only if a custom pipeline ends on a recognition step).
 * Shows Again/Hard/Good/Easy once the answer is revealed.
 */
export function FlashcardMode({ card, promptSide, promptLanguage, deckName, onRate, onPromptEdit, onAnswerEdit, onInfo, hintable, onHint, answerLanguage, autoPlayAudio = true, ipaText, onToggleIPA }: {
  card: Card; promptSide: 'front' | 'back'; deckName?: string; onRate: (r: Rating) => void
  /** Language of the prompt side; when set, a "Listen" button (and autoplay) is offered. */
  promptLanguage?: string
  onPromptEdit?: (newText: string) => void
  /** Edit the answer (other) side of the card from the revealed answer panel. */
  onAnswerEdit?: (newText: string) => void
  onInfo?: () => void
  /** Whether the "Hint" button is offered (Due Now reviews only). */
  hintable?: boolean
  onHint?: (level: number, growthFactor: number) => void
  answerLanguage?: string
  autoPlayAudio?: boolean
  /** IPA transcription for the prompt (source language). Shown inside the prompt card when provided. */
  ipaText?: string
  /** Toggles IPA on/off; when provided a faint "IPA" button appears in the prompt card corner. */
  onToggleIPA?: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  // Set when the learner revealed via "Don't know" (a self-declared miss):
  // show the answer + Continue instead of the self-rating buttons.
  const [dontKnow, setDontKnow] = useState(false)
  const [hintLevel, setHintLevel] = useState(0)
  useEffect(() => {
    setRevealed(false); setDontKnow(false); setHintLevel(0)
    if (autoPlayAudio && promptLanguage) speak(promptSide === 'front' ? card.front : card.back, promptLanguage, card.audioData)
  }, [card.id]) // eslint-disable-line react-hooks/exhaustive-deps
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
        {promptLanguage && (
          <button
            onClick={() => speak(promptSide === 'front' ? card.front : card.back, promptLanguage, card.audioData)}
            title="Listen"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 text-ink-faint hover:text-ink-muted transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 0 0 1.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06ZM18.584 5.106a.75.75 0 0 1 1.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 0 1-1.06-1.06 8.25 8.25 0 0 0 0-11.668.75.75 0 0 1 0-1.06Z" />
              <path d="M15.932 7.757a.75.75 0 0 1 1.061 0 6 6 0 0 1 0 8.486.75.75 0 0 1-1.06-1.061 4.5 4.5 0 0 0 0-6.364.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        )}
        {ipaText ? (
          <span className="absolute bottom-3 left-3 text-xs text-ink-muted font-mono leading-none"
            onClick={onToggleIPA} title="Hide IPA" style={onToggleIPA ? { cursor: 'pointer' } : undefined}>
            [{ipaText}]
          </span>
        ) : onToggleIPA ? (
          <button onClick={onToggleIPA} title="Show IPA transcription"
            className="absolute bottom-3 left-3 text-xs text-ink-faint hover:text-ink-muted transition-colors leading-none">
            IPA
          </button>
        ) : null}
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
            {onAnswerEdit
              ? <span className="text-xl text-ink"><EditableAnswerText text={answer} onEdit={t => onAnswerEdit(t)} /></span>
              : <p className="text-xl text-ink">{answer}</p>}
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
