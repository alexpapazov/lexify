'use client'

/**
 * components/session/ClozePrompt.tsx — a forward Due Now review's cloze prompt: the generated
 * target-language sentence with the reviewed word blanked out. The blank carries the card's gloss
 * (it IS the prompt — same pattern as the practice ClozePlayer), the sentence's translation sits
 * underneath. `filled` renders the answer into the blank once it's been graded or revealed.
 *
 * Rendered by TypingMode / FlashcardMode in place of the plain prompt text when a `cloze` prop is
 * supplied; the surrounding prompt panel (info/star/audio/? buttons) is unchanged.
 */

import type { ReviewCloze } from '@/lib/reviewCloze'

export function ClozePrompt({ cloze, filled }: { cloze: ReviewCloze; filled?: string | null }) {
  return (
    <div className="space-y-2.5 px-8 py-2">
      <p className="text-xl leading-relaxed text-ink">
        {cloze.before}
        {filled ? (
          <span className="text-success font-medium">{filled}</span>
        ) : (
          <span className="inline-block align-baseline border-b-2 border-accent/60 min-w-[6ch] mx-1 px-1">
            <span className="text-base italic text-accent-soft/90">{cloze.gloss}</span>
          </span>
        )}
        {cloze.after}
      </p>
      {cloze.translation.trim() !== '' && <p className="text-sm text-ink-muted italic">{cloze.translation}</p>}
    </div>
  )
}
