'use client'

/**
 * components/practice/WordBankPlayer.tsx — the Word Bank practice player (2026-10-19).
 *
 * Every chosen word sits in the BANK as a chip (the inflected form its sentence uses, shuffled).
 * One sentence shows at a time with a single blank and deliberately NO gloss and NO translation —
 * the whole game is picking the right chip from context (Duolingo's drag, as tap-to-place).
 * Correct: the chip is consumed, the answer fills in green, the translation reveals, Next.
 * Wrong: the chip flashes red and returns to the bank — same sentence, try again (mistakes count,
 * nothing is ever scheduled; practice stays schedule-neutral).
 *
 * Story style: the solved sentences accumulate above the current one, so the narrative builds as
 * you play. Sentences style: one at a time, nothing accumulates.
 */

import { useMemo, useState } from 'react'
import type { PreparedExercise } from '@/lib/practiceGenerate'

export interface BankAttempt {
  item:     PreparedExercise
  response: string
  correct:  boolean
}

interface Chip { id: number; text: string }

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

export function WordBankPlayer({ items, storyMode, onExit, onAttempt }: {
  items:     PreparedExercise[]
  storyMode: boolean
  onExit:    () => void
  onAttempt?: (a: BankAttempt) => void
}) {
  const [index, setIndex] = useState(0)
  const [used, setUsed] = useState<Set<number>>(new Set())
  const [solved, setSolved] = useState(false)
  const [wrongChip, setWrongChip] = useState<number | null>(null)
  const [mistakes, setMistakes] = useState(0)
  const [finished, setFinished] = useState(false)
  const [life, setLife] = useState(0)   // bumps on Play again → fresh shuffle

  const chips = useMemo<Chip[]>(
    () => shuffle(items.map((it, i) => ({ id: i, text: it.exercise.answer }))),
    [items, life],
  )
  const current = items[index]

  function place(chip: Chip) {
    if (solved || finished || !current || used.has(chip.id)) return
    // Correct by TEXT: two identical surfaces are interchangeable — the tapped chip is consumed.
    const correct = chip.text === current.exercise.answer
    onAttempt?.({ item: current, response: chip.text, correct })
    if (correct) {
      setUsed(prev => new Set(prev).add(chip.id))
      setSolved(true)
    } else {
      setMistakes(m => m + 1)
      setWrongChip(chip.id)
      setTimeout(() => setWrongChip(null), 500)
    }
  }

  function next() {
    setSolved(false)
    if (index + 1 < items.length) setIndex(i => i + 1)
    else setFinished(true)
  }

  function playAgain() {
    setIndex(0)
    setUsed(new Set())
    setSolved(false)
    setWrongChip(null)
    setMistakes(0)
    setFinished(false)
    setLife(n => n + 1)
  }

  /** before / filled-or-blank / after — the parser guarantees the answer occurs in the sentence. */
  function sentenceLine(it: PreparedExercise, filled: boolean, key?: string | number) {
    const { sentence, answer } = it.exercise
    const at = sentence.indexOf(answer)
    if (at < 0) return <p key={key} className="text-xl leading-relaxed text-ink">{sentence}</p>
    return (
      <p key={key} className="text-xl leading-relaxed text-ink">
        {sentence.slice(0, at)}
        {filled
          ? <span className="text-success font-medium">{answer}</span>
          : <span className="inline-block align-baseline border-b-2 border-accent/60 min-w-[6ch] mx-1" aria-label="blank">&nbsp;</span>}
        {sentence.slice(at + answer.length)}
      </p>
    )
  }

  if (finished) {
    const attempts = items.length + mistakes
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-4">
        <h1 className="text-xl font-semibold text-ink">Word bank done</h1>
        <p className="text-ink-muted text-sm">
          {items.length} sentence{items.length !== 1 ? 's' : ''} · {mistakes} wrong pick{mistakes !== 1 ? 's' : ''} ·{' '}
          {Math.round((items.length / attempts) * 100)}% first-try. Nothing was scheduled — this was pure practice.
        </p>
        <div className="flex justify-center gap-3">
          <button className="btn-primary" onClick={playAgain}>Play again</button>
          <button className="btn-ghost" onClick={onExit}>Done</button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl mx-auto pb-12">
      <div className="flex items-center justify-between gap-4">
        <button onClick={onExit} className="text-sm text-ink-faint hover:text-ink transition-colors">✕ End practice</button>
        <span className="text-sm text-ink-muted tabular-nums">{index + 1} / {items.length}</span>
      </div>
      <div className="h-1 rounded-full bg-surface overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${(index / items.length) * 100}%` }} />
      </div>

      <div className="panel py-8 px-6 space-y-4">
        {/* Story style: the narrative so far builds up above the working sentence. */}
        {storyMode && index > 0 && (
          <div className="space-y-2 border-b border-line/10 pb-4">
            {items.slice(0, index).map((it, i) => sentenceLine(it, true, i))}
          </div>
        )}
        {current && sentenceLine(current, solved)}
        {/* The translation exists but is deliberately hidden until solved — context is the game. */}
        {solved && current && current.exercise.translation && (
          <p className="text-sm text-ink-muted italic">{current.exercise.translation}</p>
        )}
      </div>

      {/* The bank. Consumed chips stay in place (faded) so the grid doesn't jump around. */}
      <div className="flex flex-wrap justify-center gap-2">
        {chips.map(chip => (
          <button key={chip.id} onClick={() => place(chip)} disabled={used.has(chip.id) || solved}
            className={`px-3.5 py-2 rounded-lg border text-[15px] transition-colors ${
              used.has(chip.id) ? 'border-line/10 text-ink-faint/40 line-through'
              : wrongChip === chip.id ? 'border-danger bg-danger/15 text-danger'
              : 'border-line/20 text-ink hover:border-accent/50 hover:text-accent-soft'}`}>
            {chip.text}
          </button>
        ))}
      </div>

      {solved && (
        <div className="flex justify-center">
          <button className="btn-primary px-10" onClick={next} autoFocus>
            {index + 1 < items.length ? 'Next' : 'Finish'}
          </button>
        </div>
      )}
    </div>
  )
}
