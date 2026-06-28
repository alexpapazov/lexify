'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { displayText } from '@/lib/cardText'

interface DayEntry {
  date: string
  cards: { front: string; back: string; cardId: string }[]
}

export default function ProgressPage() {
  const [days,    setDays]    = useState<DayEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setLoading(false); return }
      const userId = session.user.id

      // Fetch all card states that have an introduced_date
      const { data: states, error: statesError } = await supabase
        .from('card_states')
        .select('card_id, introduced_date')
        .eq('user_id', userId)
        .not('introduced_date', 'is', null)
        .order('introduced_date', { ascending: false })
      if (statesError || !states?.length) { setLoading(false); return }

      // Fetch the cards themselves
      const cardIds = states.map(s => s.card_id as string)
      const { data: cards } = await supabase
        .from('cards')
        .select('id, front, back')
        .in('id', cardIds)
      const cardMap = new Map((cards ?? []).map(c => [c.id as string, c as { id: string; front: string; back: string }]))

      // Group by date
      const byDate = new Map<string, DayEntry>()
      for (const s of states) {
        const date   = (s.introduced_date as string).slice(0, 10)
        const card   = cardMap.get(s.card_id as string)
        if (!card) continue
        if (!byDate.has(date)) byDate.set(date, { date, cards: [] })
        byDate.get(date)!.cards.push({ front: displayText(card.front), back: displayText(card.back), cardId: card.id })
      }

      setDays([...byDate.values()])
      // Auto-expand today and yesterday
      const today = new Date().toISOString().slice(0, 10)
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      setExpanded(new Set([today, yesterday]))
      setLoading(false)
    }
    void load()
  }, [])

  const totalCards = days.reduce((sum, d) => sum + d.cards.length, 0)

  function toggleDay(date: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(date) ? next.delete(date) : next.add(date)
      return next
    })
  }

  function formatDate(iso: string) {
    const d = new Date(iso + 'T12:00:00')
    const today     = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    if (iso === today)     return 'Today'
    if (iso === yesterday) return 'Yesterday'
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })
  }

  if (loading) return (
    <div className="max-w-2xl mx-auto px-4 pt-16 text-center text-ink-faint">Loading…</div>
  )

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Progress</h1>
        <p className="text-ink-muted text-sm mt-1">
          {totalCards} card{totalCards !== 1 ? 's' : ''} introduced across {days.length} day{days.length !== 1 ? 's' : ''}
        </p>
      </div>

      {days.length === 0 ? (
        <p className="text-ink-faint text-sm">No cards studied yet. Start a session to see your progress here.</p>
      ) : (
        <div className="space-y-2">
          {days.map(day => {
            const open = expanded.has(day.date)
            return (
              <div key={day.date} className="rounded-card border border-white/10 overflow-hidden">
                <button
                  onClick={() => toggleDay(day.date)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-raised/40 transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-ink">{formatDate(day.date)}</span>
                    <span className="text-xs text-ink-faint">{day.date}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="chip text-xs">{day.cards.length} new</span>
                    <span className="text-ink-faint text-xs">{open ? '▲' : '▼'}</span>
                  </div>
                </button>
                {open && (
                  <div className="border-t border-white/10 divide-y divide-white/5">
                    {day.cards.map(c => (
                      <div key={c.cardId} className="flex items-center gap-4 px-4 py-2.5">
                        <span className="text-sm font-medium text-ink w-40 truncate shrink-0">{c.front}</span>
                        <span className="text-sm text-ink-muted truncate">{c.back}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
