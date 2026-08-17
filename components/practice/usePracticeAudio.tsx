'use client'

/**
 * The practice-wide audio toggle: 🔊 in both players' headers, one shared preference.
 * localStorage rather than the profile — it's a device-level comfort setting (mute in the library,
 * on at home), same reasoning as the offline toggle.
 */

import { useState } from 'react'

const KEY = 'lexify-practice-audio'

export function usePracticeAudio(): [boolean, () => void] {
  const [on, setOn] = useState(() => typeof window === 'undefined' || localStorage.getItem(KEY) !== 'off')
  const toggle = () => setOn(prev => {
    const next = !prev
    try { localStorage.setItem(KEY, next ? 'on' : 'off') } catch { /* private mode */ }
    return next
  })
  return [on, toggle]
}

/** The toggle button itself, so the two players render it identically. */
export function AudioToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} aria-pressed={on}
      title={on ? 'Audio on — click to mute' : 'Audio off — click to unmute'}
      className={`text-sm transition-colors ${on ? 'text-accent-soft hover:text-accent' : 'text-ink-faint hover:text-ink-muted'}`}>
      {on ? '🔊' : '🔇'}
    </button>
  )
}
