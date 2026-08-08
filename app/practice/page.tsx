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
import { resolveTargets, DEFAULT_CAP_PER_SOURCE, type TargetSource } from '@/engine/practiceSelect'
import { generatePracticeExercises, type PreparedExercise } from '@/lib/practiceGenerate'
import { labelCards } from '@/lib/labelCards'
import { normalizeFrontKey } from '@/lib/duplicates'
import { descendantDeckIds } from '@/lib/folderStats'
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
type PickerTab = 'words' | 'decks' | 'folders' | 'due' | 'hardest' | 'paste'

const TABS: { id: PickerTab; label: string }[] = [
  { id: 'words',   label: 'Words'   },
  { id: 'decks',   label: 'Decks'   },
  { id: 'folders', label: 'Folders' },
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

/** Sizes offered by the "Hardest" tab — a band, not a raw FSRS difficulty number. */
const HARDEST_SIZES = [10, 20, 50]

export default function PracticePage() {
  const offline = useOfflineMode()
  if (offline) return <OfflineUnavailable feature="Practice" />
  return <PracticeInner />
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
  const [deckSel,   setDeckSel]   = useState<Set<string>>(new Set())
  const [folderSel, setFolderSel] = useState<Set<string>>(new Set())
  const [dueDays,   setDueDays]   = useState<number | null>(null)
  const [hardest,   setHardest]   = useState<number | null>(null)
  const [pasted,    setPasted]    = useState('')

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
    setSelected(new Set()); setDeckSel(new Set()); setFolderSel(new Set())
    setDueDays(null); setHardest(null); setPasted('')
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
    deckIdsByFolder: new Map(
      folders.map(f => [f.id, descendantDeckIds(f.id, folders, decks)]),
    ),
    today: getToday(deviceTimeZone()),
    normalizeKey: (text: string) => normalizeFrontKey(text, pair?.sourceLanguage ?? ''),
  }), [cards, states, cardIdsByDeck, folders, decks, pair?.sourceLanguage])

  /** The active sources, in the order they contribute to the session. */
  const sources = useMemo<TargetSource[]>(() => {
    const out: TargetSource[] = []
    if (selected.size   > 0)  out.push({ type: 'manual',  cardIds: [...selected] })
    if (deckSel.size    > 0)  out.push({ type: 'decks',   deckIds: [...deckSel] })
    if (folderSel.size  > 0)  out.push({ type: 'folders', folderIds: [...folderSel] })
    if (dueDays !== null)     out.push({ type: 'due',     withinDays: dueDays })
    if (hardest !== null)     out.push({ type: 'difficulty', limit: hardest })
    if (pasted.trim())        out.push({ type: 'list',    text: pasted })
    return out
  }, [selected, deckSel, folderSel, dueDays, hardest, pasted])

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

  /** Generic set toggle for the deck and folder checklists. */
  function toggleIn(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function clearAllSources() {
    setSelected(new Set()); setDeckSel(new Set()); setFolderSel(new Set())
    setDueDays(null); setHardest(null); setPasted('')
  }

  /** Removes one word from the session — it may have arrived via any source, so the fix depends. */
  function removeTarget(cardId: string) {
    if (selected.has(cardId)) { toggle(cardId); return }
    // It came from a bulk source, which has no per-card handle. Pin the current selection down to
    // the explicit list minus this word, so the removal sticks.
    setSelected(new Set(chosen.filter(t => t.cardId !== cardId).map(t => t.cardId)))
    setDeckSel(new Set()); setFolderSel(new Set())
    setDueDays(null); setHardest(null); setPasted('')
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

        {/* ── Decks / Folders: checklists ── */}
        {(tab === 'decks' || tab === 'folders') && (() => {
          const isDecks = tab === 'decks'
          const items = isDecks
            ? decks.map(d => ({ id: d.id, name: d.name }))
            // Only folders that actually contain a deck of this pair are worth offering.
            : folders
                .filter(f => descendantDeckIds(f.id, folders, decks).length > 0)
                .map(f => ({ id: f.id, name: f.name }))
          const sel = isDecks ? deckSel : folderSel
          const setter = isDecks ? setDeckSel : setFolderSel
          if (items.length === 0) {
            return <p className="text-xs text-ink-faint py-3 text-center">
              No {isDecks ? 'decks' : 'folders'} in this language yet.
            </p>
          }
          return (
            <div className="rounded-card border border-line/10 divide-y divide-line/5 max-h-64 overflow-y-auto">
              {items.map(item => (
                <button key={item.id} onClick={() => toggleIn(setter, item.id)}
                  className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 transition-colors ${
                    sel.has(item.id) ? 'bg-accent/10' : 'hover:bg-surface-raised/50'
                  }`}>
                  <span className="text-sm text-ink truncate">{item.name}</span>
                  {sel.has(item.id) && <span className="text-accent text-sm shrink-0">✓</span>}
                </button>
              ))}
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

        {/* ── Hardest ── */}
        {tab === 'hardest' && (
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
