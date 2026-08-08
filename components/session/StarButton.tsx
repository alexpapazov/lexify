'use client'

/**
 * The star in the TOP-LEFT corner of a study card's prompt panel — the mirror of `CardInfoButton`
 * on the right. Marks a card to come back to, in every study mode.
 *
 * Optimistic: the star fills the moment it's pressed and the write goes off in the background, so a
 * one-tap gesture never blocks the card. If the write fails the star reverts — silently, because a
 * failed star is not worth an error banner mid-session, and pressing again retries.
 *
 * The containing panel must be `relative`.
 */

import { useEffect, useState } from 'react'

export function StarButton({ starred, onToggle }: {
  starred:  boolean
  /** Persists the new value. Rejecting reverts the star. */
  onToggle: (next: boolean) => Promise<void>
}) {
  const [on, setOn]       = useState(starred)
  const [busy, setBusy]   = useState(false)

  // The card under this button changes as the session advances; follow the prop.
  useEffect(() => { setOn(starred) }, [starred])

  async function toggle() {
    if (busy) return
    const next = !on
    setOn(next)
    setBusy(true)
    try {
      await onToggle(next)
    } catch {
      setOn(!next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={() => void toggle()}
      title={on ? 'Starred — click to unstar' : 'Star this card'}
      aria-pressed={on}
      className={`absolute top-3 left-3 z-10 w-5 h-5 flex items-center justify-center transition-colors ${
        on ? 'text-warning hover:text-warning/80' : 'text-ink-faint hover:text-ink-muted'
      }`}
    >
      <svg viewBox="0 0 24 24" className="w-4 h-4"
        fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.4l-5.81 3.05 1.11-6.47-4.7-4.58 6.5-.95L12 2.5z" />
      </svg>
    </button>
  )
}
