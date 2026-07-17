'use client'

import { useEffect, useState } from 'react'

type Theme = 'dark' | 'light'

/** Light/Dark theme switcher. Persists to localStorage (read by the no-flash script
 *  in app/layout.tsx) and toggles the `.light` class on <html>, which flips the CSS
 *  color variables defined in globals.css. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark')

  // Sync from the DOM/localStorage on mount (avoids SSR hydration mismatch).
  useEffect(() => {
    const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('lexify-theme')) as Theme | null
    setTheme(stored ?? (document.documentElement.classList.contains('light') ? 'light' : 'dark'))
  }, [])

  function apply(next: Theme) {
    setTheme(next)
    document.documentElement.classList.toggle('light', next === 'light')
    try { localStorage.setItem('lexify-theme', next) } catch { /* ignore */ }
  }

  const OPTIONS: { value: Theme; label: string; icon: string }[] = [
    { value: 'dark',  label: 'Dark',  icon: '🌙' },
    { value: 'light', label: 'Light', icon: '☀️' },
  ]

  return (
    <div className="inline-flex gap-1 p-1 rounded-lg bg-surface-raised">
      {OPTIONS.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => apply(o.value)}
          aria-pressed={theme === o.value}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            theme === o.value ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'
          }`}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  )
}
