'use client'

import { useRef, useState } from 'react'
import type {
  GradingSettings, GradingIssueType, Rating, SynonymProductionPrompt, SynonymAnswerField,
} from '@/domain'
import { gradeMultiField } from '@/engine/grading'
import { RatingButtons } from './RatingButtons'

/**
 * Multi-field synonym production prompt.
 *
 * Shows one input field per synonym-group member that is due. Values are
 * position-indexed (not field-bound), so the learner can type any correct
 * answer in any box — gradeMultiField does best-fit order-independent matching.
 *
 * Calls onAdvance once with all field results when the learner presses Continue.
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
  /** Called once with ALL field results when the user presses Continue. */
  onAdvance: (results: Array<{lexicalItemId: string; rating: Rating; wasCorrect: boolean; issueType?: GradingIssueType}>) => void
}) {
  const dueFields = synonymPrompt.fields.filter(f => f.dueState === 'due')

  // Positional values — not bound to a specific field, any answer goes in any box.
  const [values,       setValues]       = useState<string[]>(() => dueFields.map(() => ''))
  const [submitted,    setSubmitted]    = useState(false)
  const [gradingResult, setGradingResult] = useState<ReturnType<typeof gradeMultiField> | null>(null)
  const [ratings,      setRatings]      = useState<Record<string, Rating>>({})
  const continueRef = useRef<HTMLButtonElement>(null)

  const allFilled = values.every(v => v.trim().length > 0)

  function handleCheck() {
    // Build fields with positional values mapped in order (gradeMultiField does best-fit anyway).
    const fieldsWithValues: SynonymAnswerField[] = synonymPrompt.fields.map(f => {
      if (f.status !== 'due_blank') return f
      const idx = dueFields.findIndex(d => d.lexicalItemId === f.lexicalItemId)
      return { ...f, value: values[idx] ?? '' }
    })
    const result = gradeMultiField(fieldsWithValues, gradingSettings)
    setGradingResult(result)
    setSubmitted(true)

    const defaultRatings: Record<string, Rating> = {}
    for (const fr of result.fieldResults) {
      defaultRatings[fr.lexicalItemId] =
        fr.status === 'correct' ? 'good' :
        fr.status === 'almost'  ? 'hard' :
        'again'
    }
    setRatings(defaultRatings)

    setTimeout(() => continueRef.current?.focus(), 100)
  }

  function handleAdvance() {
    if (!gradingResult) return
    onAdvance(gradingResult.fieldResults.map(fr => ({
      lexicalItemId: fr.lexicalItemId,
      rating:        (ratings[fr.lexicalItemId] ?? 'again') as Rating,
      wasCorrect:    fr.status === 'correct',
      issueType:     fr.issueType,
    })))
  }

  // After grading: determine which typed value was matched to each field result.
  // Used to color each input box based on its matched result.
  function boxResult(idx: number): 'correct' | 'almost' | 'incorrect' | null {
    if (!gradingResult || !submitted) return null
    const typed = values[idx]?.trim()
    if (!typed) return null
    const matched = gradingResult.fieldResults.find(fr => fr.typedAnswer?.trim() === typed)
    return matched?.status as 'correct' | 'almost' | 'incorrect' ?? 'incorrect'
  }

  const prefilledFields = synonymPrompt.fields.filter(f => f.status === 'prefilled' || f.dueState !== 'due')

  return (
    <div className="space-y-4 w-full max-w-xl mx-auto">
      {/* Gloss / prompt */}
      <div className="panel min-h-[100px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{synonymPrompt.gloss}</p>
      </div>

      {/* Prefilled (pre-answered) fields */}
      {prefilledFields.map(field => (
        <input
          key={field.lexicalItemId}
          className="input text-center font-mono opacity-40 cursor-default"
          value={field.expectedAnswer}
          readOnly
          disabled
        />
      ))}

      {/* Instruction label */}
      {dueFields.length > 1 && (
        <p className="text-xs text-ink-faint text-center">
          Type all {dueFields.length} forms — any order is fine
        </p>
      )}

      {/* Due fields — positional, not field-bound */}
      <div className="space-y-2">
        {values.map((val, idx) => {
          const res = boxResult(idx)
          const borderClass = !submitted ? '' :
            res === 'correct' ? 'border-success/60 bg-success/5' :
            res === 'almost'  ? 'border-warning/60 bg-warning/5' :
            'border-danger/60 bg-danger/5'

          return (
            <input
              key={idx}
              className={`input text-center text-lg font-mono ${borderClass}`}
              placeholder="Type your answer…"
              value={val}
              onChange={e => {
                if (submitted) return
                setValues(prev => prev.map((v, i) => i === idx ? e.target.value : v))
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !submitted && allFilled) handleCheck()
              }}
              disabled={submitted}
              autoFocus={idx === 0}
            />
          )
        })}
      </div>

      {/* Correct answers shown when wrong */}
      {submitted && gradingResult && gradingResult.overallStatus !== 'correct' && (
        <div className="text-sm text-ink-muted text-center space-y-0.5">
          <p className="text-xs text-ink-faint uppercase tracking-wider">Correct forms</p>
          {gradingResult.fieldResults
            .filter(fr => fr.status !== 'correct')
            .map(fr => (
              <p key={fr.lexicalItemId} className="font-mono text-ink">{fr.expectedAnswer}</p>
            ))}
        </div>
      )}

      {/* Actions */}
      {!submitted ? (
        <div className="flex justify-center">
          <button onClick={handleCheck} disabled={!allFilled} className="btn-primary">
            Check
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Per-field rating overrides (post-grad only) */}
          {gradedReview && gradingResult && (
            <div className="space-y-2">
              {gradingResult.fieldResults.map(fr => (
                <div key={fr.lexicalItemId} className="flex items-center gap-3">
                  <span className="text-xs text-ink-faint w-32 truncate">{fr.expectedAnswer}</span>
                  <RatingButtons
                    onRate={r => setRatings(prev => ({ ...prev, [fr.lexicalItemId]: r }))}
                    suggestedRating={ratings[fr.lexicalItemId]}
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
