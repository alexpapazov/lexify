'use client'

import { useState } from 'react'
import type { Card, GradingSettings, Rating } from '@/domain'
import { gradeTyping } from '@/engine/grading'
import { RatingButtons } from './RatingButtons'
import { EditablePromptPanel } from './EditablePromptPanel'
import { CardInfoButton } from './CardInfoButton'

/**
 * Due Now typed-production mode for synonym-group cards.
 *
 * Shows the shared native gloss (card.back) as the prompt.  The learner
 * types target-language words one at a time:
 *   • A synonym match → grays that box, opens a new blank box, credits the
 *     synonym's SRS state via onSynonymTyped.
 *   • The due card's front → shows result + rating buttons.
 *   • Anything else → fails immediately (suggested 'again').
 *
 * Synonyms the learner already answered correctly today (preAnsweredIds)
 * appear pre-grayed at the top so they don't need to re-type them.
 */
export function SynonymDueNowMode({
  card,
  synonymMembers,
  preAnsweredIds,
  gradingSettings,
  overrideAnswers,
  onRate,
  onSynonymTyped,
  onPromptEdit,
  onInfo,
}: {
  /** The card that is actually due — its state gets updated by onRate. */
  card: Card
  /** Other members of the synonym group (not the due card). */
  synonymMembers: Card[]
  /** IDs of synonym members already answered correctly today (pre-grayed). */
  preAnsweredIds: Set<string>
  gradingSettings: GradingSettings
  /** Persisted override answers accepted as correct for the due card. */
  overrideAnswers: string[]
  onRate: (rating: Rating, wasCorrect: boolean, userAnswer: string) => void
  /** Called each time the learner correctly types a (non-due) synonym. */
  onSynonymTyped: (synonymCardId: string) => void
  onPromptEdit?: (newText: string) => void
  onInfo?: () => void
}) {
  const [sessionCompleted, setSessionCompleted] =
    useState<Array<{ card: Card; typed: string }>>([])
  const [input, setInput] = useState('')
  const [result, setResult] = useState<{
    correct: boolean
    almost: boolean
    typed: string
  } | null>(null)

  // Exclude any member already shown in sessionCompleted to prevent duplicates
  // (parent adds typed synonyms to preAnsweredIds after onSynonymTyped fires)
  const preGrayed = synonymMembers.filter(
    m => preAnsweredIds.has(m.id) && !sessionCompleted.some(c => c.card.id === m.id),
  )
  const remaining = synonymMembers.filter(
    m => !preAnsweredIds.has(m.id) && !sessionCompleted.some(c => c.card.id === m.id),
  )

  function check() {
    const trimmed = input.trim()
    if (!trimmed) return

    // Check remaining synonyms first (exact gradeTyping match)
    const matched = remaining.find(m => gradeTyping(trimmed, m.front, gradingSettings).status === 'correct')
    if (matched) {
      setSessionCompleted(prev => [...prev, { card: matched, typed: trimmed }])
      onSynonymTyped(matched.id)
      setInput('')
      return
    }

    // Check the due card
    const dueGrade = gradeTyping(trimmed, card.front, gradingSettings)
    const isOverride = overrideAnswers.some(
      o => gradeTyping(trimmed, o, gradingSettings).status === 'correct',
    )

    if (dueGrade.status === 'correct' || isOverride) {
      setResult({ correct: true, almost: false, typed: trimmed })
    } else if (dueGrade.status === 'almost') {
      setResult({ correct: false, almost: true, typed: trimmed })
    } else {
      setResult({ correct: false, almost: false, typed: trimmed })
    }
  }

  const suggestedRating: Rating =
    result?.correct ? 'good' : result?.almost ? 'hard' : 'again'

  return (
    <div className="space-y-4 w-full max-w-[min(80vw,1200px)] mx-auto">
      {/* Prompt */}
      <div className="panel relative min-h-[120px] flex items-center justify-center text-center">
        {onInfo && <CardInfoButton onClick={onInfo} />}
        {onPromptEdit
          ? <EditablePromptPanel text={card.back} onEdit={t => onPromptEdit(t)} />
          : <p className="text-2xl font-medium text-ink">{card.back}</p>}
      </div>

      {/* Pre-answered synonyms (grayed) */}
      {preGrayed.map(m => (
        <input
          key={m.id}
          className="input text-center font-mono opacity-40 cursor-default"
          value={m.front}
          readOnly
          disabled
        />
      ))}

      {/* Synonyms typed this session (grayed) */}
      {sessionCompleted.map(({ card: c, typed }) => (
        <input
          key={c.id}
          className="input text-center font-mono opacity-40 cursor-default"
          value={typed}
          readOnly
          disabled
        />
      ))}

      {/* Active input */}
      {!result && (
        <div className="space-y-3">
          <input
            className="input text-center text-lg font-mono"
            placeholder="Type your answer…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && input.trim()) check() }}
            autoFocus
          />
          <div className="flex justify-center">
            <button
              onClick={check}
              disabled={!input.trim()}
              className="btn-primary"
            >
              Check
            </button>
          </div>
        </div>
      )}

      {/* Typed answer for the due card — stays visible after checking */}
      {result && (
        <input
          className={`input text-center text-lg font-mono ${
            result.correct
              ? 'opacity-40 cursor-default'
              : result.almost
                ? 'border-warning/60 bg-warning/5'
                : 'border-danger/60 bg-danger/5'
          }`}
          value={result.typed}
          readOnly
          disabled
        />
      )}

      {/* Result + rating */}
      {result && (
        <div className="space-y-4">
          <div className={`panel text-center py-3 ${
            result.correct
              ? 'border-success/30 bg-success/5'
              : result.almost
                ? 'border-warning/30 bg-warning/5'
                : 'border-danger/30 bg-danger/5'
          }`}>
            {result.correct ? (
              <p className="text-success font-medium">Correct!</p>
            ) : (
              <div className="space-y-1">
                <p className={result.almost ? 'text-warning font-medium' : 'text-danger font-medium'}>
                  {result.almost ? 'Almost!' : 'Not quite'}
                </p>
                <p className="text-ink-muted text-sm">
                  Answer: <span className="font-mono text-ink">{card.front}</span>
                </p>
              </div>
            )}
          </div>
          <RatingButtons
            onRate={r => onRate(r, result.correct, result.typed)}
            suggestedRating={suggestedRating}
          />
        </div>
      )}
    </div>
  )
}
