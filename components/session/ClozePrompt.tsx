'use client'

/**
 * components/session/ClozePrompt.tsx — a forward Due Now review's cloze prompt: the generated
 * target-language sentence with the reviewed word blanked out. The blank carries the card's gloss
 * (it IS the prompt — same pattern as the practice ClozePlayer), the sentence's translation sits
 * underneath. `filled` renders the answer into the blank once it's been graded or revealed.
 *
 * Every word is TAPPABLE for its meaning, exactly like the practice player: tapping shows a small
 * "word — gloss" panel under the translation (glosses come from the generation-time token
 * annotations, stored with the sentence). Tapping the same word again, or an unknown one, clears
 * or explains. Sentences stored before token glosses shipped show "no translation available".
 *
 * Rendered by TypingMode / FlashcardMode in place of the plain prompt text when a `cloze` prop is
 * supplied; the surrounding prompt panel (info/star/audio/? buttons) is unchanged.
 */

import { useState } from 'react'
import type { ReviewCloze } from '@/lib/reviewCloze'
import { segmentWords } from '@/lib/practiceRender'

export function ClozePrompt({ cloze, filled, hideMeaning }: {
  cloze: ReviewCloze
  filled?: string | null
  /** Dictation cloze, pre-answer: the sentence shows with an EMPTY blank and no translation line —
   *  any native meaning on screen would turn a transcription test into a meaning test (user
   *  decision 2026-09-10). The reveal (once `filled`/graded) passes false and shows everything. */
  hideMeaning?: boolean
}) {
  const [picked, setPicked] = useState<string | null>(null)

  const glossFor = (text: string): string | null => {
    const key = text.toLowerCase()
    return cloze.tokens.find(t => t.text.toLowerCase() === key)?.gloss?.trim() || null
  }

  const word = (text: string, i: number | string) => (
    <button key={i} type="button"
      onClick={() => setPicked(p => p === text ? null : text)}
      className={`rounded-sm transition-colors cursor-pointer ${picked === text ? 'bg-accent/15 text-accent-soft' : 'hover:bg-accent/10 hover:text-accent-soft'}`}>
      {text}
    </button>
  )
  const render = (text: string) => segmentWords(text).map((run, i) =>
    run.isWord ? word(run.text, i) : <span key={i}>{run.text}</span>)

  return (
    <div className="space-y-2.5 px-8 py-2">
      <p className="text-xl leading-relaxed text-ink">
        {render(cloze.before)}
        {filled ? (
          <span className="text-success font-medium">{filled}</span>
        ) : (
          <span className="inline-block align-baseline border-b-2 border-accent/60 min-w-[6ch] mx-1 px-1">
            <span className="text-base italic text-accent-soft/90">{hideMeaning ? '\u00A0' : cloze.gloss}</span>
          </span>
        )}
        {render(cloze.after)}
      </p>
      {!hideMeaning && cloze.translation.trim() !== '' && <p className="text-sm text-ink-muted italic">{cloze.translation}</p>}
      {picked && (
        <p className="text-sm">
          <span className="text-ink font-medium">{picked}</span>
          {glossFor(picked)
            ? <span className="text-ink-muted"> — {glossFor(picked)}</span>
            : <span className="text-ink-faint"> — no translation available</span>}
        </p>
      )}
    </div>
  )
}
