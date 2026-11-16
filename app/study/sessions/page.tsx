'use client'

/**
 * /study/sessions — the EXTERNAL study session log (2026-11-15).
 *
 * The learner drills words outside Lexify (ChatGPT batches, writing/cloze/translation
 * exercises) and logs the batch here afterwards so the scheduler catches up — no relearning
 * through the pipeline. Flow: paste the word list + pick the study date → every word is
 * matched against the library (same lemma-primary index as media intake) → each word gets a
 * bucket (pre-painted "Just learned") → Save applies everything at once:
 *
 *   - word matches an EXISTING card → that card is UPDATED, never duplicated:
 *       · graduated + Just learned → schedule pinned into the 2–4 day window
 *       · graduated + Know it / Know it well → a real FSRS Good / Easy review
 *       · never-studied / mid-pipeline → the rating graduates THAT card (chip-style seeding)
 *   - no match → a new card in the pair's "External study" deck, born graduated in the
 *     bucket's window (fresh 2–4d / short 2–14d / long 80–100d); glosses pasted inline
 *     (`word — gloss`) or Haiku-filled, editable before saving
 *   - × skips a word entirely
 *
 * One-shot commit (not a resumable worklist — batches are small); the session row's items
 * are the audit trail. Online only.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabasePipelineRepository } from '@/lib/data/pipelines'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { SupabaseStudySessionRepository } from '@/lib/data/studySessions'
import type { CardState, LanguagePair, StudySession } from '@/domain'
import { parseSessionWords, matchSessionItems, statesForExternalRating, type SessionItem, type SessionStatus } from '@/lib/externalSession'
import { fetchGlosses, seedKnownStates, type RateDeps } from '@/lib/mediaRate'
import type { SeedBucket } from '@/lib/mediaIntake'
import { forwardStateMap } from '@/lib/cardStateMap'
import { buildEnabledTracksMap, buildRetentionMap, buildCalibrationMap } from '@/lib/sessionLimits'
import { seedOnboardLoad } from '@/engine/density'
import { getToday } from '@/lib/dates'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { langFlag, langName } from '@/lib/languages'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import { ConfirmDialog } from '@/components/ConfirmDialog'

const STATUS_LABEL: Record<SessionStatus, string> = {
  new: 'New', never: 'Never studied', learning: 'Learning', shortterm: 'Short term', longterm: 'Long term',
}
const STATUS_CLASS: Record<SessionStatus, string> = {
  new: 'text-accent', never: 'text-ink-faint', learning: 'text-warning', shortterm: 'text-ink-muted', longterm: 'text-success',
}
const BUCKETS: { bucket: SeedBucket; label: string }[] = [
  { bucket: 'fresh', label: 'Just learned' },
  { bucket: 'short', label: 'Know it' },
  { bucket: 'long',  label: 'Know it well' },
]

const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function SessionsPage() {
  const offline = useOfflineMode()
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [pairs, setPairs] = useState<LanguagePair[]>([])
  const [sessions, setSessions] = useState<StudySession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Wizard: null = list; 'form' = paste screen; 'rate' = bucket screen.
  const [view, setView] = useState<'list' | 'form' | 'rate'>('list')
  const [pairKey, setPairKey] = useState('')
  const [studiedOn, setStudiedOn] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [matching, setMatching] = useState(false)
  const [items, setItems] = useState<SessionItem[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const today = getToday(deviceTimeZone())

  useEffect(() => {
    if (offline) return
    ;(async () => {
      try {
        const { data: { session } } = await createClient().auth.getSession()
        if (!session) { router.push('/auth'); return }
        const uid = session.user.id
        setUserId(uid)
        const [pairList, sessionList] = await Promise.all([
          new SupabaseLanguagePairRepository().list(uid),
          new SupabaseStudySessionRepository().list(uid),
        ])
        setPairs(pairList)
        if (pairList[0]) setPairKey(`${pairList[0].sourceLanguage}|${pairList[0].targetLanguage}`)
        setSessions(sessionList)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [offline, router])

  function openForm() {
    setStudiedOn(today)
    setPasteText('')
    setItems([])
    setError(null)
    setView('form')
  }

  const [src, tgt] = pairKey.split('|') as [string | undefined, string | undefined]

  /** Paste → match against the library → gloss the new words → the rating screen. */
  async function matchWords() {
    if (!userId || !src || !tgt) return
    const parsed = parseSessionWords(pasteText)
    if (parsed.length === 0) { setError('No words found in the paste.'); return }
    setMatching(true)
    setError(null)
    try {
      const [cards, states] = await Promise.all([
        new SupabaseCardRepository().listAllForUser(userId),
        new SupabaseCardStateRepository().listAllForUser(userId),
      ])
      const forward = forwardStateMap(states.filter(s => s.reviewDirection !== 'reverse'))
      const matched = matchSessionItems(parsed, cards, forward, src, tgt)
      const needGloss = matched.filter(it => !it.existingId && !it.gloss)
      if (needGloss.length > 0) {
        const glossMap = await fetchGlosses(needGloss.map(it => it.word), src, tgt, false)
        for (const it of matched) {
          if (!it.existingId && !it.gloss) it.gloss = glossMap.get(it.word)?.gloss ?? null
        }
      }
      setItems(matched)
      setView('rate')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setMatching(false)
    }
  }

  const setBucket = (key: string, bucket: SeedBucket | null) =>
    setItems(prev => prev.map(it => it.key === key ? { ...it, bucket } : it))
  const setGloss = (key: string, gloss: string) =>
    setItems(prev => prev.map(it => it.key === key ? { ...it, gloss: gloss || null } : it))

  /** The pair's catch-all deck for cards born from pasted sessions — found by name or created. */
  async function ensureSessionDeck(pipelineId: string): Promise<string> {
    const deckRepo = new SupabaseDeckRepository()
    const decks = await deckRepo.list(userId!)
    const found = decks.find(d => d.name === 'External study' && d.sourceLanguage === src && d.targetLanguage === tgt)
    if (found) return found.id
    return (await deckRepo.create(userId!, { name: 'External study', sourceLanguage: src!, targetLanguage: tgt!, pipelineId })).id
  }

  async function saveSession() {
    if (!userId || !src || !tgt) return
    setSaving(true)
    setError(null)
    try {
      const cardRepo = new SupabaseCardRepository()
      const stateRepo = new SupabaseCardStateRepository()
      const [states, paramRows, pipeline] = await Promise.all([
        stateRepo.listAllForUser(userId),
        new SupabaseUserSchedulerParamsRepository().listForUser(userId).catch(() => []),
        new SupabasePipelineRepository().getDefault(),
      ])
      const forward = forwardStateMap(states.filter(s => s.reviewDirection !== 'reverse'))
      const reverse = new Map(states.filter(s => s.reviewDirection === 'reverse').map(s => [s.cardId, s]))
      const now = new Date()
      const deps: RateDeps = {
        userId, src, tgt, now,
        tracks: buildEnabledTracksMap(paramRows).get(`${src}|${tgt}`),
        retMap: buildRetentionMap(paramRows),
        calMap: buildCalibrationMap(paramRows),
        stateRepo, pipelineId: pipeline.id,
        load: await seedOnboardLoad(userId, now, 110, stateRepo),
      }

      const active = items.filter(it => it.bucket != null)
      const newReady = active.filter(it => !it.existingId && it.gloss)
      const toUpsert: CardState[] = []
      const outcomes = new Map<string, string>()

      // New words → cards in the pair's "External study" deck, born graduated per bucket.
      let deckId: string | null = null
      if (newReady.length > 0) {
        deckId = await ensureSessionDeck(pipeline.id)
        const created = await cardRepo.bulkCreate(
          deckId, userId, src, tgt,
          newReady.map((it, i) => ({ front: it.word, back: it.gloss!, position: 2000 + i })),
        )
        created.forEach((c, i) => {
          toUpsert.push(...seedKnownStates(c.id, newReady[i]!.bucket!, forward.get(c.id), reverse.get(c.id), deps))
          outcomes.set(newReady[i]!.key, 'created')
        })
      }

      // Existing cards: graduated → real review / fresh pin; otherwise the rating graduates it.
      for (const it of active.filter(x => x.existingId)) {
        const fwd = forward.get(it.existingId!)
        const rev = reverse.get(it.existingId!)
        if (fwd?.graduated && !fwd.dormant) {
          toUpsert.push(...statesForExternalRating(fwd, rev, it.bucket!, deps))
          outcomes.set(it.key, it.bucket === 'fresh' ? 'pinned' : 'reviewed')
        } else {
          toUpsert.push(...seedKnownStates(it.existingId!, it.bucket!, fwd, rev, deps))
          outcomes.set(it.key, 'graduated')
        }
      }

      if (toUpsert.length > 0) await stateRepo.upsertBatch(toUpsert)

      const finalItems = items.map(it => ({
        ...it,
        outcome: outcomes.get(it.key)
          ?? (it.bucket == null ? 'skipped' : !it.existingId && !it.gloss ? 'glossless' : 'skipped'),
      }))
      const stats = {
        newCards: newReady.length,
        updated: active.filter(it => it.existingId).length,
        skipped: finalItems.filter(it => it.outcome === 'skipped' || it.outcome === 'glossless').length,
        ...(deckId ? { deckId } : {}),
      }
      const session = await new SupabaseStudySessionRepository().create(userId, {
        sourceLanguage: src, targetLanguage: tgt, studiedOn: studiedOn || today,
        items: finalItems, stats,
      })
      setSessions(prev => [session, ...prev].sort((a, b) => b.studiedOn.localeCompare(a.studiedOn)))
      setView('list')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function deleteSession(id: string) {
    setConfirmDeleteId(null)
    try {
      await new SupabaseStudySessionRepository().softDelete(id)
      setSessions(prev => prev.filter(s => s.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (offline) return <OfflineUnavailable feature="Session log" />
  if (loading) return <div className="max-w-2xl mx-auto pt-24 text-center text-ink-muted text-sm">Loading…</div>

  // ── Rating screen ─────────────────────────────────────────────────────────
  if (view === 'rate') {
    const existing = items.filter(it => it.existingId)
    const fresh    = items.filter(it => !it.existingId)
    const activeCount = items.filter(it => it.bucket != null && (it.existingId || it.gloss)).length
    const row = (it: SessionItem) => (
      <div key={it.key} className={`px-4 py-3 space-y-2 ${it.bucket == null ? 'opacity-40' : ''}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            <span className="text-ink font-medium">{it.existingFront ?? it.word}</span>
            {it.existingId
              ? <span className="text-ink-muted"> — {it.existingBack}</span>
              : null}
            <span className={`ml-2 text-xs ${STATUS_CLASS[it.status]}`}>{STATUS_LABEL[it.status]}</span>
          </div>
          <button
            onClick={() => setBucket(it.key, it.bucket == null ? 'fresh' : null)}
            className="text-ink-faint hover:text-danger text-sm shrink-0"
            title={it.bucket == null ? 'Include this word again' : 'Skip this word'}
          >{it.bucket == null ? '↺' : '✕'}</button>
        </div>
        {!it.existingId && (
          <input
            value={it.gloss ?? ''}
            onChange={e => setGloss(it.key, e.target.value)}
            placeholder="Translation (required to create the card)"
            className="w-full bg-surface-raised/50 border border-line/10 rounded-lg px-2.5 py-1.5 text-xs text-ink"
          />
        )}
        {it.bucket != null && (
          <div className="flex gap-1.5">
            {BUCKETS.map(b => (
              <button
                key={b.bucket}
                onClick={() => setBucket(it.key, b.bucket)}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${it.bucket === b.bucket ? 'border-accent/50 bg-accent/10 text-ink' : 'border-line/10 text-ink-muted hover:text-ink'}`}
              >{b.label}</button>
            ))}
          </div>
        )}
      </div>
    )
    return (
      <div className="max-w-2xl mx-auto space-y-5 pb-16">
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => setView('form')} className="text-sm text-ink-muted hover:text-ink">← Back</button>
          <span className="text-xs text-ink-muted">{day(studiedOn || today)} · {langFlag(src ?? '')} {langName(src ?? '')}</span>
        </div>
        <p className="text-xs text-ink-faint leading-relaxed">
          <span className="text-ink-muted">Just learned</span> = first check-in in 2–4 days (an already-graduated card resets there).{' '}
          <span className="text-ink-muted">Know it</span> = 2–14 days out; on a graduated card, a real Good review.{' '}
          <span className="text-ink-muted">Know it well</span> = ~3 months out; on a graduated card, a real Easy review.{' '}
          ✕ skips the word.
        </p>
        {existing.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Already in your library — the card updates</h2>
            <div className="panel divide-y divide-line/5 p-0 overflow-hidden">{existing.map(row)}</div>
          </div>
        )}
        {fresh.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">New words — a card is created</h2>
            <div className="panel divide-y divide-line/5 p-0 overflow-hidden">{fresh.map(row)}</div>
          </div>
        )}
        {error && <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">⚠ {error}</p>}
        <div className="flex gap-3">
          <button onClick={() => void saveSession()} disabled={saving || activeCount === 0} className="btn-primary flex-1">
            {saving ? 'Saving…' : `Save session (${activeCount} word${activeCount !== 1 ? 's' : ''})`}
          </button>
          <button onClick={() => setView('list')} className="btn-ghost" disabled={saving}>Cancel</button>
        </div>
      </div>
    )
  }

  // ── Paste screen ──────────────────────────────────────────────────────────
  if (view === 'form') {
    return (
      <div className="max-w-2xl mx-auto space-y-5 pb-16">
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => setView('list')} className="text-sm text-ink-muted hover:text-ink">← Back</button>
        </div>
        <h1 className="text-xl font-semibold text-ink">Log an external study session</h1>
        <div className="panel space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs text-ink-faint">
              Language
              <select value={pairKey} onChange={e => setPairKey(e.target.value)}
                className="w-full bg-surface-raised/50 border border-line/10 rounded-lg px-2.5 py-2 text-sm text-ink">
                {pairs.map(p => (
                  <option key={`${p.sourceLanguage}|${p.targetLanguage}`} value={`${p.sourceLanguage}|${p.targetLanguage}`}>
                    {langFlag(p.sourceLanguage)} {langName(p.sourceLanguage)} → {langName(p.targetLanguage)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-ink-faint">
              Studied on
              <input type="date" value={studiedOn} max={today}
                onChange={e => setStudiedOn(e.target.value > today ? today : e.target.value)}
                className="w-full bg-surface-raised/50 border border-line/10 rounded-lg px-2.5 py-2 text-sm text-ink" />
            </label>
          </div>
          <label className="block space-y-1 text-xs text-ink-faint">
            Words — one per line, optional translation after a dash (<span className="text-ink-muted">mot — word</span>)
            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={10}
              placeholder={'s’absenter — to leave\nla berge\nle fourré — thicket'}
              className="w-full bg-surface-raised/50 border border-line/10 rounded-lg px-3 py-2 text-sm text-ink font-mono" />
          </label>
          {error && <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">⚠ {error}</p>}
          <button onClick={() => void matchWords()} disabled={matching || !pasteText.trim() || !pairKey} className="btn-primary w-full">
            {matching ? 'Matching against your library…' : 'Match words →'}
          </button>
        </div>
      </div>
    )
  }

  // ── List ──────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto space-y-5 pb-16">
      <div className="flex items-center justify-between gap-3">
        <Link href="/study" className="text-sm text-ink-muted hover:text-ink">← Study</Link>
        <button onClick={openForm} className="btn-primary text-sm" disabled={pairs.length === 0}>+ Log a session</button>
      </div>
      <h1 className="text-xl font-semibold text-ink">External study sessions</h1>
      <p className="text-sm text-ink-muted">
        Studied words outside Lexify? Paste the batch here, rate how it went, and the scheduler
        catches up — existing cards update, new words become cards.
      </p>
      {error && <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">⚠ {error}</p>}
      {sessions.length === 0 ? (
        <div className="panel text-ink-muted text-sm text-center py-10">No sessions logged yet.</div>
      ) : (
        <div className="panel divide-y divide-line/5 p-0 overflow-hidden">
          {sessions.map(s => {
            const st = s.stats as { newCards?: number; updated?: number; skipped?: number }
            return (
              <div key={s.id} className="flex items-center justify-between px-4 py-3 gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink font-medium">{day(s.studiedOn)}</div>
                  <div className="text-xs text-ink-muted truncate">
                    {langFlag(s.sourceLanguage)} {langName(s.sourceLanguage)} · {s.items.length} word{s.items.length !== 1 ? 's' : ''}
                    {st.newCards ? ` · ${st.newCards} new` : ''}
                    {st.updated ? ` · ${st.updated} updated` : ''}
                    {st.skipped ? ` · ${st.skipped} skipped` : ''}
                  </div>
                </div>
                <button onClick={() => setConfirmDeleteId(s.id)} className="text-ink-faint hover:text-danger text-sm shrink-0">✕</button>
              </div>
            )
          })}
        </div>
      )}
      {confirmDeleteId && (
        <ConfirmDialog
          message="Remove this session from the log? Cards and schedules it already changed stay as they are."
          onConfirm={() => void deleteSession(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  )
}
