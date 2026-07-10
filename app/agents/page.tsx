'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { gatherScopedCards, analyzeBatch, applySplit, chunk } from '@/lib/agents/cardEditor'
import type { ScopedCard, SplitProposal } from '@/lib/agents/cardEditor'
import type { Deck, Grant } from '@/domain'

const BATCH_SIZE = 20
type Phase = 'setup' | 'gathering' | 'analyzing' | 'review' | 'done'

export default function AgentsPage() {
  const [userId, setUserId] = useState<string | null>(null)
  const [decks, setDecks] = useState<Deck[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [phase, setPhase] = useState<Phase>('setup')
  const [queue, setQueue] = useState<SplitProposal[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanned, setScanned] = useState(0)
  const [total, setTotal] = useState(0)
  const [approved, setApproved] = useState(0)
  const [denied, setDenied] = useState(0)

  const batchesRef  = useRef<ScopedCard[][]>([])
  const nextBatchRef = useRef(0)

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      setUserId(session.user.id)
      setDecks(await new SupabaseDeckRepository().list(session.user.id))
    })()
  }, [])

  const pairs = Array.from(new Set(decks.map(d => `${d.sourceLanguage}|${d.targetLanguage}`)))
  function toggle(key: string) {
    setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }
  function scopedDeckIds(): string[] {
    const ids = new Set<string>()
    for (const key of selected) {
      if (key.startsWith('deck:')) ids.add(key.slice(5))
      else if (key.startsWith('pair:')) decks.filter(d => `${d.sourceLanguage}|${d.targetLanguage}` === key.slice(5)).forEach(d => ids.add(d.id))
    }
    return [...ids]
  }
  const inScopeDeckCount = scopedDeckIds().length

  // Analyze batches until we get at least one proposal, or run out (→ done).
  async function fillQueue() {
    while (nextBatchRef.current < batchesRef.current.length) {
      setPhase('analyzing')
      const batch = batchesRef.current[nextBatchRef.current++]!
      setScanned(s => s + batch.length)
      try {
        const props = await analyzeBatch(batch)
        if (props.length) { setQueue(props); setPhase('review'); return }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e)); setPhase('review'); return
      }
    }
    setPhase('done')
  }

  async function run() {
    if (!userId || selected.size === 0) return
    setPhase('gathering'); setError(null); setScanned(0); setApproved(0); setDenied(0)
    try {
      const grant: Grant = { operations: ['edit', 'create'], languages: [], folderIds: [], deckIds: scopedDeckIds(), dryRunOnly: false }
      const cards = await gatherScopedCards(userId, grant)
      setTotal(cards.length)
      batchesRef.current = chunk(cards, BATCH_SIZE)
      nextBatchRef.current = 0
      await fillQueue()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setPhase('setup')
    }
  }

  function advance() {
    const next = queue.slice(1)
    setQueue(next)
    if (next.length === 0) fillQueue()
  }
  async function approve() {
    const current = queue[0]
    if (!current || !userId || busy) return
    setBusy(true)
    try { await applySplit(userId, current); setApproved(a => a + 1) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
    advance()
  }
  function deny() { setDenied(d => d + 1); advance() }

  const current = queue[0]

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Card editor agent</h1>
        <p className="text-sm text-ink-muted mt-1">Scans your cards in batches of {BATCH_SIZE} and proposes splitting any whose gloss holds two distinct meanings. You approve or deny each one; approved changes are applied immediately.</p>
      </div>

      {/* ── Setup ── */}
      {phase === 'setup' && (
        <div className="panel space-y-4">
          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <label className="text-xs text-ink-faint">Scope — select what the agent may touch</label>
              <span className="text-xs text-ink-faint">{inScopeDeckCount} deck{inScopeDeckCount === 1 ? '' : 's'} in scope</span>
            </div>
            <div className="border border-white/10 rounded-lg max-h-64 overflow-y-auto divide-y divide-white/5">
              {pairs.length > 0 && (
                <>
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-ink-faint bg-surface/50 sticky top-0">Whole language pair</div>
                  {pairs.map(p => {
                    const key = `pair:${p}`
                    return (
                      <label key={key} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface/40">
                        <input type="checkbox" className="accent-accent" checked={selected.has(key)} onChange={() => toggle(key)} />
                        <span className="text-sm text-ink">All {p.replace('|', ' → ')} decks</span>
                      </label>
                    )
                  })}
                </>
              )}
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-ink-faint bg-surface/50 sticky top-0">Single deck</div>
              {decks.map(d => {
                const key = `deck:${d.id}`
                return (
                  <label key={key} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface/40">
                    <input type="checkbox" className="accent-accent" checked={selected.has(key)} onChange={() => toggle(key)} />
                    <span className="text-sm text-ink truncate">{d.name} <span className="text-ink-faint">({d.sourceLanguage}→{d.targetLanguage})</span></span>
                  </label>
                )
              })}
            </div>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button className="btn-primary w-full" disabled={selected.size === 0 || !userId} onClick={run}>Start scanning</button>
        </div>
      )}

      {/* ── Progress ── */}
      {phase !== 'setup' && (
        <p className="text-xs text-ink-faint text-center">
          Scanned {scanned}{total ? ` / ${total}` : ''} cards · <span className="text-success">{approved} applied</span> · <span className="text-ink-muted">{denied} skipped</span>
        </p>
      )}

      {(phase === 'gathering' || phase === 'analyzing') && (
        <p className="text-sm text-ink-muted text-center">{phase === 'gathering' ? 'Gathering cards…' : 'Analyzing next batch…'}</p>
      )}

      {/* ── Per-split review ── */}
      {phase === 'review' && current && (
        <div className="panel space-y-4">
          {error && <p className="text-sm text-danger">{error}</p>}
          <p className="text-xs text-ink-faint">Split this card into {1 + current.extraBacks.length}?</p>

          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-ink-faint">Before</p>
            <div className="rounded-lg border border-white/10 px-3 py-2 text-sm font-mono text-ink-muted">
              {current.front} <span className="text-ink-faint">=</span> {current.back}
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-ink-faint">After</p>
            <div className="rounded-lg border border-success/40 px-3 py-2 text-sm font-mono text-ink">
              {current.front} <span className="text-ink-faint">=</span> {current.primaryBack}
            </div>
            {current.extraBacks.map((b, i) => (
              <div key={i} className="rounded-lg border border-success/40 px-3 py-2 text-sm font-mono text-ink">
                <span className="text-success">＋ new</span> · {current.front} <span className="text-ink-faint">=</span> {b}
              </div>
            ))}
          </div>

          <p className="text-xs text-ink-faint">{current.reason}</p>

          <div className="flex gap-3">
            <button className="btn-ghost flex-1" disabled={busy} onClick={deny}>Deny</button>
            <button className="btn-primary flex-1" disabled={busy} onClick={approve}>{busy ? 'Applying…' : 'Approve'}</button>
          </div>
        </div>
      )}

      {/* ── Done ── */}
      {phase === 'done' && (
        <div className="panel text-center space-y-3">
          <p className="text-ink">Done — scanned {scanned} cards, applied {approved} split{approved === 1 ? '' : 's'}, skipped {denied}.</p>
          <button className="btn-ghost" onClick={() => { setPhase('setup'); setQueue([]) }}>Run again</button>
        </div>
      )}
    </div>
  )
}
