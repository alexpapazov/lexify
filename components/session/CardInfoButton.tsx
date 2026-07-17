'use client'

/**
 * The "i" info/edit affordance shown in the top-right corner of a study
 * card's prompt panel. Opens the full card info/edit modal mid-session.
 * The containing panel must be `relative`.
 */
export function CardInfoButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Card info & edit"
      className="absolute top-3 right-3 z-10 text-ink-faint hover:text-ink transition-colors w-5 h-5 flex items-center justify-center rounded-full border border-line/10 hover:border-line/20 text-xs font-semibold italic leading-none"
    >
      i
    </button>
  )
}
