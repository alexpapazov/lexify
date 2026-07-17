'use client'

/**
 * Thumb-reachable "Undo" button for touch devices (the mobile equivalent of ⌘Z).
 * Fixed to the bottom-right so it clears the rating buttons; only shown when there's
 * something to undo. Harmless on desktop, where it mirrors the ⌘Z shortcut.
 */
export function UndoFab({ show, onUndo }: { show: boolean; onUndo: () => void }) {
  if (!show) return null
  return (
    <button
      onClick={onUndo}
      title="Undo last answer (⌘Z)"
      aria-label="Undo last answer"
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-line/10 bg-surface-raised/95 px-4 py-2.5 text-sm font-medium text-ink-muted shadow-lg backdrop-blur transition active:scale-95 hover:text-ink"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
      </svg>
      Undo
    </button>
  )
}
