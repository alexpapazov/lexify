'use client'

/**
 * Searchable language picker — type to filter the supported-language list,
 * click (or press Enter) to select. Falls back to showing the currently
 * selected language's name when not focused/open.
 */

import { useEffect, useRef, useState } from 'react'
import { LANGUAGES } from '@/lib/languages'

export function LanguageCombobox({ label, value, onChange, className, placeholder = 'Select a language…' }: {
  label?:       string
  value:        string
  onChange:     (code: string) => void
  className?:   string
  placeholder?: string
}) {
  const [query,     setQuery]     = useState('')
  const [open,      setOpen]      = useState(false)
  const [highlight, setHighlight] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const selected = LANGUAGES.find(l => l.code === value)

  const filtered = query.trim()
    ? LANGUAGES.filter(l => l.name.toLowerCase().includes(query.trim().toLowerCase()))
    : LANGUAGES

  const displayValue = open ? query : (selected?.name ?? '')

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  useEffect(() => {
    setHighlight(0)
  }, [query, open])

  function selectLanguage(code: string) {
    onChange(code)
    setQuery('')
    setOpen(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { setOpen(true); setQuery('') }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const match = filtered[highlight]
      if (match) selectLanguage(match.code)
    } else if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div className={`space-y-1.5 ${className ?? ''}`} ref={containerRef}>
      {label && <span className="text-sm text-ink-muted">{label}</span>}
      <div className="relative">
        <input
          className="input text-sm w-full"
          placeholder={placeholder}
          value={displayValue}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => { setQuery(''); setOpen(true) }}
          onKeyDown={handleKeyDown}
        />
        {open && (
          <div className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-white/10 bg-surface shadow-lg">
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-sm text-ink-faint">No matches</div>
            )}
            {filtered.map((l, i) => (
              <button
                key={l.code}
                type="button"
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => selectLanguage(l.code)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  i === highlight ? 'bg-white/10' : 'hover:bg-white/5'
                } ${l.code === value ? 'text-accent' : 'text-ink'}`}
              >
                {l.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
