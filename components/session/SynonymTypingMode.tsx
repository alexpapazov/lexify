'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  GradingSettings, GradingIssueType, Rating, SynonymProductionPrompt, SynonymAnswerField,
} from '@/domain'
import { gradeTyping } from '@/engine/grading'
import { RatingButtons } from './RatingButtons'

/**
 * Multi-field synonym production prompt — sequential one-at-a-time checking.
 *
 * Each Enter press checks the current input against the REMAINING expected
 * answers (order-independent). A match locks that form in and advances to the
 * next. A miss immediately ends the round: locked forms keep their ratings,
 * all remaining forms receive 'again'.
 */
export function SynonymTypingMode({
  prompt: synonymPrompt,
  gradingSettings,
  gradedReview,
  onAdvance,
}: {
  prompt:          SynonymProductionPrompt
  gradingSettings: GradingSettings
  gradedReview:    boolean
  onAdvance: (results: Array<{lexicalItemId: string; rating: Rating; wasCorrect: boolean; issueType?: GradingIssueType}>) => void
}) {
  const dueFields      = synonymPrompt.fields.filter(f => f.dueState === 'due')
  const prefilledFields = synonymPrompt.fields.filter(f => f.dueState !== 'due')

  type LockedEntry = {
    lexicalItemId: string
    expectedAnswer: string
    typedAnswer: string
    status: 'correct' | 'almost'
    defaultRating: Rating
    issueType: GradingIssueType
  }

  const [locked,       setLocked]       = useState<LockedEntry[]>([])
  const [input,        setInput]         = useState('')
  const [failed,       setFailed]        = useState(false)
  const [wrongTyped,   setWrongTyped]    = useState('')
  const [ratingOverrides, setRatingOverrides] = useState<Record<string, Rating>>({})

  const inputRef        = useRef<HTMLInputElement>(null)
  const continueRef     = useRef<HTMLButtonElement>(null)
  const autoAdvancedRef = useRef(false)

  const answeredIds = new Set(locked.map(e => e.lexicalItemId))
  const remaining   = dueFields.filter(f => !answeredIds.has(f.lexicalItemId))
  const allDone     = remaining.length === 0

  // If every form was already answered today, skip silently — nothing to type.
  useEffect(() => {
    if (dueFields.length === 0 && !autoAdvancedRef.current) {
      autoAdvancedRef.current = true
      onAdvance([])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-focus input after a successful step (new form ready).
  useEffect(() => {
    if (!failed && !allDone) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [locked.length, failed, allDone])

  function handleCheck() {
    const trimmed = input.trim()
    if (!trimmed) return

    // Find the best match among remaining expected answers.
    let bestMatch: { field: SynonymAnswerField; result: ReturnType<typeof gradeTyping> } | null = null
    for (const field of remaining) {
      const r = gradeTyping(trimmed, field.expectedAnswer, gradingSettings)
      if (r.status === 'correct') { bestMatch = { field, result: r }; break }
      if (r.status === 'almost' && !bestMatch) bestMatch = { field, result: r }
    }

    if (bestMatch) {
      const entry: LockedEntry = {
        lexicalItemId:  bestMatch.field.lexicalItemId,
        expectedAnswer: bestMatch.field.expectedAnswer,
        typedAnswer:    trimmed,
        status:         bestMatch.result.status as 'correct' | 'almost',
        defaultRating:  bestMatch.result.status === 'correct' ? 'good' : 'hard',
        issueType:      bestMatch.result.issueType,
      }
      const newLocked = [...locked, entry]
      setLocked(newLocked)
      setInput('')

      const newAnswered = new Set(newLocked.map(e => e.lexicalItemId))
      if (dueFields.every(f => newAnswered.has(f.lexicalItemId))) {
        // All done — focus Continue
        setTimeout(() => continueRef.current?.focus(), 100)
      }
    } else {
      setWrongTyped(trimmed)
      setFailed(true)
      setTimeout(() => continueRef.current?.focus(), 100)
    }
  }

  function handleAdvance() {
    const lockedResults = locked.map(e => ({
      lexicalItemId: e.lexicalItemId,
      rating:        (gradedReview ? ratingOverrides[e.lexicalItemId] : undefined) ?? e.defaultRating,
      wasCorrect:    e.status === 'correct',
      issueType:     e.issueType,
    }))
    const failedResults: typeof lockedResults = failed
      ? remaining.map(f => ({ lexicalItemId: f.lexicalItemId, rating: 'again' as Rating, wasCorrect: false, issueType: 'wrong' as GradingIssueType }))
      : []
    onAdvance([...lockedResults, ...failedResults])
  }

  const totalDue = dueFields.length
  const stepHint = remaining.length === totalDue
    ? `Type all ${totalDue} forms — any order is fine`
    : `${remaining.length} form${remaining.length !== 1 ? 's' : ''} remaining`

  // Don't render anything while auto-advancing past a fully-prefilled card.
  if (dueFields.length === 0) return null

  return (
    <div className="space-y-4 w-full max-w-[730px] mx-auto">
      {/* Gloss */}
      <div className="panel min-h-[100px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{synonymPrompt.gloss}</p>
      </div>

      {/* Pre-answered forms from prior sessions */}
      {prefilledFields.map(field => (
        <input key={field.lexicalItemId}
          className="input text-center font-mono opacity-40 cursor-default"
          value={field.expectedAnswer} readOnly disabled />
      ))}

      {/* Locked (correctly answered this round) */}
      {locked.map(entry => (
        <div key={entry.lexicalItemId}
          className={`input flex items-center justify-center text-center font-mono text-lg
            ${entry.status === 'correct' ? 'border-success/60 bg-success/5' : 'border-warning/60 bg-warning/5'}`}>
          {entry.typedAnswer}
          {entry.expectedAnswer.toLowerCase() !== entry.typedAnswer.toLowerCase() && (
            <span className="ml-2 text-xs text-ink-faint">({entry.expectedAnswer})</span>
          )}
        </div>
      ))}

      {/* Active input — shown while not done and not failed */}
      {!allDone && !failed && (
        <>
          {totalDue > 1 && (
            <p className="text-xs text-ink-faint text-center">{stepHint}</p>
          )}
          <input
            ref={inputRef}
            className="input text-center text-lg font-mono"
            placeholder="Type your answer…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleCheck()
              }
            }}
          />
          <div className="flex justify-center">
            <button onClick={handleCheck} disabled={!input.trim()} className="btn-primary">
              Check
            </button>
          </div>
        </>
      )}

      {/* Wrong answer display */}
      {failed && (
        <div className="space-y-2">
          <div className="input text-center text-lg font-mono border-danger/60 bg-danger/5 text-ink-muted line-through">
            {wrongTyped || '—'}
          </div>
          {remaining.length > 0 && (
            <div className="text-sm text-center space-y-0.5">
              <p className="text-xs text-ink-faint uppercase tracking-wider">
                {remaining.length === 1 ? 'Correct form' : 'Remaining forms'}
              </p>
              {remaining.map(f => (
                <p key={f.lexicalItemId} className="font-mono text-ink">{f.expectedAnswer}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Continue — appears when all done or failed */}
      {(allDone || failed) && (
        <div className="space-y-4">
          {gradedReview && locked.length > 0 && (
            <div className="space-y-2">
              {locked.map(entry => (
                <div key={entry.lexicalItemId} className="flex items-center gap-3">
                  <span className="text-xs text-ink-faint w-32 truncate">{entry.expectedAnswer}</span>
                  <RatingButtons
                    onRate={r => setRatingOverrides(prev => ({ ...prev, [entry.lexicalItemId]: r }))}
                    suggestedRating={ratingOverrides[entry.lexicalItemId] ?? entry.defaultRating}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-center">
            <button ref={continueRef} onClick={handleAdvance} className="btn-primary px-10">
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
