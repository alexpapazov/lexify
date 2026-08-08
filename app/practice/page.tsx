'use client'

/**
 * app/practice/page.tsx — Practice Mode: generate exercises from your own vocabulary.
 *
 * Setup, then play. Setup is where the deterministic work happens, deliberately BEFORE any API
 * call: the library index and coverage check (`engine/practice.ts`) can tell you "you have 400
 * nouns and two verbs, this won't work" for free, so a doomed generation never gets paid for.
 *
 * Target words are chosen, never auto-queued — but "chosen" means six things (a word, a deck, a
 * folder, what's due, what's hard, a pasted list), so selection lives in `engine/practiceSelect.ts`
 * and this file just drives it. Practice writes nothing to card_states; see
 * `components/practice/ClozePlayer.tsx`.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { buildLibraryIndex, vocabularyCoverage, toPracticeTargets, type PracticeTarget } from '@/engine/practice'
import {
  resolveTargets, DEFAULT_CAP_PER_SOURCE, MIN_DIFFICULTY, MAX_DIFFICULTY, type TargetSource,
} from '@/engine/practiceSelect'
import { buildScopeTree, type TreeNode } from '@/lib/scopeTree'
import { generatePracticeExercises, type PreparedExercise } from '@/lib/practiceGenerate'
import { labelCards } from '@/lib/labelCards'
import { normalizeFrontKey } from '@/lib/duplicates'
import { getToday } from '@/lib/dates'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { ClozePlayer } from '@/components/practice/ClozePlayer'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { langName, langFlag } from '@/lib/languages'
import type { Card, CardState, Deck, Folder, LanguagePair } from '@/domain'

/** Used when a pair has never had its slider set. Reachable for a mid-sized library. */
const DEFAULT_GRADUATED_PCT = 70

/** Exercise-count choices. Kept small: every exercise is a generated sentence, and a long batch
 *  means a long wait before the first one appears. */
const COUNT_CHOICES = [3, 5, 8]

/** Which picker is open. Every tab feeds the same target set — they compose, they don't replace. */
type PickerTab = 'words' | 'library' | 'starred' | 'due' | 'hardest' | 'paste'

const TABS: { id: PickerTab; label: string }[] = [
  { id: 'words',   label: 'Words'   },
  { id: 'library', label: 'Decks & folders' },
  { id: 'starred', label: '★ Starred' },
  { id: 'due',     label: 'Due soon' },
  { id: 'hardest', label: 'Hardest' },
  { id: 'paste',   label: 'Paste a list' },
]

/** Windows offered by the "Due soon" tab. */
const DUE_WINDOWS = [
  { days: 0,  label: 'Today' },
  { days: 3,  label: '3 days' },
  { days: 7,  label: 'This week' },
  { days: 30, label: 'This month' },
]

/** Quick "just give me the worst ones" sizes. */
const HARDEST_SIZES = [10, 20, 50]

/** Starting band for the difficulty-range sampler — the upper half, i.e. the words that fight back. */
const DEFAULT_RANGE: [number, number] = [6, 10]
const DEFAULT_RANGE_LIMIT = 15

export default function PracticePage() {
  const offline = useOfflineMode()
  if (offline) return <OfflineUnavailable feature="Practice" />
  return <PracticeInner />
}

/**
 * One row of the mini-library tree: a folder you can expand, or a deck you can check.
 *
 * Selection is by DECK id throughout — checking a folder checks every deck beneath it, so the
 * engine only ever needs a deck list and there's no second copy of "what's inside this folder".
 * A folder shows as checked only when all its decks are, and half-lit when some are.
 */
function ScopeRow({ node, depth, deckSel, expanded, onToggleDecks, onToggleExpanded }: {
  node:             TreeNode
  depth:            number
  deckSel:          Set<string>
  expanded:         Set<string>
  onToggleDecks:    (ids: string[]) => void
  onToggleExpanded: (id: string) => void
}) {
  const pad = { paddingLeft: `${depth * 16 + 12}px` }

  if (node.kind === 'deck') {
    const on = deckSel.has(node.id)
    return (
      <button onClick={() => onToggleDecks([node.id])} style={pad}
        className={`w-full text-left pr-3 py-2 flex items-center gap-2 transition-colors ${
          on ? 'bg-accent/10' : 'hover:bg-surface-raised/50'
        }`}>
        <span className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center text-[9px] ${
          on ? 'border-accent bg-accent/20 text-accent' : 'border-line/30'
        }`}>{on ? '✓' : ''}</span>
        <span className="text-ink-muted shrink-0">🗂</span>
        <span className="text-sm text-ink truncate">{node.name}</span>
      </button>
    )
  }

  const all  = node.deckIds.length > 0 && node.deckIds.every(id => deckSel.has(id))
  const some = !all && node.deckIds.some(id => deckSel.has(id))
  const open = expanded.has(node.id)

  return (
    <>
      <div style={pad} className="w-full pr-3 py-2 flex items-center gap-2 hover:bg-surface-raised/50 transition-colors">
        <button onClick={() => onToggleDecks(node.deckIds)} title="Select every deck in this folder"
          className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center text-[9px] ${
            all  ? 'border-accent bg-accent/20 text-accent'
            : some ? 'border-accent/60 bg-accent/10 text-accent'
            : 'border-line/30'
          }`}>{all ? '✓' : some ? '–' : ''}</button>
        <button onClick={() => onToggleExpanded(node.id)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left">
          <span className="text-ink-faint text-[10px] w-2 shrink-0">{open ? '▾' : '▸'}</span>
          <span className="text-ink-muted shrink-0">📁</span>
          <span className="text-sm text-ink truncate">{node.name}</span>
          <span className="text-xs text-ink-faint shrink-0">{node.deckIds.length}</span>
        </button>
      </div>
      {open && node.children.map(child => (
        <ScopeRow key={child.id} node={child} depth={depth + 1}
          deckSel={deckSel} expanded={expanded}
          onToggleDecks={onToggleDecks} onToggleExpanded={onToggleExpanded} />
      ))}
    </>
  )
}

function PracticeInner() {
  const [loading,  setLoading]  = useState(true)
  const [userId,   setUserId]   = useState('')
  const [pairs,    setPairs]    = useState<LanguagePair[]>([])
  const [pairKey,  setPairKey]  = useState('')
  const [cards,    setCards]    = useState<Card[]>([])
  const [states,   setStates]   = useState<CardState[]>([])
  const [decks,    setDecks]    = useState<Deck[]>([])
  const [folders,  setFolders]  = useState<Folder[]>([])
  /** deck id → its card ids, for the deck/folder sources. */
  const [cardIdsByDeck, setCardIdsByDeck] = useState<Map<string, string[]>>(new Map())

  // ── Selection state: one entry per source kind, all composed at the end ─────
  const [tab,       setTab]       = useState<PickerTab>('words')
  const [search,    setSearch]    = useState('')
  const [selected,  setSelected]  = useState<Set<string>>(new Set())   // manual card ids
  const [deckSel,   setDeckSel]   = useState<Set<string>>(new Set())   // deck ids (folders check theirs)
  const [expanded,  setExpanded]  = useState<Set<string>>(new Set())   // open folders in the tree
  const [dueDays,   setDueDays]   = useState<number | null>(null)
  const [hardest,   setHardest]   = useState<number | null>(null)
  const [pasted,    setPasted]    = useState('')
  const [starredOn, setStarredOn] = useState(false)
  // Difficulty-range sampler: a band, a ceiling, and a seed you can re-roll.
  const [rangeOn,    setRangeOn]    = useState(false)
  const [range,      setRange]      = useState<[number, number]>(DEFAULT_RANGE)
  const [rangeLimit, setRangeLimit] = useState(DEFAULT_RANGE_LIMIT)
  const [rangeSeed,  setRangeSeed]  = useState(1)

  const [pct,       setPct]       = useState(DEFAULT_GRADUATED_PCT)
  const [count,     setCount]     = useState(COUNT_CHOICES[1]!)

  const [generating, setGenerating] = useState(false)
  const [labeling,   setLabeling]   = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [session,    setSession]    = useState<PreparedExercise[] | null>(null)
  const [notice,     setNotice]     = useState<string | null>(null)

  const pair = pairs.find(p => `${p.sourceLanguage}|${p.targetLanguage}` === pairKey) ?? null

  // ── Load: pairs once, then this pair's cards + states ──────────────────────
  useEffect(() => {
    void (async () => {
      const { data: { session: authSession } } = await createClient().auth.getSession()
      if (!authSession) { setLoading(false); return }
      setUserId(authSession.user.id)
      const list = await new SupabaseLanguagePairRepository().list(authSession.user.id)
      setPairs(list)
      if (list.length > 0) setPairKey(`${list[0]!.sourceLanguage}|${list[0]!.targetLanguage}`)
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!userId || !pair) return
    let cancelled = false
    // Switching language invalidates every selection — the words no longer exist here.
    setSelected(new Set()); setDeckSel(new Set()); setExpanded(new Set())
    setDueDays(null); setHardest(null); setPasted(''); setRangeOn(false); setStarredOn(false)
    void (async () => {
      const [pairCards, allStates, allDecks, allFolders] = await Promise.all([
        new SupabaseCardRepository().listOwned(userId, pair.sourceLanguage, pair.targetLanguage),
        new SupabaseCardStateRepository().listAllForUser(userId),
        new SupabaseDeckRepository().list(userId),
        new SupabaseFolderRepository().list(userId),
      ])
      if (cancelled) return
      const pairDecks = allDecks.filter(d =>
        d.sourceLanguage === pair.sourceLanguage && d.targetLanguage === pair.targetLanguage)
      // deck → cards, in one bulk read, so the deck and folder sources need no further queries.
      const byDeck = await new SupabaseCardRepository().listForDecks(pairDecks.map(d => d.id))
      if (cancelled) return

      setCards(pairCards)
      setStates(allStates)
      setDecks(pairDecks)
      setFolders(allFolders)
      setCardIdsByDeck(new Map([...byDeck].map(([deckId, list]) => [deckId, list.map(c => c.id)])))
      setPct(pair.practiceGraduatedPct ?? DEFAULT_GRADUATED_PCT)
    })()
    return () => { cancelled = true }
  }, [userId, pairKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived: the library index and what it can support ─────────────────────
  const index    = useMemo(() => buildLibraryIndex(cards, states), [cards, states])
  const coverage = useMemo(() => vocabularyCoverage(index), [index])

  /** Everything the selection engine reads. Rebuilt whenever the underlying data changes. */
  const selectionCtx = useMemo(() => ({
    cards,
    // Forward rows only — practice is production, matching how the library index reads graduation.
    statesByCard: new Map(
      states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]),
    ),
    cardIdsByDeck,
    today: getToday(deviceTimeZone()),
    normalizeKey: (text: string) => normalizeFrontKey(text, pair?.sourceLanguage ?? ''),
  }), [cards, states, cardIdsByDeck, pair?.sourceLanguage])

  /** This pair's slice of the library, as a navigable tree (shared with the agent's scope picker). */
  const tree = useMemo(() => {
    const pairs = buildScopeTree(folders, decks)
    return pairs.find(p => p.key === pairKey)?.children ?? []
  }, [folders, decks, pairKey])

  /** The active sources, in the order they contribute to the session. */
  const sources = useMemo<TargetSource[]>(() => {
    const out: TargetSource[] = []
    if (selected.size > 0)  out.push({ type: 'manual', cardIds: [...selected] })
    if (deckSel.size  > 0)  out.push({ type: 'decks',  deckIds: [...deckSel] })
    if (starredOn)          out.push({ type: 'starred' })
    if (dueDays !== null)   out.push({ type: 'due',    withinDays: dueDays })
    if (hardest !== null)   out.push({ type: 'difficulty', limit: hardest })
    if (rangeOn)            out.push({
      type: 'difficultyRange', min: range[0], max: range[1], limit: rangeLimit, seed: rangeSeed,
    })
    if (pasted.trim())      out.push({ type: 'list',   text: pasted })
    return out
  }, [selected, deckSel, starredOn, dueDays, hardest, rangeOn, range, rangeLimit, rangeSeed, pasted])

  const selection = useMemo(() => resolveTargets(sources, selectionCtx), [sources, selectionCtx])
  const chosen: PracticeTarget[] = selection.targets

  /** Only for the Words tab's browsable list — every other source resolves in the engine. */
  const drillable = useMemo(() => toPracticeTargets(cards), [cards])

  const results = useMemo(() => {
    const q = search.trim().toLowerCase()
    const pool = q
      ? drillable.filter(t => t.front.toLowerCase().includes(q) || t.back.toLowerCase().includes(q))
      : drillable
    return pool.slice(0, 60)      // the picker is a browser, not a full library listing
  }, [drillable, search])

  function toggle(cardId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId); else next.add(cardId)
      return next
    })
  }

  /** Toggle a set of deck ids together — one deck, or every deck under a folder. */
  function toggleDecks(ids: string[]) {
    setDeckSel(prev => {
      const next = new Set(prev)
      const allOn = ids.every(id => next.has(id))
      for (const id of ids) { if (allOn) next.delete(id); else next.add(id) }
      return next
    })
  }

  function toggleExpanded(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function clearAllSources() {
    setSelected(new Set()); setDeckSel(new Set()); setStarredOn(false)
    setDueDays(null); setHardest(null); setPasted(''); setRangeOn(false)
  }

  /** Removes one word from the session — it may have arrived via any source, so the fix depends. */
  function removeTarget(cardId: string) {
    if (selected.has(cardId)) { toggle(cardId); return }
    // It came from a bulk source, which has no per-card handle. Pin the current selection down to
    // the explicit list minus this word, so the removal sticks.
    setSelected(new Set(chosen.filter(t => t.cardId !== cardId).map(t => t.cardId)))
    setDeckSel(new Set()); setStarredOn(false)
    setDueDays(null); setHardest(null); setPasted(''); setRangeOn(false)
  }

  async function runLabeling() {
    if (labeling) return
    setLabeling(true)
    setError(null)
    try {
      const unlabeled = cards.filter(c => !c.pos).map(c => ({
        id: c.id, front: c.front, back: c.back,
        sourceLanguage: c.sourceLanguage, targetLanguage: c.targetLanguage,
      }))
      await labelCards(unlabeled)
      const fresh = await new SupabaseCardRepository().listOwned(userId, pair!.sourceLanguage, pair!.targetLanguage)
      setCards(fresh)
      setNotice('Labels updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Labeling failed.')
    } finally {
      setLabeling(false)
    }
  }

  async function start() {
    if (!pair || chosen.length === 0 || generating) return
    setGenerating(true)
    setError(null)
    setNotice(null)
    try {
      // Remember the slider for this pair; a failure here must not block the session.
      if (pct !== pair.practiceGraduatedPct) {
        new SupabaseLanguagePairRepository()
          .updatePracticeGraduatedPct(pair.sourceLanguage, pair.targetLanguage, pct)
          .catch(() => {})
      }
      const run = await generatePracticeExercises({
        targets: chosen,
        index,
        sourceLanguage: pair.sourceLanguage,
        targetLanguage: pair.targetLanguage,
        count,
        minGraduatedPct: pct,
        // Varies which known words the generator sees, so a repeat run isn't the same sentences.
        helperSeed: chosen.length + count,
      })
      if (run.exercises.length === 0) {
        setError('The generator didn’t return any usable sentences. Try again, or pick different words.')
        return
      }
      if (run.missingCount > 0) {
        setNotice(`Generated ${run.exercises.length} of ${count} — the rest didn’t come back usable.`)
      }
      setSession(run.exercises)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed. Please try again.')
    } finally {
      setGenerating(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  if (!userId) return (
    <div className="panel text-center space-y-4 py-12 max-w-2xl mx-auto">
      <p className="text-ink-muted">Sign in to use Practice.</p>
      <Link href="/auth" className="btn-primary inline-block">Sign in</Link>
    </div>
  )

  if (session) {
    return (
      <ClozePlayer
        items={session}
        answerLanguage={pair!.sourceLanguage}
        onExit={() => { setSession(null); setNotice(null) }}
      />
    )
  }

  if (pairs.length === 0) return (
    <div className="panel text-center space-y-4 py-12 max-w-2xl mx-auto">
      <p className="text-ink-muted">Add a language and some cards first — practice builds sentences from your own vocabulary.</p>
      <Link href="/library" className="btn-primary inline-block">Go to Library</Link>
    </div>
  )

  return (
    <div className="space-y-6 max-w-2xl mx-auto pb-12">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Practice</h1>
        <p className="text-sm text-ink-muted mt-1">
          Fill-in-the-blank sentences built from words you already know. Nothing here changes your
          review schedule.
        </p>
      </div>

      {/* Language pair */}
      {pairs.length > 1 && (
        <div className="panel space-y-2">
          <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Language</label>
          <select className="input" value={pairKey} onChange={e => setPairKey(e.target.value)}>
            {pairs.map(p => {
              const key = `${p.sourceLanguage}|${p.targetLanguage}`
              return (
                <option key={p.id} value={key}>
                  {langFlag(p.sourceLanguage)} {langName(p.sourceLanguage)} → {langName(p.targetLanguage)}
                </option>
              )
            })}
          </select>
        </div>
      )}

      {/* Labeling and coverage, both computed locally before any API call.
          ORDER MATTERS: unlabeled graduated words make a full library look empty, so when those
          exist the labeling prompt is the real story and the coverage warning is suppressed —
          otherwise we'd tell someone with 200 known words that they know none. */}
      {index.unlabeledCount > 0 ? (
        <div className={`rounded-card border px-4 py-3 text-sm text-ink-muted flex items-center justify-between gap-3 flex-wrap ${
          index.graduatedUnlabeledCount > 0 ? 'border-warning/40 bg-warning/5' : 'border-line/20'
        }`}>
          <span>
            {index.graduatedUnlabeledCount > 0 ? (
              <>
                <strong className="text-ink">{index.graduatedUnlabeledCount} word
                {index.graduatedUnlabeledCount !== 1 ? 's you’ve' : ' you’ve'} already learned
                {index.graduatedUnlabeledCount !== 1 ? ' aren’t' : ' isn’t'} labeled yet.</strong>{' '}
                Practice builds sentences from labeled words, so label them to use your real
                vocabulary.
              </>
            ) : (
              <>
                {index.unlabeledCount} card{index.unlabeledCount !== 1 ? 's aren’t' : ' isn’t'} labeled
                yet, so {index.unlabeledCount !== 1 ? 'they' : 'it'} can’t appear in sentences.
              </>
            )}
          </span>
          <button onClick={() => void runLabeling()} disabled={labeling}
            className="btn-primary text-sm py-1.5 px-3 disabled:opacity-50 shrink-0">
            {labeling ? 'Labeling…' : `Label ${index.unlabeledCount}`}
          </button>
        </div>
      ) : coverage.verdict === 'narrow' && (
        <div className="rounded-card border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-ink-muted">
          <strong className="text-ink">Narrow vocabulary.</strong>{' '}
          {coverage.graduatedCount === 0
            ? 'You have no graduated words in this language yet, so sentences will be built almost entirely from words outside your library.'
            : `Not enough graduated ${coverage.missing.join('s, ')}s to build sentences from — simple words outside your library will fill the gaps.`}
        </div>
      )}

      {/* Word picker — six sources that COMPOSE into one target set. */}
      <div className="panel space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Words to practice</label>
          {chosen.length > 0 && (
            <button onClick={clearAllSources} className="text-xs text-ink-faint hover:text-ink transition-colors">
              Clear all
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                tab === t.id
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-line/15 text-ink-muted hover:text-ink'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Words: search and click ── */}
        {tab === 'words' && (
          drillable.length === 0 ? (
            <p className="text-xs text-ink-faint py-3 text-center">
              No labeled words in this language yet. Label your cards to start practising.
            </p>
          ) : (
            <div className="space-y-2">
              <input className="input text-sm" placeholder="Search your words…"
                value={search} onChange={e => setSearch(e.target.value)} />
              <div className="rounded-card border border-line/10 divide-y divide-line/5 max-h-64 overflow-y-auto">
                {results.map(t => {
                  const isSelected = selected.has(t.cardId)
                  return (
                    <button key={t.cardId} onClick={() => toggle(t.cardId)}
                      className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 transition-colors ${
                        isSelected ? 'bg-accent/10' : 'hover:bg-surface-raised/50'
                      }`}>
                      <span className="min-w-0">
                        <span className="text-sm text-ink font-medium">{t.front}</span>
                        <span className="text-xs text-ink-muted ml-2 truncate">{t.back}</span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="chip text-[0.65rem]">{t.pos}</span>
                        {isSelected && <span className="text-accent text-sm">✓</span>}
                      </span>
                    </button>
                  )
                })}
                {results.length === 0 && (
                  <p className="text-xs text-ink-faint py-3 text-center">No words match “{search}”.</p>
                )}
              </div>
              {drillable.length > results.length && !search && (
                <p className="text-xs text-ink-faint">Showing {results.length} of {drillable.length} — search to narrow.</p>
              )}
            </div>
          )
        )}

        {/* ── Decks & folders: the library as a navigable tree ── */}
        {tab === 'library' && (
          tree.length === 0 ? (
            <p className="text-xs text-ink-faint py-3 text-center">No decks in this language yet.</p>
          ) : (
            <div className="rounded-card border border-line/10 max-h-72 overflow-y-auto py-1">
              {tree.map(node => (
                <ScopeRow key={node.id} node={node} depth={0}
                  deckSel={deckSel} expanded={expanded}
                  onToggleDecks={toggleDecks} onToggleExpanded={toggleExpanded} />
              ))}
            </div>
          )
        )}

        {/* ── Starred ── */}
        {tab === 'starred' && (() => {
          const starCount = cards.filter(c => c.starred).length
          return (
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={starredOn} disabled={starCount === 0}
                  onChange={e => setStarredOn(e.target.checked)}
                  className="accent-accent w-4 h-4 disabled:opacity-40" />
                <span className={`text-sm ${starCount === 0 ? 'text-ink-faint' : 'text-ink'}`}>
                  {starCount === 0
                    ? 'No starred cards in this language yet'
                    : `Practice my ${starCount} starred card${starCount !== 1 ? 's' : ''}`}
                </span>
              </label>
              <p className="text-xs text-ink-faint">
                Star a card from the ★ in its top-left corner while studying. Unlike “Hardest”, this is
                whatever you marked — not what your review history inferred.
              </p>
            </div>
          )
        })()}

        {/* ── Due soon ── */}
        {tab === 'due' && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {DUE_WINDOWS.map(w => (
                <button key={w.days} onClick={() => setDueDays(dueDays === w.days ? null : w.days)}
                  className={`px-4 py-1.5 rounded-lg text-sm border transition-colors ${
                    dueDays === w.days ? 'border-accent text-accent bg-accent/10' : 'border-line/20 text-ink-muted hover:text-ink'
                  }`}>
                  {w.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-ink-faint">
              Graduated words coming up for review, soonest first. Anything already overdue is included.
            </p>
          </div>
        )}

        {/* ── Hardest: the quick "worst N", plus a difficulty band sampled at random ── */}
        {tab === 'hardest' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {HARDEST_SIZES.map(n => (
                  <button key={n} onClick={() => setHardest(hardest === n ? null : n)}
                    className={`px-4 py-1.5 rounded-lg text-sm border transition-colors ${
                      hardest === n ? 'border-accent text-accent bg-accent/10' : 'border-line/20 text-ink-muted hover:text-ink'
                    }`}>
                    Hardest {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-ink-faint">
                The words your review history says you find hardest, most lapses first among ties.
              </p>
            </div>

            <div className="border-t border-line/10 pt-4 space-y-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={rangeOn} onChange={e => setRangeOn(e.target.checked)}
                  className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Pick from a difficulty range instead</span>
              </label>

              {rangeOn && (
                <div className="space-y-3 pl-6">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-ink-muted">Easiest included</span>
                      <span className="text-sm text-ink tabular-nums">{range[0].toFixed(1)}</span>
                    </div>
                    <input type="range" min={MIN_DIFFICULTY} max={MAX_DIFFICULTY} step={0.5}
                      value={range[0]}
                      // Keep the handles from crossing — a reversed band is confusing even though
                      // the engine tolerates it.
                      onChange={e => setRange(([, hi]) => [Math.min(Number(e.target.value), hi), hi])}
                      className="w-full accent-accent" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-ink-muted">Hardest included</span>
                      <span className="text-sm text-ink tabular-nums">{range[1].toFixed(1)}</span>
                    </div>
                    <input type="range" min={MIN_DIFFICULTY} max={MAX_DIFFICULTY} step={0.5}
                      value={range[1]}
                      onChange={e => setRange(([lo]) => [lo, Math.max(Number(e.target.value), lo)])}
                      className="w-full accent-accent" />
                  </div>

                  <div className="flex items-end gap-3 flex-wrap">
                    <div className="space-y-1.5">
                      <label className="text-xs text-ink-muted block">Most cards to take</label>
                      <input type="number" min={1} max={200} className="input w-28"
                        value={rangeLimit}
                        onChange={e => setRangeLimit(Math.max(1, Math.min(200, parseInt(e.target.value) || 1)))} />
                    </div>
                    <button onClick={() => setRangeSeed(s => s + 1)}
                      title="Draw a different random selection from the same range"
                      className="btn-ghost text-sm py-2 px-3">
                      ⟳ Shuffle
                    </button>
                  </div>

                  <p className="text-xs text-ink-faint">
                    Difficulty runs 1 (easy) to 10 (hard), from your review history. Cards in the
                    range are picked <strong className="text-ink-muted">at random</strong>, so
                    repeating this doesn&apos;t drill the same words — press Shuffle for a new draw.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Paste a list ── */}
        {tab === 'paste' && (
          <div className="space-y-2">
            <textarea className="input min-h-[110px] text-sm" value={pasted}
              onChange={e => setPasted(e.target.value)}
              placeholder={'One word per line, or comma-separated…'} />
            <p className="text-xs text-ink-faint">
              Matched against your library the same way duplicate detection does, so an article
              doesn&apos;t matter. Words you don&apos;t have are listed below rather than dropped silently.
            </p>
          </div>
        )}

        {/* ── What the sources actually resolved to ── */}
        {chosen.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-ink-muted">{chosen.length} word{chosen.length !== 1 ? 's' : ''} selected</span>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
              {chosen.map(t => (
                <button key={t.cardId} onClick={() => removeTarget(t.cardId)}
                  title="Remove from this session"
                  className="text-xs px-2.5 py-1 rounded-full border border-accent/30 bg-accent/5 text-ink hover:border-danger/40 hover:text-danger transition-colors">
                  {t.front} ✕
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Anything a source matched but couldn't use — never shrink the list silently. */}
        {(selection.droppedUnlabeled > 0 || selection.droppedUndrillable > 0
          || selection.unmatched.length > 0 || selection.capped.length > 0) && (
          <div className="text-xs text-ink-faint space-y-1 pt-1 border-t border-line/10">
            {selection.droppedUnlabeled > 0 && (
              <p>{selection.droppedUnlabeled} matched card{selection.droppedUnlabeled !== 1 ? 's aren’t' : ' isn’t'} labeled yet, so {selection.droppedUnlabeled !== 1 ? 'they were' : 'it was'} skipped.</p>
            )}
            {selection.droppedUndrillable > 0 && (
              <p>{selection.droppedUndrillable} skipped as phrases or grammar words — those don&apos;t make good blanks.</p>
            )}
            {selection.capped.length > 0 && (
              <p>Capped at {DEFAULT_CAP_PER_SOURCE} words per deck, folder or due window.</p>
            )}
            {selection.unmatched.length > 0 && (
              <p>Not in your library: {selection.unmatched.slice(0, 8).join(', ')}
                {selection.unmatched.length > 8 ? ` and ${selection.unmatched.length - 8} more` : ''}.</p>
            )}
          </div>
        )}
      </div>

      {/* Session settings */}
      <div className="panel space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
              Words from your graduated vocabulary
            </label>
            <span className="text-sm text-ink tabular-nums">{pct}%</span>
          </div>
          <input type="range" min={0} max={100} step={5} value={pct}
            onChange={e => setPct(Number(e.target.value))}
            className="w-full accent-accent" />
          <p className="text-xs text-ink-faint">
            How much of each sentence should be built from words you&apos;ve already graduated. Higher is
            easier to read; lower gives the generator more freedom. Remembered per language.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Sentences</label>
          <div className="flex gap-2">
            {COUNT_CHOICES.map(n => (
              <button key={n} onClick={() => setCount(n)}
                className={`px-4 py-1.5 rounded-lg text-sm border transition-colors ${
                  count === n ? 'border-accent text-accent bg-accent/10' : 'border-line/20 text-ink-muted hover:text-ink'
                }`}>
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error  && <p className="text-danger text-sm">{error}</p>}
      {notice && <p className="text-ink-muted text-sm">{notice}</p>}

      <button
        onClick={() => void start()}
        disabled={generating || chosen.length === 0}
        className="btn-primary w-full disabled:opacity-50"
      >
        {generating
          ? 'Writing sentences…'
          : chosen.length === 0
            ? 'Pick at least one word'
            : `Practice ${chosen.length} word${chosen.length !== 1 ? 's' : ''}`}
      </button>
    </div>
  )
}
