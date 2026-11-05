'use client'

/**
 * components/practice/WordBankPlayer.tsx — the Word Bank practice player.
 *
 * ALL sentences are visible at once with ALL their blanks (user request 2026-10-19 — the whole
 * story on screen, filled in any order), each blank deliberately without gloss or translation:
 * context is the game. Chips (each chosen word in the inflected form its sentence uses, shuffled)
 * place two ways: TAP a chip to fill the selected blank (tap a blank to select it; defaults to
 * the first unsolved), or DRAG a chip onto any blank (HTML5 drag & drop — desktop; touch keeps
 * tap-to-place). Correct: the blank fills green, its translation reveals, the chip fades in place
 * (the bank never reflows). Wrong: chip and blank flash red, retry — mistakes count, nothing is
 * ever scheduled.
 *
 * Story style reads as one narrative top to bottom; sentences style is the same board with airier
 * spacing. Finish happens when every blank is filled.
 */

import { useEffect, useMemo, useState } from 'react'
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
  const [solved, setSolved] = useState<Set<number>>(new Set())      // item indexes
  const [used, setUsed] = useState<Set<number>>(new Set())          // chip ids
  const [selected, setSelected] = useState<number | null>(null)     // selected blank's item index
  const [wrongChip, setWrongChip] = useState<number | null>(null)
  const [wrongBlank, setWrongBlank] = useState<number | null>(null)
  const [mistakes, setMistakes] = useState(0)
  const [finished, setFinished] = useState(false)
  const [life, setLife] = useState(0)   // bumps on Play again → fresh shuffle

  const chips = useMemo<Chip[]>(
    () => shuffle(items.map((it, i) => ({ id: i, text: it.exercise.answer }))),
    [items, life],
  )

  const firstUnsolved = items.findIndex((_, i) => !solved.has(i))
  /** The blank a TAPPED chip fills: the explicitly selected one, else the first open blank. */
  const activeBlank = selected !== null && !solved.has(selected) ? selected : (firstUnsolved >= 0 ? firstUnsolved : null)

  useEffect(() => {
    if (!finished && items.length > 0 && solved.size === items.length) {
      const t = setTimeout(() => setFinished(true), 700)
      return () => clearTimeout(t)
    }
  }, [solved, items.length, finished])

  function place(chipId: number, itemIdx: number) {
    const chip = chips.find(c => c.id === chipId)
    const item = items[itemIdx]
    if (!chip || !item || finished || used.has(chipId) || solved.has(itemIdx)) return
    const correct = chip.text === item.exercise.answer
    onAttempt?.({ item, response: chip.text, correct })
    if (correct) {
      setUsed(prev => new Set(prev).add(chipId))
      setSolved(prev => new Set(prev).add(itemIdx))
      setSelected(null)   // selection falls back to the first open blank
    } else {
      setMistakes(m => m + 1)
      setWrongChip(chipId)
      setWrongBlank(itemIdx)
      setTimeout(() => { setWrongChip(null); setWrongBlank(null) }, 500)
    }
  }

  function playAgain() {
    setSolved(new Set())
    setUsed(new Set())
    setSelected(null)
    setWrongChip(null); setWrongBlank(null)
    setMistakes(0)
    setFinished(false)
    setLife(n => n + 1)
  }

  /** One sentence with its blank (selectable + a drop target) or its green answer once solved. */
  function sentenceLine(it: PreparedExercise, i: number) {
    const { sentence, answer } = it.exercise
    const at = sentence.indexOf(answer)
    const isSolved = solved.has(i)
    return (
      <div key={i} className={storyMode ? '' : 'py-1'}>
        <p className="text-xl leading-relaxed text-ink">
          {at < 0 ? sentence : (<>
            {sentence.slice(0, at)}
            {isSolved
              ? <span className="text-success font-medium">{answer}</span>
              : <button type="button"
                  onClick={() => setSelected(i)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); const id = Number(e.dataTransfer.getData('text/plain')); if (!Number.isNaN(id)) place(id, i) }}
                  aria-label={`Blank ${i + 1}`}
                  className={`inline-block align-baseline border-b-2 min-w-[6ch] mx-1 h-[1.4em] rounded-sm transition-colors ${
                    wrongBlank === i ? 'border-danger bg-danger/15'
                    : activeBlank === i ? 'border-accent bg-accent/10'
                    : 'border-line/40 hover:border-accent/60'}`}>
                  &nbsp;
                </button>}
            {sentence.slice(at + answer.length)}
          </>)}
        </p>
        {/* The translation stays hidden until the blank is solved — context is the game. */}
        {isSolved && it.exercise.translation && (
          <p className="text-xs text-ink-faint italic mt-0.5">{it.exercise.translation}</p>
        )}
      </div>
    )
  }

  if (finished) {
    const attempts = items.length + mistakes
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-4">
        <h1 className="text-xl font-semibold text-ink">Word bank done</h1>
        <p className="text-ink-muted text-sm">
          {items.length} blank{items.length !== 1 ? 's' : ''} filled · {mistakes} wrong pick{mistakes !== 1 ? 's' : ''} ·{' '}
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
        <span className="text-sm text-ink-muted tabular-nums">{solved.size} / {items.length}</span>
      </div>
      <div className="h-1 rounded-full bg-surface overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${(solved.size / Math.max(1, items.length)) * 100}%` }} />
      </div>

      {/* The whole board at once — a story reads top to bottom; fill the blanks in any order. */}
      <div className={`panel py-8 px-6 ${storyMode ? 'space-y-3' : 'space-y-4'}`}>
        {items.map((it, i) => sentenceLine(it, i))}
      </div>

      <p className="text-xs text-ink-faint text-center">
        Tap a chip to fill the highlighted blank — or drag it onto any blank. Tap a blank to aim at it.
      </p>

      {/* The bank. Consumed chips stay in place (faded) so the grid doesn't jump around. */}
      <div className="flex flex-wrap justify-center gap-2">
        {chips.map(chip => (
          <button key={chip.id}
            draggable={!used.has(chip.id)}
            onDragStart={e => { e.dataTransfer.setData('text/plain', String(chip.id)); e.dataTransfer.effectAllowed = 'move' }}
            onClick={() => { if (activeBlank !== null) place(chip.id, activeBlank) }}
            disabled={used.has(chip.id)}
            className={`px-3.5 py-2 rounded-lg border text-[15px] transition-colors ${
              used.has(chip.id) ? 'border-line/10 text-ink-faint/40 line-through'
              : wrongChip === chip.id ? 'border-danger bg-danger/15 text-danger'
              : 'border-line/20 text-ink hover:border-accent/50 hover:text-accent-soft cursor-grab active:cursor-grabbing'}`}>
            {chip.text}
          </button>
        ))}
      </div>
    </div>
  )
}
