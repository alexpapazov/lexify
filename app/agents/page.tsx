'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { gatherScopedCards, analyzeBatch, applyProposal, undoEdit, chunk, findDuplicates } from '@/lib/agents/cardEditor'
import type { ScopedCard, EditProposal } from '@/lib/agents/cardEditor'
import type { Deck, Grant } from '@/domain'

const BATCH_SIZE = 20
type Phase = 'setup' | 'gathering' | 'analyzing' | 'review' | 'done'

const PLACEHOLDER = 'e.g. "Split any card whose gloss has two distinct meanings", "Remove the leading \'to \' from every verb gloss", "Add the gender in parentheses to noun glosses", "Delete duplicate cards"…'

export default function AgentsPage() {
  const [userId, setUserId] = useState<string | null>(null)
  const [decks, setDecks] = useState<Deck[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [task, setTask] = useState('')
  const [phase, setPhase] = useState<Phase>('setup')
  const [queue, setQueue] = useState<EditProposal[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanned, setScanned] = useState(0)
  const [total, setTotal] = useState(0)
  const [approved, setApproved] = useState(0)
  const [denied, setDenied] = useState(0)
  const [lastApplied, setLastApplied] = useState<EditProposal | null>(null)  // last approved text edit (Cmd+Z undoable)

  const batchesRef = useRef<ScopedCard[][]>([])
  const nextBatchRef = useRef(0)
  const taskRef = useRef('')
  const bufferRef = useRef<EditProposal[]>([])   // next non-empty batch, prefetched in the background
  const prefetchingRef = useRef(false)

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

  // Analyzes one batch (advancing the cursor). Returns its proposals, or null when out of batches.
  async function analyzeOne(): Promise<EditProposal[] | null> {
    if (nextBatchRef.current >= batchesRef.current.length) return null
    const batch = batchesRef.current[nextBatchRef.current++]!
    setScanned(s => s + batch.length)
    try { return await analyzeBatch(batch, taskRef.current) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return [] }
  }

  // Background: keep the buffer topped with the next batch that actually has proposals.
  async function prefetch() {
    if (prefetchingRef.current || bufferRef.current.length > 0) return
    prefetchingRef.current = true
    try {
      while (bufferRef.current.length === 0 && nextBatchRef.current < batchesRef.current.length) {
        const props = await analyzeOne()
        if (props && props.length) { bufferRef.current = props; break }
      }
    } finally { prefetchingRef.current = false }
  }

  // Load the next set of proposals to review: instantly from the buffer if ready, else analyze.
  async function loadNext() {
    if (bufferRef.current.length) { setQueue(bufferRef.current); bufferRef.current = []; setPhase('review'); prefetch(); return }
    setPhase('analyzing')
    while (nextBatchRef.current < batchesRef.current.length) {
      const props = await analyzeOne()
      if (props && props.length) { setQueue(props); setPhase('review'); prefetch(); return }
    }
    setPhase('done')
  }

  async function run() {
    if (!userId || selected.size === 0 || !task.trim()) return
    taskRef.current = task.trim()
    setPhase('gathering'); setError(null); setScanned(0); setApproved(0); setDenied(0)
    bufferRef.current = []
    try {
      const grant: Grant = { operations: ['edit', 'create', 'delete'], languages: [], folderIds: [], deckIds: scopedDeckIds(), dryRunOnly: false }
      const cards = await gatherScopedCards(userId, grant)
      setTotal(cards.length)
      batchesRef.current = chunk(cards, BATCH_SIZE)
      nextBatchRef.current = 0
      await loadNext()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setPhase('setup')
    }
  }

  // Deterministic De-dupe (no AI): find TRUE duplicates (front AND back match) in the selected scope
  // — or all decks if none selected — and queue a delete for all but one of each. Same approve/deny UI.
  async function runDedupe() {
    if (!userId || busy) return
    const deckIds = scopedDeckIds().length ? scopedDeckIds() : decks.map(d => d.id)
    if (deckIds.length === 0) return
    taskRef.current = 'De-dupe'
    setPhase('gathering'); setError(null); setScanned(0); setApproved(0); setDenied(0)
    bufferRef.current = []; batchesRef.current = []; nextBatchRef.current = 0
    try {
      const grant: Grant = { operations: ['edit', 'create', 'delete'], languages: [], folderIds: [], deckIds, dryRunOnly: false }
      const cards = await gatherScopedCards(userId, grant)
      setTotal(cards.length); setScanned(cards.length)
      const dups = findDuplicates(cards)
      if (dups.length === 0) setPhase('done')
      else { setQueue(dups); setPhase('review') }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setPhase('setup')
    }
  }

  function advance() {
    const next = queue.slice(1)
    if (next.length > 0) { setQueue(next); prefetch() }   // keep buffering the next batch while reviewing
    else loadNext()
  }
  async function approve() {
    const current = queue[0]
    if (!current || !userId || busy) return
    setBusy(true)
    try { await applyProposal(userId, current); setApproved(a => a + 1); setLastApplied(current.action === 'edit' ? current : null) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
    advance()
  }
  function deny() { setDenied(d => d + 1); setLastApplied(null); advance() }

  function exit() {
    setPhase('setup'); setQueue([]); bufferRef.current = []; setLastApplied(null)
  }

  // Cmd/Ctrl+Z undoes the last approved TEXT edit and re-shows it to decide again.
  useEffect(() => {
    async function onKey(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z')) return
      const p = lastApplied
      if (!p || p.action !== 'edit' || !userId || busy) return
      e.preventDefault()
      setBusy(true)
      try {
        await undoEdit(userId, p)
        setApproved(a => Math.max(0, a - 1))
        setLastApplied(null)
        setQueue(q => [p, ...q])
        setPhase('review')
      } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
      setBusy(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lastApplied, userId, busy])

  const current = queue[0]

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Card editor agent</h1>
        <p className="text-sm text-ink-muted mt-1">Tell it what to change, pick which cards it may touch, and it scans them in batches of {BATCH_SIZE}. You approve or deny each proposed change; approved ones are applied immediately.</p>
      </div>

      {phase === 'setup' && (
        <div className="panel space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-ink-faint">Common tasks</label>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={runDedupe} disabled={!userId || busy}
                className="text-xs px-3 py-1.5 rounded-full border border-danger/30 text-ink hover:bg-danger/10 disabled:opacity-40 transition-colors">
                🧹 De-dupe
              </button>
              <button type="button" onClick={() => setTask("Remove the leading 'to ' from every verb gloss (the back), e.g. 'to run' → 'run'. Only touch verbs.")}
                className="text-xs px-3 py-1.5 rounded-full border border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40 transition-colors">
                Strip “to ” from verbs
              </button>
              <button type="button" onClick={() => setTask('For every noun card, append the grammatical gender in parentheses to the gloss if it is missing, e.g. "el gato" gloss "cat" → "cat (m)".')}
                className="text-xs px-3 py-1.5 rounded-full border border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40 transition-colors">
                Add noun gender
              </button>
            </div>
            <p className="text-[10px] text-ink-faint">De-dupe runs instantly on the selected scope (or all decks if none selected) — it finds cards with the same front AND back and proposes deleting all but one. The others fill the box above; pick scope, then Start scanning.</p>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-ink-faint">What should the card editor do?</label>
            <textarea className="input min-h-[90px]" value={task} onChange={e => setTask(e.target.value)} placeholder={PLACEHOLDER} />
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <label className="text-xs text-ink-faint">Scope — select what the agent may touch</label>
              <span className="text-xs text-ink-faint">{inScopeDeckCount} deck{inScopeDeckCount === 1 ? '' : 's'} in scope</span>
            </div>
            <div className="border border-line/10 rounded-lg max-h-56 overflow-y-auto divide-y divide-line/5">
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
          <button className="btn-primary w-full" disabled={selected.size === 0 || !task.trim() || !userId} onClick={run}>Start scanning</button>
        </div>
      )}

      {phase !== 'setup' && (
        <div className="flex items-center justify-center gap-4 text-xs">
          <button onClick={exit} className="text-ink-faint hover:text-ink">✕ Exit</button>
          <p className="text-ink-faint">
            Scanned {scanned}{total ? ` / ${total}` : ''} cards · <span className="text-success">{approved} applied</span> · <span className="text-ink-muted">{denied} skipped</span>
          </p>
        </div>
      )}

      {(phase === 'gathering' || phase === 'analyzing') && (
        <p className="text-sm text-ink-muted text-center">{phase === 'gathering' ? 'Gathering cards…' : 'Analyzing next batch…'}</p>
      )}

      {phase === 'review' && current && (
        <div className="panel space-y-4">
          {error && <p className="text-sm text-danger">{error}</p>}
          <ProposalView p={current} />
          <p className="text-xs text-ink-faint">{current.reason}</p>
          <div className="flex gap-3">
            <button className="btn-ghost flex-1" disabled={busy} onClick={deny}>Deny</button>
            <button className="btn-primary flex-1" disabled={busy} onClick={approve}>{busy ? 'Applying…' : 'Approve'}</button>
          </div>
          {lastApplied && <p className="text-[10px] text-ink-faint text-center">Last approval can be undone — press ⌘Z / Ctrl+Z</p>}
        </div>
      )}

      {phase === 'done' && (
        <div className="panel text-center space-y-3">
          <p className="text-ink">Done — scanned {scanned} cards, applied {approved} change{approved === 1 ? '' : 's'}, skipped {denied}.</p>
          <button className="btn-ghost" onClick={() => { setPhase('setup'); setQueue([]) }}>Run again</button>
        </div>
      )}
    </div>
  )
}

function Row({ tone, children }: { tone: 'before' | 'after' | 'del'; children: React.ReactNode }) {
  const cls = tone === 'after' ? 'border-success/40 text-ink' : tone === 'del' ? 'border-danger/40 text-ink-muted line-through' : 'border-line/10 text-ink-muted'
  return <div className={`rounded-lg border px-3 py-2 text-sm font-mono ${cls}`}>{children}</div>
}

function ProposalView({ p }: { p: EditProposal }) {
  if (p.action === 'delete') {
    return (
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-wider text-danger">Delete</p>
        <Row tone="del">{p.front} <span className="opacity-60">=</span> {p.back}</Row>
      </div>
    )
  }
  if (p.action === 'split') {
    return (
      <div className="space-y-3">
        <div className="space-y-1"><p className="text-[10px] uppercase tracking-wider text-ink-faint">Before</p><Row tone="before">{p.front} <span className="opacity-60">=</span> {p.back}</Row></div>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-ink-faint">After (split into {1 + (p.extraBacks?.length ?? 0)})</p>
          <Row tone="after">{p.front} <span className="opacity-60">=</span> {p.primaryBack}</Row>
          {(p.extraBacks ?? []).map((b, i) => <Row key={i} tone="after"><span className="text-success">＋ new</span> · {p.front} <span className="opacity-60">=</span> {b}</Row>)}
        </div>
      </div>
    )
  }
  // edit — show current vs. proposed text
  const afterFront = p.newFront !== undefined ? p.newFront : p.front
  const afterBack  = p.newBack  !== undefined ? p.newBack  : p.back
  return (
    <div className="space-y-3">
      <div className="space-y-1"><p className="text-[10px] uppercase tracking-wider text-ink-faint">Before</p><Row tone="before">{p.front} <span className="opacity-60">=</span> {p.back}</Row></div>
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-wider text-ink-faint">After</p>
        <Row tone="after">{afterFront} <span className="opacity-60">=</span> {afterBack}</Row>
      </div>
    </div>
  )
}
