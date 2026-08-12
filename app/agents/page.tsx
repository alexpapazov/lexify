'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { labelCards } from '@/lib/labelCards'
import { buildScopeTree } from '@/lib/scopeTree'
import { ScopeTreePicker } from '@/components/agents/ScopeTreePicker'
import { gatherScopedCards, analyzeBatch, applyProposal, undoApplied, chunk, findDuplicates } from '@/lib/agents/cardEditor'
import type { ScopedCard, EditProposal, AgentSides, DedupeMode, AppliedUndo } from '@/lib/agents/cardEditor'
import type { Deck, Folder, CardState, Grant } from '@/domain'
import { langFlag } from '@/lib/languages'

const BATCH_SIZE = 20
type Phase = 'setup' | 'gathering' | 'analyzing' | 'review' | 'done'

// ── Scope tree (a mini library: pairs → folders → subfolders → decks) ──────────
type CardStatus = 'unlearned' | 'learning' | 'graduated' | 'due' | 'dormant'
const STATUS_META: { key: CardStatus; label: string; color: string }[] = [
  { key: 'unlearned', label: 'Unlearned', color: 'var(--c-ink-muted, #9aa)' },
  { key: 'learning',  label: 'Learning',  color: '#F0883E' },
  { key: 'graduated', label: 'Graduated', color: '#4ADE80' },
  { key: 'due',       label: 'Due now',   color: '#6640FF' },
  { key: 'dormant',   label: 'Dormant',   color: '#9aa' },
]

// The tree builder itself lives in lib/scopeTree.ts — practice mode picks library scope the same
// way, and two copies of "mirror the library" would drift.

const PLACEHOLDER = 'e.g. "Split any card whose gloss has two distinct meanings", "Remove the leading \'to \' from every verb gloss", "Add the gender in parentheses to noun glosses", "Delete duplicate cards"…'

export default function AgentsPage() {
  const [userId, setUserId] = useState<string | null>(null)
  const [decks, setDecks] = useState<Deck[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())   // deck IDs in scope
  const [statuses, setStatuses] = useState<Set<CardStatus>>(new Set())  // empty = all statuses
  const [expanded, setExpanded] = useState<Set<string>>(new Set())   // expanded pair/folder ids
  const [task, setTask] = useState('')
  const [phase, setPhase] = useState<Phase>('setup')
  const [queue, setQueue] = useState<EditProposal[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanned, setScanned] = useState(0)
  const [total, setTotal] = useState(0)
  const [approved, setApproved] = useState(0)
  const [denied, setDenied] = useState(0)
  /** The last approval, with everything needed to reverse it (including deleted cards' review
   *  history). Cleared once undone, or when a new approval supersedes it. */
  const [lastApplied, setLastApplied] = useState<AppliedUndo | null>(null)
  /** Which side of each card the agent may SEE — and therefore edit. The review UI always shows both. */
  const [sides, setSides] = useState<AgentSides>('both')
  /** Which copy of a duplicate group survives. Keyed by proposal id so queue shuffling can't misapply it. */
  const [keepChoice, setKeepChoice] = useState<Record<string, string>>({})
  const [confirmAcceptAll, setConfirmAcceptAll] = useState(false)
  /** Vocabulary labeling runs outside the review queue — see `runLabeling`. */
  const [labelBusy, setLabelBusy] = useState(false)
  const [labelProgress, setLabelProgress] = useState<{ done: number; total: number } | null>(null)
  const [labelMsg, setLabelMsg] = useState<string | null>(null)

  const batchesRef = useRef<ScopedCard[][]>([])
  const nextBatchRef = useRef(0)
  const taskRef = useRef('')
  // Read inside the background prefetch loop, which outlives the render that started the run — a
  // stale closure over `sides` would silently analyze later batches with the wrong visibility.
  const sidesRef = useRef<AgentSides>('both')
  const bufferRef = useRef<EditProposal[]>([])   // next non-empty batch, prefetched in the background
  const prefetchingRef = useRef(false)

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
      // Start fully collapsed — just the language pairs — so the scope tree is easy to scan and expand
      // only what you need.
    })()
  }, [])

  const tree = useMemo(() => buildScopeTree(folders, decks), [folders, decks])

  function scopedDeckIds(): string[] { return [...selected] }
  const inScopeDeckCount = selected.size

  // Toggle a set of deck IDs on/off together (a deck, or every deck under a folder/pair).
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
  /** none | some | all of `ids` are selected (drives checkbox checked/indeterminate). */
  function selState(ids: string[]): 'none' | 'some' | 'all' {
    if (ids.length === 0) return 'none'
    let on = 0
    for (const id of ids) if (selected.has(id)) on++
    return on === 0 ? 'none' : on === ids.length ? 'all' : 'some'
  }

  function toggleStatus(s: CardStatus) {
    setStatuses(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })
  }

  // Narrow scoped cards to the selected statuses (empty = all). Status is read from each card's
  // forward card_state: none → unlearned, dormant, !graduated → learning, else graduated (due if its
  // production due date has passed). 'graduated' includes due cards; 'due' is the due-only subset.
  async function filterByStatus(cards: ScopedCard[]): Promise<ScopedCard[]> {
    if (statuses.size === 0 || statuses.size === STATUS_META.length || !userId) return cards
    const stateRepo = new SupabaseCardStateRepository()
    const deckIds = [...new Set(cards.map(c => c.deckId))]
    const fwd = new Map<string, CardState>()
    await Promise.all(deckIds.map(async id => {
      for (const s of await stateRepo.listByDeck(userId, id)) if (s.reviewDirection !== 'reverse') fwd.set(s.cardId, s)
    }))
    const now = Date.now()
    const prodDue = (s: CardState) => { const iso = s.smartDueAt ?? s.typedDueAt ?? s.dueAt; return iso != null && new Date(iso).getTime() <= now }
    const matches = (s: CardState | undefined): boolean => {
      if (!s) return statuses.has('unlearned')
      if (s.dormant) return statuses.has('dormant')
      if (!s.graduated) return statuses.has('learning')
      if (statuses.has('graduated')) return true
      return statuses.has('due') && prodDue(s)
    }
    return cards.filter(c => matches(fwd.get(c.cardId)))
  }

  // Analyzes one batch (advancing the cursor). Returns its proposals, or null when out of batches.
  async function analyzeOne(): Promise<EditProposal[] | null> {
    if (nextBatchRef.current >= batchesRef.current.length) return null
    const batch = batchesRef.current[nextBatchRef.current++]!
    setScanned(s => s + batch.length)
    try { return await analyzeBatch(batch, taskRef.current, sidesRef.current) }
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
    sidesRef.current = sides
    setPhase('gathering'); setError(null); setScanned(0); setApproved(0); setDenied(0)
    bufferRef.current = []
    try {
      const grant: Grant = { operations: ['edit', 'create', 'delete'], languages: [], folderIds: [], deckIds: scopedDeckIds(), dryRunOnly: false }
      const cards = await filterByStatus(await gatherScopedCards(userId, grant))
      setTotal(cards.length)
      batchesRef.current = chunk(cards, BATCH_SIZE)
      nextBatchRef.current = 0
      await loadNext()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setPhase('setup')
    }
  }

  /**
   * Deterministic de-dupe — no AI. Finds duplicate groups in the SELECTED scope and queues one
   * proposal per group for the normal approve/deny UI.
   *
   * Scope is required, not defaulted to the whole library: this proposes deletions, and "everything"
   * is not a safe implicit answer to "where should I delete from".
   *
   * The default keeper is the copy with the most review progress, so approving can't silently throw
   * away months of study in favour of an untouched import.
   */
  async function runDedupe(mode: DedupeMode) {
    if (!userId || busy) return
    const deckIds = scopedDeckIds()
    if (deckIds.length === 0) { setError('Pick a language, folder or deck first — de-dupe only ever deletes inside the scope you choose.'); return }
    taskRef.current = 'De-dupe'
    setPhase('gathering'); setError(null); setScanned(0); setApproved(0); setDenied(0)
    bufferRef.current = []; batchesRef.current = []; nextBatchRef.current = 0
    setKeepChoice({})
    try {
      const grant: Grant = { operations: ['edit', 'create', 'delete'], languages: [], folderIds: [], deckIds, dryRunOnly: false }
      const cards = await filterByStatus(await gatherScopedCards(userId, grant))
      setTotal(cards.length); setScanned(cards.length)
      const rank = await buildProgressRank(cards)
      const dups = findDuplicates(cards, { mode, rank })
      if (dups.length === 0) setPhase('done')
      else { setQueue(dups); setPhase('review') }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setPhase('setup')
    }
  }

  /**
   * Vocabulary labeling over the selected scope — part of speech + dictionary lemma for every
   * unlabeled card (see `features/Practice Mode.md`).
   *
   * Deliberately NOT a change-set flow. The review queue exists because an edit to a card's front or
   * back destroys content you wrote, so a human should see each one. A label is derived metadata:
   * getting one wrong costs a slightly odd practice sentence and is fixed by re-running. Queueing
   * thousands of label proposals would only train the habit of hitting "accept all" unread, which is
   * worse than no review at all. So this runs like de-dupe's scan: scoped, immediate, reportable.
   *
   * Idempotent — only cards with no label are sent, so re-running is always safe and never re-pays
   * for work already done. Labels persist batch by batch, so navigating away keeps what landed.
   */
  async function runLabeling() {
    if (!userId || labelBusy) return
    const deckIds = scopedDeckIds()
    if (deckIds.length === 0) { setError('Pick a language, folder or deck first.'); return }
    setLabelBusy(true); setError(null); setLabelMsg(null); setLabelProgress(null)
    try {
      const grant: Grant = { operations: ['edit'], languages: [], folderIds: [], deckIds, dryRunOnly: false }
      const scoped = await gatherScopedCards(userId, grant)
      const inScope = new Set(scoped.map(c => c.cardId))

      // ScopedCard carries neither `pos` nor the target language, so cross-reference the real cards
      // to find what still needs labeling.
      const all = await new SupabaseCardRepository().listAllForUser(userId)
      const unlabeled = all
        .filter(c => inScope.has(c.id) && !c.pos)
        .map(c => ({
          id: c.id, front: c.front, back: c.back,
          sourceLanguage: c.sourceLanguage, targetLanguage: c.targetLanguage,
        }))

      if (unlabeled.length === 0) {
        setLabelMsg('Every card in this scope is already labeled.')
        return
      }
      setLabelProgress({ done: 0, total: unlabeled.length })
      const result = await labelCards(unlabeled, (done, total) => setLabelProgress({ done, total }))
      setLabelMsg(result.failedCount === 0
        ? `Labeled ${result.labeledCount} card${result.labeledCount !== 1 ? 's' : ''}.`
        : `Labeled ${result.labeledCount}; ${result.failedCount} couldn’t be labeled — run again to retry.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLabelBusy(false); setLabelProgress(null)
    }
  }

  /**
   * cardId → "how much progress this copy has", for picking which duplicate survives.
   * Graduated beats learning beats never-studied; within a tier, more reps wins. A card with no
   * state scores 0, so an untouched import always loses to a studied copy.
   */
  async function buildProgressRank(cards: ScopedCard[]): Promise<(cardId: string) => number> {
    if (!userId) return () => 0
    const stateRepo = new SupabaseCardStateRepository()
    const deckIds = [...new Set(cards.map(c => c.deckId))]
    const score = new Map<string, number>()
    await Promise.all(deckIds.map(async id => {
      for (const s of await stateRepo.listByDeck(userId, id)) {
        if (s.reviewDirection === 'reverse') continue
        const tier = s.graduated ? 2_000_000 : 1_000_000
        const value = tier + s.reps * 1000 + s.lapses
        score.set(s.cardId, Math.max(score.get(s.cardId) ?? 0, value))
      }
    })).catch(() => {})
    return (cardId: string) => score.get(cardId) ?? 0
  }

  function advance() {
    // Any pending "apply all" confirmation is about the queue as it was; dismiss it on every move.
    setConfirmAcceptAll(false)
    const next = queue.slice(1)
    if (next.length > 0) { setQueue(next); prefetch() }   // keep buffering the next batch while reviewing
    else loadNext()
  }
  async function approve() {
    const current = queue[0]
    if (!current || !userId || busy) return
    setBusy(true)
    // For a group, the chosen keeper overrides the default; everything else in the group is deleted.
    const chosen = current.id ? keepChoice[current.id] : undefined
    const toApply = current.action === 'dedupe' && chosen ? { ...current, keepCardId: chosen } : current
    const cardsAffected = current.action === 'dedupe' ? Math.max(0, (current.group?.length ?? 1) - 1) : 1
    try {
      const undo = await applyProposal(userId, toApply)
      setApproved(a => a + cardsAffected)
      // Deletes are undoable now too — `applyProposal` snapshots the review history before removing
      // a card, so an undo restores the card AND its schedule.
      setLastApplied(undo)
    } catch (e) {
      // Keep the proposal on screen — advancing here would bury a half-applied group.
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
      return
    }
    setBusy(false)
    advance()
  }

  /** Whether batches remain that haven't been analyzed yet — so the "N left" count isn't the total. */
  const moreToScan = nextBatchRef.current < batchesRef.current.length || bufferRef.current.length > 0

  /**
   * Applies every proposal currently queued, in order, without stopping to ask.
   *
   * Each one still goes through `applyProposal`, so the liveness guard runs per group and a card that
   * has since been deleted is skipped rather than double-deleted. Failures are counted and reported
   * instead of aborting — one bad group shouldn't strand the other forty.
   *
   * Deliberately NOT undoable as a unit: `lastApplied` holds one proposal, and pretending a bulk
   * apply can be reversed with one press would be a lie. That's why it's behind a confirmation.
   */
  async function acceptAll() {
    if (!userId || busy || queue.length === 0) return
    setConfirmAcceptAll(false)
    setBusy(true)
    setError(null)
    let applied = 0
    let failed = 0
    for (const p of queue) {
      const chosen = p.id ? keepChoice[p.id] : undefined
      const toApply = p.action === 'dedupe' && chosen ? { ...p, keepCardId: chosen } : p
      try {
        await applyProposal(userId, toApply)
        applied += p.action === 'dedupe' ? Math.max(0, (p.group?.length ?? 1) - 1) : 1
      } catch { failed++ }
    }
    setApproved(a => a + applied)
    setLastApplied(null)   // a bulk apply has no single-press undo
    if (failed > 0) setError(`${failed} change${failed === 1 ? '' : 's'} could not be applied and ${failed === 1 ? 'was' : 'were'} skipped.`)
    setQueue([])
    setBusy(false)
    await loadNext()
  }

  /** Reverses the last approval and puts the proposal back at the head of the queue to decide again. */
  async function undoLast() {
    const undo = lastApplied
    if (!undo || !userId || busy) return
    setBusy(true)
    try {
      await undoApplied(userId, undo)
      const p = undo.proposal
      const cards = p.action === 'dedupe' ? Math.max(0, (p.group?.length ?? 1) - 1) : 1
      setApproved(a => Math.max(0, a - cards))
      setLastApplied(null)
      setQueue(q => [p, ...q])
      setPhase('review')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }
  function deny() {
    // Count CARDS, not proposals, so the tally matches `approved` (a denied group skips every copy).
    const skipped = queue[0]?.action === 'dedupe' ? Math.max(0, (queue[0]!.group?.length ?? 1) - 1) : 1
    setDenied(d => d + skipped)
    setLastApplied(null)
    advance()
  }

  function exit() {
    setPhase('setup'); setQueue([]); bufferRef.current = []; setLastApplied(null)
    setConfirmAcceptAll(false); setKeepChoice({})
  }

  // Cmd/Ctrl+Z is a shortcut for the same Undo the button runs — one code path, no drift.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z')) return
      if (!lastApplied || !userId || busy) return
      e.preventDefault()
      void undoLast()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lastApplied, userId, busy])   // eslint-disable-line react-hooks/exhaustive-deps

  const current = queue[0]

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Agent picker — this page is the card editor; siblings link out. Every agent proposes and
          waits for approval, so switching between them is never destructive. */}
      <div className="flex flex-wrap gap-2">
        <span className="text-xs px-3 py-1.5 rounded-full border border-accent bg-accent/15 text-ink">✏️ Card editor</span>
        <a href="/agents/organizer"
          className="text-xs px-3 py-1.5 rounded-full border border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40 transition-colors">
          🗂 Card organizer
        </a>
      </div>

      <div>
        <h1 className="text-2xl font-semibold text-ink">Card editor agent</h1>
        <p className="text-sm text-ink-muted mt-1">
          {`Tell it what to change, pick which cards it may touch and which side it may see, and it scans them in batches of ${BATCH_SIZE}. You approve or deny each proposed change; approved ones are applied immediately.`}
        </p>
      </div>

      {phase === 'setup' && (
        <div className="panel space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-ink-faint">Common tasks</label>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void runDedupe('front')} disabled={!userId || busy || selected.size === 0}
                title="Group cards that use the same word, whatever the meanings say"
                className="text-xs px-3 py-1.5 rounded-full border border-danger/30 text-ink hover:bg-danger/10 disabled:opacity-40 transition-colors">
                🧹 De-dupe · same word
              </button>
              <button type="button" onClick={() => void runDedupe('front-back')} disabled={!userId || busy || selected.size === 0}
                title="Group only cards where BOTH sides match"
                className="text-xs px-3 py-1.5 rounded-full border border-danger/30 text-ink hover:bg-danger/10 disabled:opacity-40 transition-colors">
                🧹 De-dupe · exact copies
              </button>
              <button type="button" onClick={() => setTask("Remove the leading 'to ' from every verb gloss (the back), e.g. 'to run' → 'run'. Only touch verbs.")}
                className="text-xs px-3 py-1.5 rounded-full border border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40 transition-colors">
                Strip “to ” from verbs
              </button>
              <button type="button" onClick={() => setTask('For every noun card, append the grammatical gender in parentheses to the gloss if it is missing, e.g. "el gato" gloss "cat" → "cat (m)".')}
                className="text-xs px-3 py-1.5 rounded-full border border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40 transition-colors">
                Add noun gender
              </button>
              <button type="button" onClick={() => void runLabeling()} disabled={!userId || labelBusy || busy || selected.size === 0}
                title="Tag each card with its part of speech and dictionary form, so Practice can build sentences from it"
                className="text-xs px-3 py-1.5 rounded-full border border-accent/30 text-ink hover:bg-accent/10 disabled:opacity-40 transition-colors">
                {labelBusy && labelProgress
                  ? `🏷 Labeling… ${labelProgress.done} / ${labelProgress.total}`
                  : labelBusy ? '🏷 Labeling…' : '🏷 Label vocabulary'}
              </button>
            </div>
            {labelMsg && <p className="text-[11px] text-success">{labelMsg}</p>}
            <p className="text-[10px] text-ink-faint">
              De-dupe runs instantly, with no AI, on the scope you select below — pick a language, folder
              or deck first. Each duplicate group is shown in full so you can choose which copy survives;
              by default it keeps the one with the most review progress. Label vocabulary applies
              directly, with no review step — labels are derived metadata, not content, and only
              unlabeled cards are sent, so it&apos;s safe to re-run. The other buttons fill the box
              above; pick a scope, then Start scanning.
            </p>
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
            <ScopeTreePicker tree={tree} selState={selState} expanded={expanded}
              onToggleSel={toggleDecks} onToggleExpand={toggleExpand} />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-ink-faint">
              What the agent may see <span className="text-ink-faint/70">(you always review the whole card)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {([
                ['both',  'Both sides'],
                ['front', 'Front only'],
                ['back',  'Back only'],
              ] as [AgentSides, string][]).map(([val, label]) => (
                <button key={val} type="button" onClick={() => setSides(val)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    sides === val ? 'border-accent bg-accent/15 text-ink' : 'border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40'}`}>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-ink-faint">
              {sides === 'both'
                ? 'The agent sees the word and its meaning, and may change either.'
                : sides === 'front'
                  ? 'The meaning is hidden from the agent, so it can’t be swayed by it — and it may only change the word.'
                  : 'The word is hidden from the agent, so it can’t be swayed by it — and it may only change the meaning. Splitting is unavailable without the word.'}
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-ink-faint">Card status <span className="text-ink-faint/70">(none = all statuses)</span></label>
            <div className="flex flex-wrap gap-2">
              {STATUS_META.map(s => {
                const on = statuses.has(s.key)
                return (
                  <button key={s.key} type="button" onClick={() => toggleStatus(s.key)}
                    className={`text-xs px-3 py-1.5 rounded-full border inline-flex items-center gap-1.5 transition-colors ${on ? 'border-accent bg-accent/15 text-ink' : 'border-line/10 text-ink-muted hover:text-ink hover:bg-surface/40'}`}>
                    <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </button>
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
          <ProposalView
            p={current}
            keepId={current.id ? keepChoice[current.id] : undefined}
            onKeep={cardId => { if (current.id) setKeepChoice(prev => ({ ...prev, [current.id!]: cardId })) }}
          />
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-xs text-ink-faint">{current.reason}</p>
            {/* How many decisions are still waiting. `+ more to scan` because on the AI path later
                batches haven't been analyzed yet, so the true total isn't known — better to say so
                than to show a number that keeps growing. */}
            <p className="text-xs text-ink-faint whitespace-nowrap">
              {`${queue.length} left${moreToScan ? ' + more to scan' : ''}`}
            </p>
          </div>
          <div className="flex gap-3">
            <button className="btn-ghost flex-1" disabled={busy} onClick={deny}>Deny</button>
            <button className="btn-primary flex-1" disabled={busy} onClick={approve}>
              {busy ? 'Applying…'
                : current.action === 'dedupe' ? `Delete ${Math.max(0, (current.group?.length ?? 1) - 1)}`
                : 'Approve'}
            </button>
          </div>

          {queue.length > 1 && !confirmAcceptAll && (
            <button className="btn-ghost w-full text-xs" disabled={busy} onClick={() => setConfirmAcceptAll(true)}>
              {`Accept all ${queue.length} remaining`}
            </button>
          )}
          {confirmAcceptAll && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 space-y-2">
              <p className="text-xs text-ink">
                {`Apply all ${queue.length} remaining change${queue.length === 1 ? '' : 's'} without reviewing them?`}
              </p>
              <p className="text-[11px] text-ink-muted">
                {queue.some(p => p.action === 'dedupe')
                  ? 'Duplicate groups keep whichever copy is currently marked Keep — the default is the copy with the most review progress. This cannot be undone in one press.'
                  : 'This cannot be undone in one press — Undo only reverses a single change.'}
              </p>
              <div className="flex gap-2">
                <button className="btn-ghost text-xs px-3 py-1.5 flex-1" disabled={busy} onClick={() => setConfirmAcceptAll(false)}>Cancel</button>
                <button className="btn-primary text-xs px-3 py-1.5 flex-1" disabled={busy} onClick={() => void acceptAll()}>
                  {busy ? 'Applying…' : 'Apply all'}
                </button>
              </div>
            </div>
          )}
          {lastApplied && (
            <button
              className="btn-ghost w-full text-xs"
              disabled={busy}
              onClick={() => void undoLast()}
            >
              {lastApplied.proposal.action === 'dedupe'
                ? `↩ Undo — restore ${lastApplied.deleted?.length ?? 0} deleted card${(lastApplied.deleted?.length ?? 0) === 1 ? '' : 's'} (⌘Z)`
                : '↩ Undo last approval (⌘Z)'}
            </button>
          )}
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

/**
 * One card of a duplicate group, shown in full. The keeper is normal ink; the rest are red, since
 * approving deletes them. Clicking any card makes it the keeper — the deck name is shown because
 * group members are otherwise identical by construction.
 */
function DupeCard({ card, keep, onKeep }: { card: ScopedCard; keep: boolean; onKeep: () => void }) {
  return (
    <button
      type="button"
      onClick={onKeep}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
        keep ? 'border-line/25 bg-surface/40 text-ink' : 'border-danger/40 bg-danger/5 text-danger/80 hover:border-line/25'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-mono truncate">{card.front} <span className="opacity-60">=</span> {card.back}</span>
        <span className={`text-[10px] uppercase tracking-wider shrink-0 ${keep ? 'text-success' : 'text-danger'}`}>
          {keep ? 'Keep' : 'Delete'}
        </span>
      </div>
      {card.deckName && <p className="text-[10px] text-ink-faint mt-0.5 truncate">{card.deckName}</p>}
    </button>
  )
}

function ProposalView({ p, keepId, onKeep }: { p: EditProposal; keepId?: string; onKeep?: (cardId: string) => void }) {
  if (p.action === 'dedupe' && p.group) {
    const keep = keepId ?? p.keepCardId
    return (
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-ink-faint">
          Duplicates — click a card to keep it instead
        </p>
        {p.group.map(c => (
          <DupeCard key={c.cardId} card={c} keep={c.cardId === keep} onKeep={() => onKeep?.(c.cardId)} />
        ))}
      </div>
    )
  }
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

