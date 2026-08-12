'use client'

/**
 * app/agents/organizer/page.tsx — the card-organizer agent.
 *
 * Two ways in — usable together — one review queue out:
 *   • **Word documents** — drop one or more `.docx` files whose headings describe a folder tree.
 *     Every scoped card whose word appears in a document is proposed for the folder/deck it sits
 *     under there, subfolders and all. Deterministic, NO AI.
 *   • **Instructions** — "put the food words in Food/Ingredients". Batched model calls that return a
 *     destination per card; every id is re-validated locally.
 *
 * With BOTH, the documents win for every word they list (a deliberate placement is never
 * second-guessed by a model) and the instruction handles the leftovers, with the document's own
 * folder names offered as destinations.
 *
 * Nothing moves until you approve it, one destination group at a time. A move is a deck relink, so
 * review history and audio ride along untouched.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { buildScopeTree } from '@/lib/scopeTree'
import { ScopeTreePicker } from '@/components/agents/ScopeTreePicker'
import { gatherScopedCards, chunk } from '@/lib/agents/cardEditor'
import type { ScopedCard } from '@/lib/agents/cardEditor'
import {
  planMovesFromDocument, assignBatch, groupByDestination, destinationKey, pathsFromPlan,
  type MoveProposal,
} from '@/lib/agents/cardOrganizer'
import { applyMove, undoMove, type AppliedMove, type OrganizerContext } from '@/lib/agents/organizerApply'
import { readDeckPlanFromFile, type DeckPlan } from '@/lib/docx'
import type { Deck, Folder, Grant } from '@/domain'

const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'
const BATCH_SIZE = 40

type Phase = 'setup' | 'working' | 'review' | 'done'
type Source = 'document' | 'prompt'

const PLACEHOLDER =
  'e.g. "Group these by topic — food, travel, work — with a deck per topic", "Split the verbs out into Verbs/Regular and Verbs/Irregular", "Put anything about family into Family"…'
const DOC_PLACEHOLDER =
  'e.g. "Put anything not in the documents into an Unsorted deck", "Sort the leftovers into whichever of these folders fits best", "Leave the rest alone"…'

export default function OrganizerPage() {
  const [userId, setUserId] = useState<string | null>(null)
  const [decks, setDecks] = useState<Deck[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [source, setSource] = useState<Source>('document')
  const [task, setTask] = useState('')
  const [files, setFiles] = useState<{ name: string; plan: DeckPlan }[]>([])
  const [fileError, setFileError] = useState<string | null>(null)

  const [phase, setPhase] = useState<Phase>('setup')
  const [queue, setQueue] = useState<MoveProposal[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [movedCount, setMovedCount] = useState(0)
  const [skippedCount, setSkippedCount] = useState(0)
  const [notes, setNotes] = useState<string[]>([])
  const [lastApplied, setLastApplied] = useState<AppliedMove[] | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  // Mutated in place by applyMove as folders/decks are created, so a run reuses what it just made.
  const ctxRef = useRef<OrganizerContext | null>(null)

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      setUserId(session.user.id)
      const [ds, fs] = await Promise.all([
        new SupabaseDeckRepository().list(session.user.id),
        new SupabaseFolderRepository().list(session.user.id),
      ])
      setDecks(ds)
      setFolders(fs)
    })()
  }, [])

  const tree = useMemo(() => buildScopeTree(folders, decks), [folders, decks])

  /** Folder names root → deepest, then the deck name — the path shown and compared everywhere. */
  const deckPathOf = useMemo(() => {
    const folderById = new Map(folders.map(f => [f.id, f]))
    const deckById = new Map(decks.map(d => [d.id, d]))
    return (deckId: string): string[] => {
      const deck = deckById.get(deckId)
      if (!deck) return []
      const path: string[] = []
      let fid = deck.folderId
      const guard = new Set<string>()
      while (fid && !guard.has(fid)) {
        guard.add(fid)
        const f = folderById.get(fid)
        if (!f) break
        path.unshift(f.name)
        fid = f.parentId
      }
      return [...path, deck.name]
    }
  }, [folders, decks])

  /** Every existing folder/deck path — handed to the model so it reuses names instead of inventing. */
  const existingPaths = useMemo(() => decks.map(d => deckPathOf(d.id).join(' / ')).sort(), [decks, deckPathOf])

  function toggleDecks(ids: string[]) {
    if (ids.length === 0) return
    setSelected(prev => {
      const n = new Set(prev)
      const allOn = ids.every(id => n.has(id))
      for (const id of ids) allOn ? n.delete(id) : n.add(id)
      return n
    })
  }
  function toggleExpand(id: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selState(ids: string[]): 'none' | 'some' | 'all' {
    if (ids.length === 0) return 'none'
    let on = 0
    for (const id of ids) if (selected.has(id)) on++
    return on === 0 ? 'none' : on === ids.length ? 'all' : 'some'
  }

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return
    setFileError(null)
    const added: { name: string; plan: DeckPlan }[] = []
    for (const file of Array.from(list)) {
      if (!file.name.toLowerCase().endsWith('.docx')) {
        setFileError(`${file.name} isn’t a .docx — only Word documents can be read.`)
        continue
      }
      try {
        added.push({ name: file.name, plan: await readDeckPlanFromFile(file) })
      } catch (e) {
        setFileError(`Couldn’t read ${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (added.length > 0) setFiles(prev => [...prev, ...added])
  }

  /** Builds the shared apply-context from the scope's own language pair. */
  function makeContext(cards: ScopedCard[]): OrganizerContext | null {
    if (!userId) return null
    const first = decks.find(d => d.id === cards[0]?.deckId)
    if (!first) return null
    return {
      userId,
      sourceLanguage: first.sourceLanguage,
      targetLanguage: first.targetLanguage,
      pipelineId: first.pipelineId || DEFAULT_PIPELINE_ID,
      folders: [...folders],
      decks: [...decks],
    }
  }

  async function run() {
    if (!userId || busy || selected.size === 0) return
    setBusy(true); setError(null); setNotes([]); setQueue([]); setPhase('working')
    setMovedCount(0); setSkippedCount(0); setLastApplied(null); setProgress(null)
    try {
      const grant: Grant = {
        operations: ['edit', 'create'], languages: [], folderIds: [],
        deckIds: [...selected], dryRunOnly: false,
      }
      const cards = await gatherScopedCards(userId, grant)
      if (cards.length === 0) { setError('No cards in the selected decks.'); setPhase('setup'); return }
      ctxRef.current = makeContext(cards)

      const instruction = task.trim()
      const msgs: string[] = []
      const all: MoveProposal[] = []

      if (source === 'document') {
        if (files.length === 0) { setError('Add at least one Word document first.'); setPhase('setup'); return }
        // Documents are merged into one plan; earlier files win a conflict, matching the
        // first-occurrence rule inside a single document.
        const merged: DeckPlan = { decks: files.flatMap(f => f.plan.decks), unparsed: files.flatMap(f => f.plan.unparsed) }
        const { moves, unmatched, duplicates } = planMovesFromDocument(cards, merged, deckPathOf)
        all.push(...moves)
        if (duplicates.length > 0) msgs.push(`${duplicates.length} word${duplicates.length === 1 ? '' : 's'} appear under more than one heading; the first placement was used.`)
        if (merged.unparsed.length > 0) msgs.push(`${merged.unparsed.length} document line${merged.unparsed.length === 1 ? '' : 's'} had no separator and were ignored.`)

        if (instruction && unmatched.length > 0) {
          // The instruction governs ONLY what the document didn't place — the document is the
          // explicit statement and must not be re-litigated by a model. The document's own paths
          // join the destination vocabulary so leftovers land inside the structure it defined.
          const vocabulary = [...new Set([...existingPaths, ...pathsFromPlan(merged)])]
          const batches = chunk(unmatched, BATCH_SIZE)
          for (let i = 0; i < batches.length; i++) {
            setProgress({ done: i, total: batches.length })
            all.push(...await assignBatch(batches[i]!, instruction, vocabulary, deckPathOf, true))
          }
          setProgress({ done: batches.length, total: batches.length })
          msgs.push(`${moves.length} placed by the document; the instruction was applied to the ${unmatched.length} card${unmatched.length === 1 ? '' : 's'} it didn’t list.`)
        } else if (unmatched.length > 0) {
          msgs.push(`${unmatched.length} card${unmatched.length === 1 ? '' : 's'} in scope aren’t in the document — left where they are. Add an instruction to say what should happen to them.`)
        }
        setNotes(msgs)
        setQueue(all)
        setPhase(all.length > 0 ? 'review' : 'done')
        return
      }

      if (!instruction) { setError('Say how you want them organized.'); setPhase('setup'); return }
      const batches = chunk(cards, BATCH_SIZE)
      for (let i = 0; i < batches.length; i++) {
        setProgress({ done: i, total: batches.length })
        all.push(...await assignBatch(batches[i]!, instruction, existingPaths, deckPathOf))
      }
      setProgress({ done: batches.length, total: batches.length })
      setQueue(all)
      setPhase(all.length > 0 ? 'review' : 'done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('setup')
    } finally { setBusy(false) }
  }

  const groups = useMemo(() => groupByDestination(queue), [queue])
  const current = groups[0]

  /** Applies every move in the leading destination group. */
  async function approveGroup() {
    const ctx = ctxRef.current
    if (!current || !ctx || busy) return
    setBusy(true); setError(null)
    const applied: AppliedMove[] = []
    try {
      for (const m of current.moves) applied.push(await applyMove(ctx, m))
      setMovedCount(n => n + current.moves.length)
      setLastApplied(applied)
      setFolders([...ctx.folders]); setDecks([...ctx.decks])
      const ids = new Set(current.moves.map(m => m.id))
      setQueue(q => q.filter(m => !ids.has(m.id)))
    } catch (e) {
      // Whatever landed stays landed and is still undoable; the rest of the group stays queued.
      setError(e instanceof Error ? e.message : String(e))
      if (applied.length > 0) {
        setMovedCount(n => n + applied.length)
        setLastApplied(applied)
        const done = new Set(applied.map(a => a.proposal.id))
        setQueue(q => q.filter(m => !done.has(m.id)))
      }
    } finally { setBusy(false) }
  }

  function denyGroup() {
    if (!current) return
    setSkippedCount(n => n + current.moves.length)
    setLastApplied(null)
    const ids = new Set(current.moves.map(m => m.id))
    setQueue(q => q.filter(m => !ids.has(m.id)))
  }

  /** Drops one card out of the leading group without touching the others. */
  function skipOne(id: string) {
    setSkippedCount(n => n + 1)
    setQueue(q => q.filter(m => m.id !== id))
  }

  async function undoLast() {
    const applied = lastApplied
    if (!applied || busy) return
    setBusy(true)
    try {
      for (const a of applied) await undoMove(a)
      setMovedCount(n => Math.max(0, n - applied.length))
      setQueue(q => [...applied.map(a => a.proposal), ...q])
      setLastApplied(null)
      setPhase('review')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  /** Applies the whole queue behind a confirmation. Not undoable as a unit — that's what the confirm is for. */
  async function approveAll() {
    const ctx = ctxRef.current
    if (!ctx || busy) return
    setBusy(true); setConfirmAll(false); setError(null)
    let ok = 0, failed = 0
    try {
      for (const m of [...queue]) {
        try { await applyMove(ctx, m); ok++ } catch { failed++ }
      }
      setMovedCount(n => n + ok)
      setFolders([...ctx.folders]); setDecks([...ctx.decks])
      setQueue([])
      setLastApplied(null)
      if (failed > 0) setError(`${failed} move${failed === 1 ? '' : 's'} failed and were left in place.`)
    } finally { setBusy(false) }
  }

  useEffect(() => {
    if (phase === 'review' && queue.length === 0) setPhase('done')
  }, [phase, queue.length])

  function reset() {
    setPhase('setup'); setQueue([]); setNotes([]); setLastApplied(null)
    setMovedCount(0); setSkippedCount(0); setError(null); setProgress(null)
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap gap-2">
        <a href="/agents"
          className="text-xs px-3 py-1.5 rounded-full border border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40 transition-colors">
          ✏️ Card editor
        </a>
        <span className="text-xs px-3 py-1.5 rounded-full border border-accent bg-accent/15 text-ink">🗂 Card organizer</span>
      </div>

      <div>
        <h1 className="text-2xl font-semibold text-ink">Card organizer agent</h1>
        <p className="text-sm text-ink-muted mt-1">
          Sorts the cards you select into folders and decks — either the exact structure of a Word
          document you give it, or a grouping you describe. Cards keep all their review history; only
          where they live changes.
        </p>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {phase === 'setup' && (
        <div className="panel space-y-5">
          {/* How to say where things go */}
          <div className="space-y-1.5">
            <label className="text-xs text-ink-faint">How should it decide?</label>
            <div className="flex flex-wrap gap-2">
              {([
                ['document', '📄 From Word documents', 'Match the folders and decks the document’s headings describe — add instructions for anything it doesn’t list'],
                ['prompt',   '💬 From instructions only',  'Tell it how to group them'],
              ] as [Source, string, string][]).map(([val, label, hint]) => (
                <button key={val} type="button" onClick={() => setSource(val)} title={hint}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    source === val ? 'border-accent bg-accent/15 text-ink' : 'border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {source === 'document' ? (
            <div className="space-y-2">
              <label className="text-xs text-ink-faint">
                Word documents <span className="text-ink-faint/70">(headings become folders; the deepest heading over a word list becomes its deck)</span>
              </label>
              <input type="file" accept=".docx" multiple onChange={e => void addFiles(e.target.files)}
                className="block w-full text-sm text-ink-muted file:mr-3 file:py-1.5 file:px-3 file:rounded-full file:border file:border-line/10 file:bg-surface file:text-ink file:text-xs hover:file:bg-surface-raised" />
              {fileError && <p className="text-xs text-danger">{fileError}</p>}
              {files.length > 0 && (
                <div className="space-y-1.5">
                  {files.map((f, i) => {
                    const words = f.plan.decks.reduce((n, d) => n + d.cards.length, 0)
                    return (
                      <div key={`${f.name}:${i}`} className="flex items-center justify-between gap-3 rounded-lg border border-line/10 px-3 py-2">
                        <span className="text-sm text-ink truncate">📄 {f.name}</span>
                        <span className="text-xs text-ink-faint shrink-0">
                          {`${f.plan.decks.length} deck${f.plan.decks.length === 1 ? '' : 's'} · ${words} word${words === 1 ? '' : 's'}`}
                        </span>
                        <button type="button" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                          className="text-xs text-ink-faint hover:text-danger shrink-0">Remove</button>
                      </div>
                    )
                  })}
                  <details className="text-xs text-ink-faint">
                    <summary className="cursor-pointer hover:text-ink">Structure it found</summary>
                    <ul className="mt-1.5 space-y-0.5 pl-3 max-h-40 overflow-y-auto">
                      {files.flatMap(f => f.plan.decks).map((d, i) => (
                        <li key={i} className="truncate">{[...d.path, d.name].join(' / ')} <span className="text-ink-faint/70">· {d.cards.length}</span></li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
            </div>
          ) : null}

          <div className="space-y-1">
            <label className="text-xs text-ink-faint">
              {source === 'document'
                ? <>Instructions <span className="text-ink-faint/70">(optional — applied to cards the documents don’t list)</span></>
                : 'How should the cards be grouped?'}
            </label>
            <textarea className="input min-h-[90px]" value={task} onChange={e => setTask(e.target.value)}
              placeholder={source === 'document' ? DOC_PLACEHOLDER : PLACEHOLDER} />
            {source === 'document' && (
              <p className="text-[10px] text-ink-faint">
                The documents decide every word they list — an instruction can’t override a placement you
                wrote down. It handles the leftovers, and can put them into the same folders.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <label className="text-xs text-ink-faint">Scope — the cards it may move</label>
              <span className="text-xs text-ink-faint">{selected.size} deck{selected.size === 1 ? '' : 's'} in scope</span>
            </div>
            <ScopeTreePicker tree={tree} selState={selState} expanded={expanded}
              onToggleSel={toggleDecks} onToggleExpand={toggleExpand} />
          </div>

          <button type="button" onClick={() => void run()}
            disabled={!userId || busy || selected.size === 0 || (source === 'document' ? files.length === 0 : !task.trim())}
            className="btn-primary text-sm py-2 px-4 disabled:opacity-40">
            {busy
              ? 'Working…'
              : source === 'document'
                ? (task.trim() ? 'Match the documents, then apply the instructions' : 'Match against the documents')
                : 'Plan the reorganization'}
          </button>
        </div>
      )}

      {phase === 'working' && (
        <div className="panel space-y-2">
          <p className="text-sm text-ink">Reading your cards…</p>
          {progress && (
            <p className="text-xs text-ink-faint">{`Batch ${progress.done} of ${progress.total}`}</p>
          )}
        </div>
      )}

      {phase === 'review' && current && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-ink-muted">
              {`${queue.length} card${queue.length === 1 ? '' : 's'} left · ${movedCount} moved · ${skippedCount} skipped`}
            </p>
            <div className="flex items-center gap-2">
              {lastApplied && (
                <button type="button" onClick={() => void undoLast()} disabled={busy}
                  className="text-xs px-3 py-1.5 rounded-full border border-line/10 text-ink-muted hover:text-ink disabled:opacity-40">
                  ↶ Undo last
                </button>
              )}
              {confirmAll ? (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-ink-muted">{`Move all ${queue.length}?`}</span>
                  <button type="button" onClick={() => void approveAll()} disabled={busy}
                    className="btn-primary text-xs py-1 px-3">Yes, move them</button>
                  <button type="button" onClick={() => setConfirmAll(false)} className="text-ink-faint hover:text-ink">Cancel</button>
                </span>
              ) : (
                <button type="button" onClick={() => setConfirmAll(true)} disabled={busy}
                  className="text-xs px-3 py-1.5 rounded-full border border-line/10 text-ink-muted hover:text-ink disabled:opacity-40">
                  {`Accept all ${queue.length} remaining`}
                </button>
              )}
            </div>
          </div>

          <div className="panel space-y-3">
            <div>
              <p className="text-xs text-ink-faint">Move into</p>
              <p className="text-lg text-ink">📁 {destinationKey(current.to)}</p>
              <p className="text-xs text-ink-faint mt-0.5">{current.moves[0]!.reason}</p>
            </div>

            <div className="rounded-lg border border-line/10 divide-y divide-line/5 max-h-72 overflow-y-auto">
              {current.moves.map(m => (
                <div key={m.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink truncate">{m.front}</div>
                    <div className="text-xs text-ink-faint truncate">{m.back}</div>
                  </div>
                  <div className="text-xs text-ink-faint shrink-0 hidden sm:block truncate max-w-[12rem]">
                    from {m.fromDeckName}
                  </div>
                  <button type="button" onClick={() => skipOne(m.id)}
                    className="text-xs text-ink-faint hover:text-ink shrink-0">Leave</button>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void approveGroup()} disabled={busy}
                className="btn-primary text-sm py-1.5 px-4 disabled:opacity-40">
                {busy ? 'Moving…' : `Move ${current.moves.length} card${current.moves.length === 1 ? '' : 's'}`}
              </button>
              <button type="button" onClick={denyGroup} disabled={busy}
                className="text-sm px-3 py-1.5 rounded-lg border border-line/10 text-ink-muted hover:text-ink disabled:opacity-40">
                Skip this group
              </button>
            </div>
          </div>

          {groups.length > 1 && (
            <p className="text-xs text-ink-faint">
              {`Then: ${groups.slice(1, 4).map(g => `${g.key} (${g.moves.length})`).join(', ')}${groups.length > 4 ? `, +${groups.length - 4} more` : ''}`}
            </p>
          )}
        </div>
      )}

      {phase === 'done' && (
        <div className="panel space-y-3">
          <p className="text-sm text-ink">
            {movedCount > 0
              ? `Done — ${movedCount} card${movedCount === 1 ? '' : 's'} moved${skippedCount > 0 ? `, ${skippedCount} left alone` : ''}.`
              : 'Nothing to move — every card in scope is already where it should be.'}
          </p>
          {notes.length > 0 && (
            <ul className="text-xs text-ink-faint space-y-0.5">
              {notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={reset} className="btn-primary text-sm py-1.5 px-4">Organize more</button>
            <a href="/library" className="text-sm px-3 py-1.5 rounded-lg border border-line/10 text-ink-muted hover:text-ink">See the library</a>
          </div>
        </div>
      )}

      {phase !== 'setup' && notes.length > 0 && phase !== 'done' && (
        <ul className="text-xs text-ink-faint space-y-0.5">
          {notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  )
}
