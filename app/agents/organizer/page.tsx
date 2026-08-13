'use client'

/**
 * app/agents/organizer/page.tsx — the card-organizer agent.
 *
 * It works the way a person reorganizing a library would:
 *   1. **Read the whole library** — a hierarchical export of the selected scope.
 *   2. **Read the brief** — the instruction (GROUND TRUTH) plus any Word documents (supporting
 *      evidence; the instruction says how literally to take them).
 *   3. **Write a migration plan** — an ordered list of moves that ends with the library exactly as
 *      described. Whole decks and folders move as units where possible, not card by card.
 *   4. **Show the plan**, then run it end to end on one approval — reversibly.
 *
 * Duplicates, words the documents mention that aren't in scope, and cards sitting outside the scope
 * are computed BEFORE the model is called and handed to it as facts (see `planMigration`). The model
 * plans; it doesn't audit. Every id it returns is re-validated against the real library.
 *
 * A move is a deck relink, so review history, audio and other decks a card is shared into survive.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { buildScopeTree } from '@/lib/scopeTree'
import { ScopeTreePicker } from '@/components/agents/ScopeTreePicker'
import { planMigration, type PlanResult } from '@/lib/agents/planMigration'
import { groupPlan, countCardMoves, type Diagnostic, type DiagnosticPolicy, type MigrationStep } from '@/lib/agents/migrationPlan'
import { runMigration, undoMigration, type AppliedStep, type MigrationContext } from '@/lib/agents/migrationApply'
import { readDeckPlanFromFile, type DeckPlan } from '@/lib/docx'
import type { Deck, Folder } from '@/domain'

const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'

type Phase = 'setup' | 'planning' | 'review' | 'running' | 'done'

const PLACEHOLDER =
  'e.g. "Follow the documents exactly — every heading is a folder and every deck under it should hold exactly those words", "Use the documents as a guide but keep my existing Verbs folder", "Group everything by topic; the documents show which topics I mean"…'

export default function OrganizerPage() {
  const [userId, setUserId] = useState<string | null>(null)
  const [decks, setDecks] = useState<Deck[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const [task, setTask] = useState('')
  const [files, setFiles] = useState<{ name: string; plan: DeckPlan }[]>([])
  const [fileError, setFileError] = useState<string | null>(null)

  // What to do about the things the deterministic pass finds.
  const [policy, setPolicy] = useState<DiagnosticPolicy>({
    ignoreDuplicates: false, ignoreMissing: false, allowPullIn: true,
  })

  const [phase, setPhase] = useState<Phase>('setup')
  const [planningMsg, setPlanningMsg] = useState('Reading your library and writing a plan…')
  const [result, setResult] = useState<PlanResult | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [applied, setApplied] = useState<AppliedStep[] | null>(null)
  const [failed, setFailed] = useState<{ step: MigrationStep; error: string }[]>([])
  const [undone, setUndone] = useState(false)

  // Mutated in place by the executor as folders/decks are created, so a run reuses what it just made.
  const ctxRef = useRef<MigrationContext | null>(null)

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

  /** A document as its sections — the planner builds its own text and outlines from these. */
  function documentsForPlanner() {
    return files.map(f => ({
      name: f.name,
      sections: f.plan.decks.map(d => ({
        path: d.path, name: d.name,
        cards: d.cards.map(c => ({ front: c.front, back: c.back })),
      })),
    }))
  }

  async function makePlan() {
    if (!userId || busy || selected.size === 0) return
    const first = decks.find(d => selected.has(d.id))
    if (!first) { setError('No cards in the selected decks.'); return }
    if (!task.trim() && files.length === 0) { setError('Give an instruction, a document, or both.'); return }

    setBusy(true); setError(null); setPhase('planning')
    setPlanningMsg('Reading your library and writing a plan…')
    setResult(null); setApplied(null); setFailed([]); setUndone(false)
    try {
      const res = await planMigration({
        userId,
        scopeDeckIds: [...selected],
        instruction: task,
        documents: documentsForPlanner(),
        folders, decks,
        sourceLanguage: first.sourceLanguage,
        targetLanguage: first.targetLanguage,
        policy,
        onProgress: setPlanningMsg,
      })
      setResult(res)
      ctxRef.current = {
        userId,
        sourceLanguage: first.sourceLanguage,
        targetLanguage: first.targetLanguage,
        pipelineId: first.pipelineId || DEFAULT_PIPELINE_ID,
        folders: [...folders],
        decks: [...decks],
      }
      setPhase('review')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('setup')
    } finally { setBusy(false) }
  }

  async function applyPlan() {
    const ctx = ctxRef.current
    if (!ctx || !result || busy) return
    setBusy(true); setError(null); setPhase('running'); setProgress({ done: 0, total: result.steps.length })
    try {
      const run = await runMigration(ctx, result.steps, (done, total) => setProgress({ done, total }))
      setApplied(run.applied)
      setFailed(run.failed)
      setFolders([...ctx.folders])
      setDecks([...ctx.decks])
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('review')
    } finally { setBusy(false); setProgress(null) }
  }

  async function undoAll() {
    if (!applied || busy) return
    setBusy(true); setError(null); setProgress({ done: 0, total: applied.length })
    try {
      await undoMigration(applied, (done, total) => setProgress({ done, total }))
      setUndone(true)
      setApplied(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false); setProgress(null) }
  }

  function reset() {
    setPhase('setup'); setResult(null); setApplied(null); setFailed([]); setUndone(false)
    setError(null); setShowLibrary(false)
  }

  const cardMoves = result ? countCardMoves(result.steps) : 0
  const groups = result ? groupPlan(result.steps) : []

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Card organizer agent</h1>
        <p className="text-sm text-ink-muted mt-1">
          Pick what it may touch, say how you want it organized, and add Word documents if you have
          them. It reads your library, writes a migration plan, and runs the whole plan once you
          approve it. Nothing moves before that, and everything is undoable afterwards.
        </p>
      </div>

      {error && <div className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>}

      {phase === 'setup' && (
        <div className="panel space-y-5">
          <div className="space-y-1.5">
            <label className="text-xs text-ink-faint">Scope — the decks it may reorganize</label>
            <ScopeTreePicker
              tree={tree} expanded={expanded}
              onToggleSel={toggleDecks} onToggleExpand={toggleExpand} selState={selState}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-ink-faint">
              How should it be organized? <span className="text-ink-faint/70">(this is the ground truth — it decides how the documents are read)</span>
            </label>
            <textarea className="input min-h-[110px]" value={task} onChange={e => setTask(e.target.value)} placeholder={PLACEHOLDER} />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-ink-faint">Word documents <span className="text-ink-faint/70">(optional — structure to follow)</span></label>
            <input type="file" accept=".docx" multiple onChange={e => void addFiles(e.target.files)}
              className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-lg file:border-0 file:bg-surface-raised file:px-3 file:py-1.5 file:text-sm file:text-ink hover:file:bg-surface" />
            {fileError && <p className="text-xs text-danger">{fileError}</p>}
            {files.length > 0 && (
              <div className="space-y-1 pt-1">
                {files.map((f, i) => (
                  <div key={f.name + i} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-ink truncate">
                      {f.name} <span className="text-ink-faint">· {f.plan.decks.length} deck{f.plan.decks.length === 1 ? '' : 's'}</span>
                    </span>
                    <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                      className="text-ink-faint hover:text-danger shrink-0">Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2 border-t border-line/10 pt-4">
            <p className="text-xs uppercase tracking-wider text-ink-faint">When something doesn’t line up</p>
            {([
              ['ignoreDuplicates', 'Ignore duplicate words', 'Otherwise the plan is told to keep copies of the same word together.'],
              ['ignoreMissing', 'Ignore words that aren’t in my library', 'Otherwise they’re listed so you can see what the documents expected.'],
              ['allowPullIn', 'May pull in cards from outside the scope', 'When a document lists a word that lives in a deck you didn’t select, it can move it in.'],
            ] as const).map(([key, label, hint]) => (
              <label key={key} className="flex items-start gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={policy[key]}
                  onChange={e => setPolicy(p => ({ ...p, [key]: e.target.checked }))}
                  className="accent-accent w-4 h-4 mt-0.5" />
                <span className="text-sm text-ink">
                  {label}
                  <span className="block text-xs text-ink-faint">{hint}</span>
                </span>
              </label>
            ))}
          </div>

          <button onClick={() => void makePlan()}
            disabled={!userId || busy || selected.size === 0 || (!task.trim() && files.length === 0)}
            className="btn-primary text-sm py-2 px-4 disabled:opacity-40">
            Plan the reorganization
          </button>
        </div>
      )}

      {phase === 'planning' && (
        <div className="panel text-center py-10 space-y-2">
          <p className="text-sm text-ink">{planningMsg}</p>
          <p className="text-xs text-ink-faint">Large libraries are planned in stages — this can take a few minutes.</p>
        </div>
      )}

      {phase === 'review' && result && (
        <div className="space-y-4">
          <div className="panel space-y-3">
            <h2 className="text-sm font-medium text-ink">The plan</h2>
            {result.plan.summary && <p className="text-sm text-ink-muted">{result.plan.summary}</p>}
            <p className="text-xs text-ink-faint">
              {`${result.steps.length} step${result.steps.length === 1 ? '' : 's'} · ${cardMoves} card${cardMoves === 1 ? '' : 's'} moved`}
            </p>
            {result.truncated && (
              <p className="text-xs text-warning">
                The planner hit its length limit, so this plan may be incomplete. Consider narrowing the scope.
              </p>
            )}
          </div>

          {result.diagnostics.length > 0 && <DiagnosticList diagnostics={result.diagnostics} />}

          {result.steps.length === 0 ? (
            <div className="panel text-sm text-ink-muted">
              Nothing to do — the library already matches what you described.
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map(g => (
                <div key={g.label} className="panel space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-ink">{g.label}</h3>
                    <span className="text-xs text-ink-faint shrink-0">{g.steps.length}</span>
                  </div>
                  <div className="divide-y divide-line/5">
                    {g.steps.map((s, i) => <StepRow key={i} step={s} />)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {result.dropped.length > 0 && (
            <details className="panel">
              <summary className="text-sm text-ink-muted cursor-pointer">
                {`${result.dropped.length} proposed step${result.dropped.length === 1 ? '' : 's'} discarded`}
              </summary>
              <div className="pt-2 space-y-1 text-xs text-ink-faint">
                {result.dropped.map((d, i) => <div key={i}>{describeStep(d.step)} — {d.why}</div>)}
              </div>
            </details>
          )}

          <details className="panel">
            <summary className="text-sm text-ink-muted cursor-pointer" onClick={() => setShowLibrary(v => !v)}>
              What the planner read
            </summary>
            {showLibrary && (
              <pre className="pt-2 text-[11px] text-ink-faint whitespace-pre-wrap max-h-80 overflow-y-auto">{result.libraryText}</pre>
            )}
          </details>

          <div className="flex flex-wrap gap-3">
            <button onClick={() => void applyPlan()} disabled={busy || result.steps.length === 0}
              className="btn-primary text-sm py-2 px-4 disabled:opacity-40">
              {`Apply plan (${result.steps.length} step${result.steps.length === 1 ? '' : 's'})`}
            </button>
            <button onClick={reset} className="btn-ghost text-sm py-2 px-4">Start over</button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="panel text-center py-10 space-y-2">
          <p className="text-sm text-ink">Reorganizing…</p>
          {progress && <p className="text-xs text-ink-faint">{progress.done} / {progress.total}</p>}
        </div>
      )}

      {phase === 'done' && (
        <div className="panel space-y-3">
          <h2 className="text-sm font-medium text-ink">{undone ? 'Migration undone' : 'Done'}</h2>
          <p className="text-sm text-ink-muted">
            {undone
              ? 'Everything is back where it was.'
              : `Applied ${applied?.length ?? 0} step${(applied?.length ?? 0) === 1 ? '' : 's'}.`}
          </p>
          {failed.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-danger">{failed.length} step{failed.length === 1 ? '' : 's'} failed:</p>
              {failed.map((f, i) => (
                <p key={i} className="text-xs text-ink-faint">{describeStep(f.step)} — {f.error}</p>
              ))}
            </div>
          )}
          {progress && <p className="text-xs text-ink-faint">{progress.done} / {progress.total}</p>}
          <div className="flex flex-wrap gap-3">
            {!undone && applied && applied.length > 0 && (
              <button onClick={() => void undoAll()} disabled={busy} className="btn-ghost text-sm py-2 px-4">
                Undo migration
              </button>
            )}
            <button onClick={reset} className="btn-primary text-sm py-2 px-4">Organize something else</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Presentation ────────────────────────────────────────────────────────────

function describeStep(s: MigrationStep): string {
  if (s.kind === 'createFolder') return `Create folder ${s.path.join(' / ')}`
  if (s.kind === 'moveFolder')   return `Move folder ${s.folderName} → ${s.toParent.join(' / ') || 'library root'}`
  if (s.kind === 'moveDeck')     return `Move deck ${s.deckName} → ${s.toFolder.join(' / ') || 'library root'}`
  return `${s.front} — from ${s.fromDeckName}`
}

function StepRow({ step }: { step: MigrationStep }) {
  return (
    <div className="py-2 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-ink truncate">
          {describeStep(step)}
          {step.kind === 'moveCard' && step.pullIn && (
            <span className="ml-2 text-[10px] uppercase tracking-wider text-warning">pulled in</span>
          )}
        </p>
        {step.kind === 'moveCard' && <p className="text-xs text-ink-faint truncate">{step.back}</p>}
        {step.reason && <p className="text-xs text-ink-faint">{step.reason}</p>}
      </div>
    </div>
  )
}

const DIAG_LABEL: Record<Diagnostic['kind'], string> = {
  duplicate:  'Duplicate words',
  missing:    'Not in your library',
  outOfScope: 'Outside the selected scope',
}

function DiagnosticList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const kinds: Diagnostic['kind'][] = ['duplicate', 'outOfScope', 'missing']
  return (
    <div className="panel space-y-3">
      <h2 className="text-sm font-medium text-ink">Worth knowing</h2>
      {kinds.map(kind => {
        const items = diagnostics.filter(d => d.kind === kind)
        if (items.length === 0) return null
        return (
          <div key={kind} className="space-y-1">
            <p className="text-xs uppercase tracking-wider text-ink-faint">{DIAG_LABEL[kind]} · {items.length}</p>
            {items.slice(0, 12).map((d, i) => (
              <p key={i} className="text-xs text-ink-muted">
                <span className="text-ink">{d.word}</span> — {d.detail}
              </p>
            ))}
            {items.length > 12 && <p className="text-xs text-ink-faint">…and {items.length - 12} more</p>}
          </div>
        )
      })}
    </div>
  )
}
