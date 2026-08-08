'use client'

/**
 * app/practice/page.tsx — Practice Mode: generate exercises from your own vocabulary.
 *
 * Setup, then play. Setup is where the deterministic work happens, deliberately BEFORE any API
 * call: the library index and coverage check (`engine/practice.ts`) can tell you "you have 400
 * nouns and two verbs, this won't work" for free, so a doomed generation never gets paid for.
 *
 * Target words are hand-picked — no auto-focus queue. Practice writes nothing to card_states; see
 * `components/practice/ClozePlayer.tsx`.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { buildLibraryIndex, vocabularyCoverage } from '@/engine/practice'
import { generatePracticeExercises, toPracticeTargets, type PreparedExercise, type PracticeTarget } from '@/lib/practiceGenerate'
import { labelCards } from '@/lib/labelCards'
import { ClozePlayer } from '@/components/practice/ClozePlayer'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { langName, langFlag } from '@/lib/languages'
import type { Card, CardState, LanguagePair, PartOfSpeech } from '@/domain'

/** Used when a pair has never had its slider set. Reachable for a mid-sized library. */
const DEFAULT_GRADUATED_PCT = 70

/** Exercise-count choices. Kept small: every exercise is a generated sentence, and a long batch
 *  means a long wait before the first one appears. */
const COUNT_CHOICES = [3, 5, 8]

/** Word classes that read badly as a cloze answer — you'd be guessing "the" from context. */
const UNDRILLABLE_POS: PartOfSpeech[] = ['determiner', 'pronoun', 'conjunction', 'preposition']

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

  const [search,    setSearch]    = useState('')
  const [selected,  setSelected]  = useState<Set<string>>(new Set())
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
    setSelected(new Set())
    void (async () => {
      const [pairCards, allStates] = await Promise.all([
        new SupabaseCardRepository().listOwned(userId, pair.sourceLanguage, pair.targetLanguage),
        new SupabaseCardStateRepository().listAllForUser(userId),
      ])
      if (cancelled) return
      setCards(pairCards)
      setStates(allStates)
      setPct(pair.practiceGraduatedPct ?? DEFAULT_GRADUATED_PCT)
    })()
    return () => { cancelled = true }
  }, [userId, pairKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived: the library index and what it can support ─────────────────────
  const index    = useMemo(() => buildLibraryIndex(cards, states), [cards, states])
  const coverage = useMemo(() => vocabularyCoverage(index), [index])

  /** Cards that can serve as a drill target: labeled, not a phrase, not a function word. */
  const drillable = useMemo(
    () => toPracticeTargets(cards).filter(t => !UNDRILLABLE_POS.includes(t.pos as PartOfSpeech)),
    [cards],
  )

  const results = useMemo(() => {
    const q = search.trim().toLowerCase()
    const pool = q
      ? drillable.filter(t => t.front.toLowerCase().includes(q) || t.back.toLowerCase().includes(q))
      : drillable
    return pool.slice(0, 60)      // the picker is a browser, not a full library listing
  }, [drillable, search])

  const chosen: PracticeTarget[] = useMemo(
    () => drillable.filter(t => selected.has(t.cardId)),
    [drillable, selected],
  )

  function toggle(cardId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId); else next.add(cardId)
      return next
    })
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
        helperSeed: selected.size + count,
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

      {/* Coverage + labeling warnings — both computed locally, before any API call */}
      {coverage.verdict === 'narrow' && (
        <div className="rounded-card border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-ink-muted">
          <strong className="text-ink">Narrow vocabulary.</strong>{' '}
          {coverage.graduatedCount === 0
            ? 'You have no graduated words in this language yet, so sentences will be built almost entirely from words outside your library.'
            : `Not enough graduated ${coverage.missing.join('s, ')}s to build sentences from — simple words outside your library will fill the gaps.`}
        </div>
      )}
      {index.unlabeledCount > 0 && (
        <div className="rounded-card border border-line/20 px-4 py-3 text-sm text-ink-muted flex items-center justify-between gap-3 flex-wrap">
          <span>
            {index.unlabeledCount} card{index.unlabeledCount !== 1 ? 's aren’t' : ' isn’t'} labeled yet,
            so {index.unlabeledCount !== 1 ? 'they' : 'it'} can’t be used in sentences.
          </span>
          <button onClick={() => void runLabeling()} disabled={labeling}
            className="btn-ghost text-sm py-1.5 px-3 disabled:opacity-50">
            {labeling ? 'Labeling…' : 'Label now'}
          </button>
        </div>
      )}

      {/* Word picker */}
      <div className="panel space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Words to practice</label>
          <span className="text-xs text-ink-faint">{selected.size} selected</span>
        </div>
        <input className="input text-sm" placeholder="Search your words…"
          value={search} onChange={e => setSearch(e.target.value)} />

        {drillable.length === 0 ? (
          <p className="text-xs text-ink-faint py-3 text-center">
            No labeled words in this language yet. Label your cards to start practising.
          </p>
        ) : (
          <div className="rounded-card border border-line/10 divide-y divide-line/5 max-h-72 overflow-y-auto">
            {results.map(t => {
              const isSelected = selected.has(t.cardId)
              return (
                <button
                  key={t.cardId}
                  onClick={() => toggle(t.cardId)}
                  className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 transition-colors ${
                    isSelected ? 'bg-accent/10' : 'hover:bg-surface-raised/50'
                  }`}
                >
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
        )}
        {drillable.length > results.length && !search && (
          <p className="text-xs text-ink-faint">Showing {results.length} of {drillable.length} — search to narrow.</p>
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
