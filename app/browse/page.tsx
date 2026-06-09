'use client'

import { useState } from 'react'

const PLACEHOLDER_DECKS = [
  { id: '1', name: 'Spanish 501 Verbs',    author: 'maria_learns', cardCount: 501 },
  { id: '2', name: 'French DELF B2 Vocab', author: 'pierre42',     cardCount: 320 },
  { id: '3', name: 'HSK 4 Characters',     author: 'mingxiao',     cardCount: 600 },
]

export default function BrowsePage() {
  const [query, setQuery] = useState('')
  const filtered = PLACEHOLDER_DECKS.filter(d =>
    d.name.toLowerCase().includes(query.toLowerCase())
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Browse</h1>
        <p className="text-ink-muted mt-1">Find others&apos; word lists.</p>
      </div>

      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
        </span>
        <input
          type="search"
          placeholder="Search decks..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="input pl-9"
        />
      </div>

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <p className="text-ink-muted text-sm">No decks found.</p>
        ) : filtered.map(deck => (
          <div key={deck.id} className="panel flex items-center justify-between">
            <div>
              <div className="text-ink font-medium">{deck.name}</div>
              <div className="text-xs text-ink-muted mt-0.5">by {deck.author} · {deck.cardCount} cards</div>
            </div>
            <button className="btn-ghost text-sm py-1.5 px-3">Clone deck</button>
          </div>
        ))}
      </div>
    </div>
  )
}
