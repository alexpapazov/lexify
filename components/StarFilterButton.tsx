'use client'

/**
 * The ★ toggle that filters a card list down to starred cards.
 *
 * Deliberately NOT one of the stat boxes beside it: those are graduation states that partition the
 * library (unlearned + learning + graduated + dormant = everything), whereas starring cuts across
 * them — a card can be starred *and* graduated. Sitting it in that row would imply a mutual
 * exclusivity that doesn't exist, so it's a filter affordance on its own.
 */
export function StarFilterButton({ active, onToggle }: {
  active:   boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={active}
      title={active ? 'Showing starred cards — click to show all' : 'Show only starred cards'}
      className={`shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center transition-colors ${
        active
          ? 'border-warning/60 bg-warning/10 text-warning'
          : 'border-line/20 text-ink-faint hover:text-ink-muted hover:border-line/40'
      }`}
    >
      <svg viewBox="0 0 24 24" className="w-4 h-4"
        fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.4l-5.81 3.05 1.11-6.47-4.7-4.58 6.5-.95L12 2.5z" />
      </svg>
    </button>
  )
}
