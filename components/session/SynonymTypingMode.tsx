'use client'

import { useState } from 'react'
import type {
  GradingSettings, GradingIssueType, Rating, SynonymProductionPrompt, SynonymAnswerField,
} from '@/domain'
import { gradeMultiField, gradeTyping } from '@/engine/grading'
import { RatingButtons } from './RatingButtons'

/**
 * Multi-field synonym production prompt.
 *
 * Shows one input field per synonym-group member:
 *   • prefilled  — already reviewed or not due (shown greyed, not editable)
 *   • due_blank  — blank, must be typed
 *
 * Grades each due field independently; any order of answers is accepted.
 * Calls onRate once per due field with the field's lexicalItemId.
 */
export function SynonymTypingMode({
  prompt: synonymPrompt,
  gradingSettings,
  gradedReview,
  onRate,
}: {
  prompt:          SynonymProductionPrompt
  gradingSettings: GradingSettings
  gradedReview:    boolean
  /**
   * Called once for each due field after the user submits.
   * Session page should update each lexical item's CardState separately.
   */
  onRate: (lexicalItemId: string, rating: Rating, wasCorrect: boolean, issueType?: GradingIssueType) => void
}) {
  // Local values for each blank field (indexed by lexicalItemId)
  const [values, setValues]   = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const f of synonymPrompt.fields) {
      if (f.status === 'due_blank') init[f.lexicalItemId] = ''
    }
    return init
  })
  const [submitted, setSubmitted] = useState(false)
  const [gradingResult, setGradingResult] = useState<ReturnType<typeof gradeMultiField> | null>(null)
  const [ratings, setRatings] = useState<Record<string, Rating>>({})

  const dueFields  = synonymPrompt.fields.filter(f => f.dueState === 'due')
  const allFilled  = dueFields.every(f => (values[f.lexicalItemId] ?? '').trim().length > 0)

  function handleCheck() {
    // Build fields with user values for grading
    const fieldsWithValues: SynonymAnswerField[] = synonymPrompt.fields.map(f => ({
      ...f,
      value: f.status === 'due_blank' ? (values[f.lexicalItemId] ?? '') : f.value,
    }))
    const result = gradeMultiField(fieldsWithValues, gradingSettings)
    setGradingResult(result)
    setSubmitted(true)

    // Default ratings based on per-field status
    const defaultRatings: Record<string, Rating> = {}
    for (const fr of result.fieldResults) {
      defaultRatings[fr.lexicalItemId] =
        fr.status === 'correct' ? 'good' :
        fr.status === 'almost'  ? 'hard' :
        'again'
    }
    setRatings(defaultRatings)
  }

  function handleAdvance() {
    if (!gradingResult) return
    for (const fr of gradingResult.fieldResults) {
      const rating = ratings[fr.lexicalItemId] ?? 'again'
      onRate(fr.lexicalItemId, rating, fr.status === 'correct', fr.issueType)
    }
  }

  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      {/* Gloss / prompt */}
      <div className="panel min-h-[80px] flex items-center justify-center text-center">
        <p className="text-2xl font-medium text-ink">{synonymPrompt.gloss}</p>
      </div>

      {/* Fields */}
      <div className="space-y-3">
        {synonymPrompt.fields.map(field => {
          const fieldResult = gradingResult?.fieldResults.find(r => r.lexicalItemId === field.lexicalItemId)
          const isPrefilled  = field.status === 'prefilled' || field.dueState !== 'due'
          const isBlank      = field.status === 'due_blank'

          let inputClass = 'input text-center font-mono'
          let statusLabel: string | null = null

          if (isPrefilled) {
            inputClass += ' opacity-50 cursor-default bg-transparent'
            statusLabel = field.dueState === 'already_completed_this_session'
              ? 'already reviewed'
              : 'not due'
          } else if (submitted && fieldResult) {
            statusLabel =
              fieldResult.status === 'correct'  ? '✓ correct' :
              fieldResult.status === 'almost'   ? '≈ almost'  :
              fieldResult.status === 'missing'  ? 'not answered' :
              fieldResult.issueType === 'wrong_synonym' ? 'wrong synonym' :
              '✗ incorrect'
            inputClass +=
              fieldResult.status === 'correct' ? ' border-success/60 bg-success/5' :
              fieldResult.status === 'almost'  ? ' border-warning/60 bg-warning/5' :
              ' border-danger/60 bg-danger/5'
          }

          const registerLabel = field.register && field.register !== 'neutral'
            ? field.register
            : field.region ?? null

          return (
            <div key={field.lexicalItemId} className="flex items-center gap-3">
              <div className="flex-1 relative">
                <input
                  className={inputClass}
                  value={isPrefilled ? field.expectedAnswer : (values[field.lexicalItemId] ?? '')}
                  onChange={e => {
                    if (isPrefilled || submitted) return
                    setValues(v => ({ ...v, [field.lexicalItemId]: e.target.value }))
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !submitted && allFilled) handleCheck()
                  }}
                  disabled={isPrefilled || submitted}
                  readOnly={isPrefilled}
                  placeholder={isBlank && !submitted ? 'Type your answer…' : undefined}
                />
              </div>
              <div className="w-36 text-xs text-right shrink-0 space-y-0.5">
                {statusLabel && (
                  <span className={`${
                    statusLabel.startsWith('✓') ? 'text-success' :
                    statusLabel.startsWith('≈') ? 'text-warning' :
                    statusLabel.startsWith('✗') || statusLabel === 'wrong synonym' ? 'text-danger' :
                    'text-ink-faint'
                  }`}>
                    {statusLabel}
                  </span>
                )}
                {registerLabel && (
                  <span className="block text-ink-faint">{registerLabel}</span>
                )}
                {submitted && fieldResult?.reason && (
                  <span className="block text-ink-faint">{fieldResult.reason}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Actions */}
      {!submitted ? (
        <div className="flex justify-center">
          <button
            onClick={handleCheck}
            disabled={!allFilled}
            className="btn-primary"
          >
            Check
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Per-field rating overrides (post-grad) */}
          {gradedReview && gradingResult && (
            <div className="space-y-2">
              {gradingResult.fieldResults.map(fr => (
                <div key={fr.lexicalItemId} className="flex items-center gap-3">
                  <span className="text-xs text-ink-faint w-32 truncate">
                    {fr.expectedAnswer}
                  </span>
                  <RatingButtons
                    onRate={r => setRatings(prev => ({ ...prev, [fr.lexicalItemId]: r }))}
                    suggestedRating={ratings[fr.lexicalItemId]}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-center">
            <button onClick={handleAdvance} className="btn-primary px-10">Continue</button>
          </div>
        </div>
      )}
    </div>
  )
}
