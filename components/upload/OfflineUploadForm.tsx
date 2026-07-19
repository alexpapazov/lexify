'use client'

/**
 * OfflineUploadForm — manual card entry available offline (no AI). Cards are written to the local
 * store immediately (studyable right away, distractors fall back to deck siblings) and queued so they
 * are created on the server when you next sync. Only decks you've downloaded can be targeted offline.
 */
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { localCreateCard } from '@/lib/offline/localRepos'
import { getLocalStore } from '@/lib/offline/localStore'
import { langName } from '@/lib/languages'
import type { Deck, Card } from '@/domain'

/** Split a line into [front, back] on the first tab / dash / comma. */
function splitPair(line: string): [string, string] | null {
  const m = line.match(/\t|\s+[—–-]\s+|\s*,\s*|\s*=\s*/)
  if (!m || m.index === undefined) return null
  const front = line.slice(0, m.index).trim()
  const back = line.slice(m.index + m[0].length).trim()
  if (!front || !back) return null
  return [front, back]
}

export function OfflineUploadForm() {
  const [decks, setDecks] = useState<Deck[]>([])
  const [deckId, setDeckId] = useState('')
  const [text, setText] = useState('')
  const [userId, setUserId] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedCount, setSavedCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      setUserId(session.user.id)
      const ds = await new SupabaseDeckRepository().list(session.user.id) // offline → local decks
      setDecks(ds)
      if (ds[0]) setDeckId(ds[0].id)
    })()
  }, [])

  const parsed = useMemo(() => text.split('\n').map(splitPair).filter((p): p is [string, string] => !!p), [text])
  const deck = decks.find(d => d.id === deckId)

  async function save() {
    if (!deck || parsed.length === 0 || !userId) return
    setSaving(true); setError(null); setSavedCount(null)
    try {
      const existing = (await new SupabaseCardRepository().listByDeck(deckId)).length
      const iso = new Date().toISOString()
      let i = 0
      for (const [front, back] of parsed) {
        const card: Card = {
          id: crypto.randomUUID(),
          ownerId: userId, sourceLanguage: deck.sourceLanguage, targetLanguage: deck.targetLanguage,
          front, back, hints: [], choices: null, position: existing + i,
          createdAt: iso, updatedAt: iso, deletedAt: null,
          synonymGroupId: null, register: null, region: null,
          syncedFromLanguages: [], originWords: [],
          audioGenerated: false, audioData: null, audioSource: null, audioSources: null, ipa: null,
        }
        await localCreateCard(card, deckId)
        i++
      }
      setSavedCount(parsed.length)
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Add cards</h1>
        <p className="text-ink-muted mt-1">Offline — cards are saved on this device and created in the cloud when you next sync. AI generation needs a connection.</p>
      </div>

      {decks.length === 0 ? (
        <div className="panel text-sm text-ink-muted">You don&apos;t have any downloaded decks to add to. Download a deck first (Settings → Offline).</div>
      ) : (
        <div className="panel space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm text-ink-muted">Deck</label>
            <select className="input" value={deckId} onChange={e => setDeckId(e.target.value)}>
              {decks.map(d => <option key={d.id} value={d.id}>{d.name} · {langName(d.sourceLanguage)} → {langName(d.targetLanguage)}</option>)}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm text-ink-muted">
              One card per line — {deck ? `${langName(deck.sourceLanguage)}` : 'word'} then {deck ? langName(deck.targetLanguage) : 'translation'}, separated by a tab, dash, or comma.
            </label>
            <textarea
              className="input font-mono text-sm min-h-[180px]"
              placeholder={'hola — hello\ngato, cat\ncorrer\tto run'}
              value={text}
              onChange={e => setText(e.target.value)}
            />
            <p className="text-xs text-ink-faint">{parsed.length} card{parsed.length === 1 ? '' : 's'} detected.</p>
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
          {savedCount !== null && <p className="text-xs text-success">✓ Saved {savedCount} card{savedCount === 1 ? '' : 's'} locally — they&apos;ll sync when you go online.</p>}

          <button onClick={() => void save()} disabled={saving || parsed.length === 0} className="btn-primary text-sm disabled:opacity-50">
            {saving ? 'Saving…' : `Add ${parsed.length || ''} card${parsed.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </div>
  )
}
