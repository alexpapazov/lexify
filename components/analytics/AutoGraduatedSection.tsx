'use client'

/**
 * AutoGraduatedSection — cards that graduated automatically (import/bulk "already known") rather than
 * by climbing the whole learning ladder. Each is tagged Accelerated (import_known — flips to
 * self-graded after its first correct typed review) or Auto (bulk_known). Filterable by language;
 * each links to its deck.
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { langName } from '@/lib/languages'
import { displayText } from '@/lib/cardText'
import { routes } from '@/lib/routes'

interface AutoCard { cardId: string; front: string; back: string; source: string; accelerated: boolean; deckId: string | null; deckName: string | null }

export function AutoGraduatedSection() {
  const [cards, setCards] = useState<AutoCard[]>([])
  const [loading, setLoading] = useState(true)
  const [langFilter, setLangFilter] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setLoading(false); return }
      const uid = session.user.id

      const { data: rows } = await supabase.from('card_states')
        .select('card_id, accelerated_mode, cards(front, back, source_language)')
        .eq('user_id', uid).eq('graduated', true).neq('review_direction', 'reverse')
        .neq('accelerated_mode', 'none')
      const list = rows ?? []
      const ids = list.map(r => r.card_id as string)

      const deckByCard = new Map<string, { id: string; name: string }>()
      if (ids.length) {
        const { data: links } = await supabase.from('deck_cards').select('card_id, decks(id, name)').in('card_id', ids)
        for (const l of (links ?? []) as unknown as { card_id: string; decks: { id: string; name: string } | null }[]) {
          if (l.decks && !deckByCard.has(l.card_id)) deckByCard.set(l.card_id, { id: l.decks.id, name: l.decks.name })
        }
      }

      const out: AutoCard[] = list.map(r => {
        const c = r.cards as unknown as { front: string; back: string; source_language: string } | null
        const deck = deckByCard.get(r.card_id as string)
        return {
          cardId: r.card_id as string,
          front: displayText(c?.front ?? ''), back: displayText(c?.back ?? ''),
          source: c?.source_language ?? '?',
          accelerated: (r.accelerated_mode as string) === 'import_known',
          deckId: deck?.id ?? null, deckName: deck?.name ?? null,
        }
      })
      setCards(out)
      setLoading(false)
    })()
  }, [])

  const langs = useMemo(() => [...new Set(cards.map(c => c.source))], [cards])
  const shown = langFilter ? cards.filter(c => c.source === langFilter) : cards

  if (loading) return null
  if (cards.length === 0) return null

  return (
    <div className="panel p-5 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-ink">Auto-graduated cards ({shown.length})</h2>
          <p className="text-xs text-ink-faint">Cards that skipped the learning ladder because they were marked already-known.</p>
        </div>
        {langs.length > 1 && (
          <div className="flex items-center gap-1 flex-wrap">
            <button onClick={() => setLangFilter(null)} className={`text-[11px] px-2 py-0.5 rounded-full ${!langFilter ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}>All</button>
            {langs.map(l => (
              <button key={l} onClick={() => setLangFilter(l)} className={`text-[11px] px-2 py-0.5 rounded-full ${langFilter === l ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}>{langName(l)}</button>
            ))}
          </div>
        )}
      </div>
      <div className="rounded-lg border border-line/10 divide-y divide-line/5 max-h-80 overflow-y-auto">
        {shown.map(c => {
          const inner = (
            <div className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${c.accelerated ? 'bg-accent/20 text-accent-soft' : 'bg-line/10 text-ink-muted'}`}>
                {c.accelerated ? 'Accelerated' : 'Auto'}
              </span>
              <span className="font-medium text-ink truncate max-w-[35%]">{c.front}</span>
              <span className="text-ink-faint">→</span>
              <span className="text-ink-muted truncate flex-1">{c.back}</span>
              {c.deckId && <span className="text-accent-soft text-xs shrink-0">{c.deckName ?? 'deck'} ↗</span>}
            </div>
          )
          return c.deckId
            ? <Link key={c.cardId} href={routes.deck(c.deckId, { card: c.cardId })} className="block hover:bg-surface-raised/50 transition-colors">{inner}</Link>
            : <div key={c.cardId}>{inner}</div>
        })}
      </div>
    </div>
  )
}
