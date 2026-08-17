'use client'

/**
 * components/practice/ClozePlayer.tsx — the practice session player.
 *
 * Fill the blank in a generated sentence. Deliberately NOT a study session:
 *
 *   • it writes nothing — no card_states, no review events, no due dates. Practice is extra
 *     exposure, not assessment, and mixing it into FSRS would double-count against real reviews.
 *   • grading is FLEXIBLE with capitalization ignored, regardless of the pair's usual strictness.
 *     The sentence is machine-generated, so failing someone on a missing accent in a word that
 *     isn't even the one being drilled would be noise.
 *
 * The sentence is INTERACTIVE (Clozemaster-style): the native translation sits underneath the whole
 * time, and tapping any word opens its meaning — the generator's in-context gloss — plus the
 * learner's own card for that word when the library has one. Yes, the translation can hint at the
 * blank; that trade was chosen deliberately, the exercise is recall + inflection, not riddling.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { gradeTyping } from '@/engine/grading'
import { splitForBlank, segmentWords } from '@/lib/practiceRender'
import { DEFAULT_GRADING_SETTINGS, type GradingSettings } from '@/domain'
import type { PreparedExercise } from '@/lib/practiceGenerate'
import type { PracticeToken } from '@/lib/practiceSchema'

/** The learner's own card for a tapped word, as the page resolves it. */
export interface PracticeCardMatch {
  front:  string
  back:   string
  /** 'Graduated' / 'Learning' / … — whatever the page derives; shown as a chip. */
  status: string
}

/** What the tap panel shows for one word. */
interface PickedWord {
  text:  string
  gloss: string
  card:  PracticeCardMatch | null
}

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

/** The sentence with the blank, every word tappable. */
function SentenceLine({
  before, after, filled, gloss, onWord,
}: {
  before: string
  after:  string
  /** The revealed answer, or null while the blank is still blank. */
  filled: string | null
  /** Native meaning of the missing word, shown inside the blank as the prompt. */
  gloss:  string
  onWord: (text: string) => void
}) {
  const render = (text: string) => segmentWords(text).map((run, i) =>
    run.isWord
      ? (
        <button key={i} type="button" onClick={() => onWord(run.text)}
          className="rounded-sm hover:bg-accent/10 hover:text-accent-soft focus-visible:bg-accent/10 transition-colors cursor-pointer">
          {run.text}
        </button>
      )
      : <span key={i}>{run.text}</span>,
  )

  return (
    <p className="text-xl text-ink leading-relaxed text-center">
      {render(before)}
      {filled !== null
        ? (
          <button type="button" onClick={() => onWord(filled)}
            className="text-accent font-medium rounded-sm hover:bg-accent/10 transition-colors cursor-pointer">
            {filled}
          </button>
        )
        // The blank carries the meaning to produce. Without it the learner is guessing which word
        // was removed; with it, the exercise is recall + inflection, which is the point.
        : gloss
          ? (
            <span className="inline-block align-baseline border-b-2 border-accent/60 px-2 mx-1 text-base text-accent-soft italic">
              {gloss}
            </span>
          )
          : <span className="inline-block align-baseline border-b-2 border-accent/60 min-w-[6ch] mx-1" aria-label="blank" />}
      {render(after)}
    </p>
  )
}

export function ClozePlayer({ items, answerLanguage, onExit, findCard }: {
  items:          PreparedExercise[]
  /** Language of the word being typed — the learned language. */
  answerLanguage: string
  onExit:         () => void
  /** Resolves a tapped word to the learner's own card, if the library has it. */
  findCard: (word: { text: string; lemma?: string }) => PracticeCardMatch | null
}) {
  const [index,     setIndex]     = useState(0)
  const [input,     setInput]     = useState('')
  const [revealed,  setRevealed]  = useState(false)
  const [picked,    setPicked]    = useState<PickedWord | null>(null)
  /**
   * Per-item outcome, so an override can flip one after it's been graded and the tally stays
   * consistent. `overridden` is kept only to label the result — the count reads `correct`.
   */
  const [outcomes, setOutcomes] = useState<Record<number, { correct: boolean; overridden: boolean }>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  const settings = useMemo(() => practiceGrading(answerLanguage), [answerLanguage])
  const current  = items[index]
  const correct  = Object.values(outcomes).filter(o => o.correct).length

  // New card: clear the form and take focus back, so the whole session is keyboard-only.
  useEffect(() => {
    setInput(''); setRevealed(false); setPicked(null)
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

  const { exercise } = current
  const split = splitForBlank(exercise.sentence, exercise.answer)
  const outcome = outcomes[index]

  /** A tapped word: its in-context gloss from the token list, and the learner's card if any. */
  function pickWord(text: string) {
    const clean = text.trim()
    if (!clean) return
    // Toggle off when the same word is tapped again.
    if (picked?.text.toLowerCase() === clean.toLowerCase()) { setPicked(null); return }
    const token: PracticeToken | undefined =
      exercise.tokens.find(t => t.text.toLowerCase() === clean.toLowerCase())
    setPicked({
      text:  clean,
      gloss: token?.gloss ?? '',
      card:  findCard({ text: clean, lemma: token?.lemma }),
    })
  }

  function check() {
    if (revealed || !input.trim()) return
    const graded = gradeTyping(input, exercise.answer, settings)
    setOutcomes(o => ({ ...o, [index]: { correct: graded.correct, overridden: false } }))
    setRevealed(true)
  }

  /**
   * Flip this item's verdict. Practice sentences are generated, so the grader is judging an
   * inflected form in a context it invented — "you typed the other past tense, which the sentence
   * would also accept" is a judgement only the learner can make.
   *
   * Session-local ON PURPOSE. The app's persistent overrides (`typed_answer_overrides`) key on a
   * CARD's canonical answer; storing an inflected form there would teach a real review to accept a
   * wrong answer. So this moves the tally and nothing else — consistent with practice writing
   * nothing.
   */
  function toggleOverride() {
    setOutcomes(o => {
      const at = o[index]
      if (!at) return o
      return { ...o, [index]: { correct: !at.correct, overridden: !at.overridden } }
    })
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
          ? <SentenceLine before={split.before} after={split.after}
              filled={revealed ? exercise.answer : null} gloss={current.targetGloss} onWord={pickWord} />
          // Belt and braces: the parser rejects an answer that isn't in the sentence, so this
          // should be unreachable — but never render a broken exercise as a blank screen.
          : <p className="text-xl text-ink text-center">{exercise.sentence}</p>}

        {/* The native translation lives under the sentence the whole time — the exercise is
            producing the word, not decoding the sentence. */}
        {exercise.translation && (
          <p className="text-sm text-ink-muted text-center italic">{exercise.translation}</p>
        )}

        {/* Tap-a-word panel: in-context meaning, plus the learner's own card when one matches. */}
        {picked && (
          <div className="mx-auto max-w-md rounded-card border border-line/15 bg-surface-raised px-4 py-3 space-y-1.5 text-center">
            <p className="text-sm">
              <span className="text-ink font-medium">{picked.text}</span>
              {picked.gloss && <span className="text-ink-muted"> — {picked.gloss}</span>}
              {!picked.gloss && !picked.card && <span className="text-ink-faint"> — no translation available</span>}
            </p>
            {picked.card ? (
              <p className="text-xs text-ink-muted">
                {`In your library: ${picked.card.front} = ${picked.card.back}`}
                <span className="ml-2 inline-block rounded-full border border-line/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                  {picked.card.status}
                </span>
              </p>
            ) : (
              <p className="text-xs text-ink-faint">Not in your library</p>
            )}
          </div>
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
            <button onClick={check} disabled={!input.trim()} className="btn-primary px-8 disabled:opacity-50">
              Check
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* The panel reflects the OUTCOME, not the raw grade, so an override visibly changes it. */}
          <div className={`rounded-card border px-4 py-3 text-center text-sm ${
            outcome?.correct
              ? 'border-success/40 bg-success/5 text-success'
              : 'border-danger/40 bg-danger/5 text-danger'
          }`}>
            {outcome?.correct
              ? (outcome.overridden
                  ? <>Marked correct — the answer was <strong className="text-ink">{exercise.answer}</strong></>
                  : 'Correct')
              : (outcome?.overridden
                  ? <>Marked incorrect — the answer was <strong className="text-ink">{exercise.answer}</strong></>
                  : <>Answer: <strong className="text-ink">{exercise.answer}</strong>{input.trim() ? <> — you typed “{input.trim()}”</> : null}</>)}
          </div>
          <div className="flex flex-col items-center gap-3">
            <button autoFocus onClick={next} className="btn-primary px-10">
              {index + 1 === items.length ? 'Finish' : 'Continue'}
            </button>
            <button onClick={toggleOverride}
              title="These sentences are generated — override the grader when your answer also works"
              className="text-xs text-ink-faint hover:text-ink transition-colors">
              {outcome?.overridden
                ? 'Undo override'
                : outcome?.correct ? 'Actually, mark incorrect' : 'Actually, mark correct'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
