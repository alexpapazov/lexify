'use client'

/**
 * components/practice/ClozePlayer.tsx — the Phase 3 practice session.
 *
 * Fill the blank in a generated sentence. Deliberately NOT a study session:
 *
 *   • it writes nothing — no card_states, no review events, no due dates. Practice is extra
 *     exposure, not assessment, and mixing it into FSRS would double-count against real reviews.
 *   • grading is FLEXIBLE with capitalization ignored, regardless of the pair's usual strictness.
 *     The sentence is machine-generated, so failing someone on a missing accent in a word that
 *     isn't even the one being drilled would be noise.
 *
 * A word the repair pass couldn't replace is rendered in red with its translation, which is the
 * documented fallback in `features/Practice Mode.md` — a sentence with one glossed unknown word is
 * more useful than no sentence.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { gradeTyping } from '@/engine/grading'
import { splitForBlank, segmentFlagged } from '@/lib/practiceRender'
import { DEFAULT_GRADING_SETTINGS, type GradingSettings } from '@/domain'
import type { PreparedExercise } from '@/lib/practiceGenerate'

/** Practice grading: forgiving, because the sentence around the answer is generated. */
function practiceGrading(answerLanguage: string): GradingSettings {
  return {
    ...DEFAULT_GRADING_SETTINGS,
    gradingMode:          'flexible',
    ignoreCapitalization: true,
    autoPlayAudio:        false,
    answerLanguage,
  }
}

/** The sentence, blank and all, with unknown words marked. */
function SentenceLine({
  before, after, flagged, filled,
}: {
  before: string
  after:  string
  flagged: { text: string; gloss: string }[]
  /** The revealed answer, or null while the blank is still blank. */
  filled: string | null
}) {
  const render = (text: string) => segmentFlagged(text, flagged).map((seg, i) =>
    seg.flagged
      ? (
        <span key={i} className="text-danger" title={seg.gloss}>
          {seg.text}
          <span className="text-danger/60 text-[0.85em]"> ({seg.gloss})</span>
        </span>
      )
      : <span key={i}>{seg.text}</span>,
  )

  return (
    <p className="text-xl text-ink leading-relaxed text-center">
      {render(before)}
      {filled !== null
        ? <span className="text-accent font-medium">{filled}</span>
        : <span className="inline-block align-baseline border-b-2 border-accent/60 min-w-[6ch] mx-1" aria-label="blank" />}
      {render(after)}
    </p>
  )
}

export function ClozePlayer({ items, answerLanguage, onExit }: {
  items:          PreparedExercise[]
  /** Language of the word being typed — the learned language. */
  answerLanguage: string
  onExit:         () => void
}) {
  const [index,     setIndex]     = useState(0)
  const [input,     setInput]     = useState('')
  const [revealed,  setRevealed]  = useState(false)
  const [showHint,  setShowHint]  = useState(false)
  const [correct,   setCorrect]   = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const settings = useMemo(() => practiceGrading(answerLanguage), [answerLanguage])
  const current  = items[index]

  // New card: clear the form and take focus back, so the whole session is keyboard-only.
  useEffect(() => {
    setInput(''); setRevealed(false); setShowHint(false)
    inputRef.current?.focus()
  }, [index])

  if (!current) {
    return (
      <div className="max-w-md mx-auto pt-16 space-y-4 text-center">
        <h1 className="text-2xl font-semibold text-ink">Practice complete</h1>
        <p className="text-ink-muted text-sm">
          {`${correct} of ${items.length} correct. Nothing was scheduled — practice doesn’t change your review dates.`}
        </p>
        <button onClick={onExit} className="btn-primary">Back to practice setup</button>
      </div>
    )
  }

  const { exercise, flagged } = current
  const split = splitForBlank(exercise.sentence, exercise.answer)
  const result = revealed ? gradeTyping(input, exercise.answer, settings) : null

  function check() {
    if (revealed || !input.trim()) return
    const graded = gradeTyping(input, exercise.answer, settings)
    if (graded.correct) setCorrect(c => c + 1)
    setRevealed(true)
  }

  function next() { setIndex(i => i + 1) }

  return (
    <div className="space-y-6 max-w-2xl mx-auto pb-12">
      <div className="flex items-center justify-between gap-4">
        <button onClick={onExit} className="text-sm text-ink-faint hover:text-ink transition-colors">✕ End practice</button>
        <span className="text-sm text-ink-muted tabular-nums">{index + 1} / {items.length}</span>
      </div>

      <div className="h-1 rounded-full bg-surface overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${(index / items.length) * 100}%` }} />
      </div>

      <div className="panel py-10 space-y-5">
        {split
          ? <SentenceLine before={split.before} after={split.after} flagged={flagged}
              filled={revealed ? exercise.answer : null} />
          // Belt and braces: the parser rejects an answer that isn't in the sentence, so this
          // should be unreachable — but never render a broken exercise as a blank screen.
          : <p className="text-xl text-ink text-center">{exercise.sentence}</p>}

        {(showHint || revealed) && exercise.translation && (
          <p className="text-sm text-ink-muted text-center italic">{exercise.translation}</p>
        )}
      </div>

      {!revealed ? (
        <div className="space-y-3">
          <input
            ref={inputRef}
            autoFocus
            className="input text-center text-lg"
            placeholder="Type the missing word…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') check() }}
          />
          <div className="flex items-center justify-center gap-3">
            {!showHint && exercise.translation && (
              <button onClick={() => setShowHint(true)} className="btn-ghost text-sm">Hint</button>
            )}
            <button onClick={check} disabled={!input.trim()} className="btn-primary px-8 disabled:opacity-50">
              Check
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className={`rounded-card border px-4 py-3 text-center text-sm ${
            result?.correct
              ? 'border-success/40 bg-success/5 text-success'
              : 'border-danger/40 bg-danger/5 text-danger'
          }`}>
            {result?.correct
              ? 'Correct'
              : <>Answer: <strong className="text-ink">{exercise.answer}</strong>{input.trim() ? <> — you typed “{input.trim()}”</> : null}</>}
          </div>
          <div className="flex justify-center">
            <button autoFocus onClick={next} className="btn-primary px-10">
              {index + 1 === items.length ? 'Finish' : 'Continue'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
