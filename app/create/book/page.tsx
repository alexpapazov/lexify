'use client'

/**
 * /create/book — book-page intake (Media Intake Stage 1, 2026-11-05).
 *
 * Photograph the pages you read, tell Lexify how you mark unknown words (preset markers + an
 * optional free-text description, remembered PER BOOK), and the photos parse into cards — each
 * carrying the exact book sentence(s) it was marked in, pre-stored as cloze sentences.
 *
 * Flow: setup → parse (sliding page-pair windows, Sonnet vision, bounded concurrency, progress
 * as windows land) → review (candidates sorted by how often you marked them; lemma matches
 * against your lexicon get a per-row action: skip / attach sentences / add anyway / replace) →
 * commit (deck named after the book — found or created — plus sentence storage). Review-first:
 * nothing is written until the commit button. Images are parsed and discarded, never stored.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabasePipelineRepository } from '@/lib/data/pipelines'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { forwardStateMap } from '@/lib/cardStateMap'
import { appendStoredCloze } from '@/lib/reviewCloze'
import { windowPages, collapseOccurrences, compareWithLexicon, DEFAULT_MARKERS, type MarkerConfig, type PageOccurrence, type LexiconMatch } from '@/lib/mediaIntake'
import { mapLimit } from '@/lib/mapLimit'
import { apiUrl } from '@/lib/apiBase'
import { routes } from '@/lib/routes'
import { langFlag, langName } from '@/lib/languages'
import { displayText } from '@/lib/cardText'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import type { Card, CardState, LanguagePair } from '@/domain'

const MARKERS_KEY = 'lexify-book-markers'
const PARSE_CONCURRENCY = 2
/** Long edge for the client downscale — plenty for marked print, keeps requests small. */
const MAX_EDGE = 1568

type RowAction = 'skip' | 'attach' | 'add' | 'replace'
interface ReviewRow extends LexiconMatch {
  included: boolean          // new candidates only
  action:   RowAction        // matched candidates only
  gloss:    string           // editable back
  text:     string           // editable front
}

/** File → downscaled JPEG data URL (canvas). Photos of book pages compress very well. */
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.82)
}

function loadMarkerStore(): Record<string, MarkerConfig> {
  try { return JSON.parse(localStorage.getItem(MARKERS_KEY) ?? '{}') as Record<string, MarkerConfig> } catch { return {} }
}

export default function BookIntakePage() {
  const offline = useOfflineMode()
  const [userId, setUserId] = useState('')
  const [pairs, setPairs] = useState<LanguagePair[]>([])
  const [pairKey, setPairKey] = useState('')
  const [title, setTitle] = useState('')
  const [markers, setMarkers] = useState<MarkerConfig>(DEFAULT_MARKERS)
  const [photos, setPhotos] = useState<{ name: string; dataUrl: string }[]>([])
  const [preparing, setPreparing] = useState(false)

  const [step, setStep] = useState<'setup' | 'parsing' | 'review' | 'committing' | 'done'>('setup')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [failedWindows, setFailedWindows] = useState(0)
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<{ created: number; attached: number; replaced: number; skipped: number; deckId: string } | null>(null)

  const libraryRef = useRef<{ cards: Card[]; forward: Map<string, CardState> }>({ cards: [], forward: new Map() })

  useEffect(() => {
    if (offline) return
    void (async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      setUserId(session.user.id)
      const ps = await new SupabaseLanguagePairRepository().list(session.user.id)
      setPairs(ps)
      if (ps[0]) setPairKey(`${ps[0].sourceLanguage}|${ps[0].targetLanguage}`)
    })()
  }, [offline])

  // A known book title recalls its marker config — describe your system once per book.
  function hydrateMarkers(forTitle: string) {
    const stored = loadMarkerStore()[forTitle.trim()]
    if (stored) setMarkers({ ...DEFAULT_MARKERS, ...stored })
  }

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setPreparing(true)
    try {
      const prepared = await Promise.all([...files].map(async f => ({ name: f.name, dataUrl: await fileToDataUrl(f) })))
      setPhotos(prev => [...prev, ...prepared])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read those images.')
    } finally {
      setPreparing(false)
    }
  }

  const pair = pairs.find(p => `${p.sourceLanguage}|${p.targetLanguage}` === pairKey) ?? null
  const anyMarker = markers.circled || markers.underlined || markers.lineToMargin || markers.questionMark || markers.highlighted || markers.custom.trim() !== ''

  async function parse() {
    if (!pair || photos.length === 0 || !anyMarker) return
    setError(null)
    setStep('parsing')
    setFailedWindows(0)
    try { localStorage.setItem(MARKERS_KEY, JSON.stringify({ ...loadMarkerStore(), [title.trim()]: markers })) } catch { /* ignore */ }
    try {
      // The library loads alongside the first window — stage C needs it the moment parsing ends.
      const [cards, states] = await Promise.all([
        new SupabaseCardRepository().listAllForUser(userId),
        new SupabaseCardStateRepository().listAllForUser(userId),
      ])
      libraryRef.current = { cards, forward: forwardStateMap(states.filter(s => s.reviewDirection !== 'reverse')) }

      const windows = windowPages(photos)
      setProgress({ done: 0, total: windows.length })
      const all: PageOccurrence[] = []
      let failed = 0
      await mapLimit(windows, PARSE_CONCURRENCY, async w => {
        try {
          const res = await fetch(apiUrl('/api/media/parse-page'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              images: w.map(p => p.dataUrl), markers,
              sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage,
            }),
          })
          const data = await res.json() as { ok: boolean; occurrences?: PageOccurrence[] }
          if (!data.ok || !Array.isArray(data.occurrences)) throw new Error('window-failed')
          all.push(...data.occurrences)
        } catch {
          failed++
          setFailedWindows(failed)
        } finally {
          setProgress(p => ({ ...p, done: p.done + 1 }))
        }
        return null
      })

      const candidates = collapseOccurrences(all).sort((a, b) => b.count - a.count)
      const matches = compareWithLexicon(candidates, libraryRef.current.cards, pair.sourceLanguage, pair.targetLanguage)
      setRows(matches.map(m => {
        // Suggested actions follow the proposal: graduated → skip, mid-learning → attach the book
        // sentences, never-studied → replace with the fresh book version. Every row is editable.
        let action: RowAction = 'attach'
        if (m.existing) {
          const st = libraryRef.current.forward.get(m.existing.id)
          action = st?.graduated ? 'skip' : (st && (st.reps > 0 || st.currentStepOrder > 0)) ? 'attach' : 'replace'
        }
        return { ...m, included: true, action, gloss: m.candidate.gloss, text: m.candidate.text }
      }))
      setStep('review')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parsing failed.')
      setStep('setup')
    }
  }

  async function commit() {
    if (!pair || step !== 'review') return
    setStep('committing')
    setError(null)
    try {
      const cardRepo = new SupabaseCardRepository()
      const deckRepo = new SupabaseDeckRepository()
      const newRows = rows.filter(r => !r.existing && r.included && r.text.trim() && r.gloss.trim())
      const addRows = rows.filter(r => r.existing && r.action === 'add')
      const replaceRows = rows.filter(r => r.existing && r.action === 'replace')
      const attachRows = rows.filter(r => r.existing && r.action === 'attach')
      const skipped = rows.length - newRows.length - addRows.length - replaceRows.length - attachRows.length

      // The book's deck: reuse by exact name within the pair, else create.
      const decks = await deckRepo.list(userId)
      let deck = decks.find(d => d.name === title.trim() && d.sourceLanguage === pair.sourceLanguage && d.targetLanguage === pair.targetLanguage)
      if (!deck) {
        const pipeline = await new SupabasePipelineRepository().getDefault()
        deck = await deckRepo.create(userId, { name: title.trim() || 'Book intake', sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage, pipelineId: pipeline.id })
      }

      // Replace = soft-delete the stale card, then create fresh from the book.
      for (const r of replaceRows) await cardRepo.softDelete(r.existing!.id)

      const toCreate = [...newRows, ...replaceRows, ...addRows]
      const created = await cardRepo.bulkCreate(
        deck.id, userId, pair.sourceLanguage, pair.targetLanguage,
        toCreate.map((r, i) => ({ front: r.text.trim(), back: r.gloss.trim(), position: i })),
      )
      // Book sentences become the card's stored cloze set (translation stays empty — the cloze
      // prompt hides an empty translation line; the sentence itself is the authentic context).
      for (let i = 0; i < created.length; i++) {
        const r = toCreate[i]!
        if (r.candidate.sentences.length === 0) continue
        let choices = created[i]!.choices
        for (const s of r.candidate.sentences.slice(0, 3)) {
          choices = appendStoredCloze(choices, { sentence: s.sentence, answer: s.answer, translation: '', gloss: r.gloss.trim() })
        }
        await cardRepo.update(created[i]!.id, { choices })
      }
      // Attach = the existing card gains the book sentences, nothing else changes.
      for (const r of attachRows) {
        if (r.candidate.sentences.length === 0) continue
        let choices = r.existing!.choices
        for (const s of r.candidate.sentences.slice(0, 3)) {
          choices = appendStoredCloze(choices, { sentence: s.sentence, answer: s.answer, translation: '', gloss: r.gloss.trim() || displayText(r.existing!.back) })
        }
        await cardRepo.update(r.existing!.id, { choices })
      }

      setSummary({ created: newRows.length + replaceRows.length + addRows.length, attached: attachRows.length, replaced: replaceRows.length, skipped, deckId: deck.id })
      setStep('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Saving failed.')
      setStep('review')
    }
  }

  if (offline) return <OfflineUnavailable feature="Book intake" />

  const statusOf = (c: Card): string => {
    const st = libraryRef.current.forward.get(c.id)
    if (!st) return 'never studied'
    if (st.dormant) return 'dormant'
    if (st.graduated) return `graduated · ${st.typedIntervalDays || st.intervalDays}d interval`
    if (st.reps > 0 || st.currentStepOrder > 0) return 'learning'
    return 'never studied'
  }

  // ── Done ──
  if (step === 'done' && summary) {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-4">
        <h1 className="text-xl font-semibold text-ink">Pages imported</h1>
        <p className="text-sm text-ink-muted">
          {summary.created} card{summary.created !== 1 ? 's' : ''} created with their book sentences
          {summary.attached > 0 && `, ${summary.attached} existing card${summary.attached !== 1 ? 's' : ''} gained sentences`}
          {summary.replaced > 0 && `, ${summary.replaced} replaced`}
          {summary.skipped > 0 && `, ${summary.skipped} skipped`}.
        </p>
        <div className="flex justify-center gap-3">
          <Link href={routes.deck(summary.deckId)} className="btn-primary">Open the deck</Link>
          <button className="btn-ghost" onClick={() => { setStep('setup'); setPhotos([]); setRows([]); setSummary(null) }}>More pages</button>
        </div>
      </div>
    )
  }

  // ── Review ──
  if (step === 'review' || step === 'committing') {
    const newRows = rows.filter(r => !r.existing)
    const matchedRows = rows.filter(r => r.existing)
    return (
      <div className="space-y-6 max-w-2xl mx-auto pb-12">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{title.trim() || 'Book intake'} — review</h1>
          <p className="text-sm text-ink-muted mt-1">
            {rows.length} word{rows.length !== 1 ? 's' : ''} found{failedWindows > 0 ? ` · ${failedWindows} window${failedWindows !== 1 ? 's' : ''} failed to parse (re-run those pages later)` : ''}. Nothing is saved until you confirm.
          </p>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}

        {newRows.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-base font-medium text-ink">New words ({newRows.filter(r => r.included).length} selected)</h2>
            {newRows.map((r, idx) => (
              <div key={`n${idx}`} className="panel space-y-2">
                <div className="flex items-center gap-3">
                  <input type="checkbox" className="accent-accent w-4 h-4 shrink-0" checked={r.included}
                    onChange={e => setRows(prev => prev.map(x => x === r ? { ...x, included: e.target.checked } : x))} />
                  <input className="input py-1 w-44 font-medium" value={r.text}
                    onChange={e => setRows(prev => prev.map(x => x === r ? { ...x, text: e.target.value } : x))} />
                  <input className="input py-1 flex-1" value={r.gloss}
                    onChange={e => setRows(prev => prev.map(x => x === r ? { ...x, gloss: e.target.value } : x))} />
                  <span className="text-xs text-ink-faint shrink-0">{r.candidate.kind === 'phrase' ? 'phrase · ' : ''}{r.candidate.count > 1 ? `marked ${r.candidate.count}×` : r.candidate.markers[0] ?? ''}</span>
                </div>
                {r.candidate.sentences[0] && <p className="text-xs text-ink-muted italic pl-7">{r.candidate.sentences[0].sentence}</p>}
              </div>
            ))}
          </div>
        )}

        {matchedRows.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-base font-medium text-ink">Already in your lexicon ({matchedRows.length})</h2>
            {matchedRows.map((r, idx) => (
              <div key={`m${idx}`} className="panel space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-medium text-ink">{r.candidate.text}</span>
                  <span className="text-xs text-ink-faint">
                    matches {displayText(r.existing!.front)} — {displayText(r.existing!.back)} · {statusOf(r.existing!)}
                    {r.candidate.count > 1 ? ` · marked ${r.candidate.count}×` : ''}
                  </span>
                  <select className="input py-1 text-xs w-auto ml-auto" value={r.action}
                    onChange={e => setRows(prev => prev.map(x => x === r ? { ...x, action: e.target.value as RowAction } : x))}>
                    <option value="skip">Skip — already known</option>
                    <option value="attach">Attach book sentences to it</option>
                    <option value="add">Add anyway as its own card</option>
                    <option value="replace">Replace the old card</option>
                  </select>
                </div>
                {r.candidate.sentences[0] && <p className="text-xs text-ink-muted italic">{r.candidate.sentences[0].sentence}</p>}
              </div>
            ))}
          </div>
        )}

        {rows.length === 0 && <div className="panel text-sm text-ink-muted text-center py-8">No marked words found on these pages.</div>}

        <div className="flex gap-3">
          <button className="btn-primary px-6 disabled:opacity-50" disabled={step === 'committing' || rows.length === 0} onClick={() => void commit()}>
            {step === 'committing' ? 'Saving…' : 'Save to Lexify'}
          </button>
          <button className="btn-ghost" disabled={step === 'committing'} onClick={() => setStep('setup')}>Back</button>
        </div>
      </div>
    )
  }

  // ── Parsing ──
  if (step === 'parsing') {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-4">
        <h1 className="text-xl font-semibold text-ink">Reading your pages…</h1>
        <p className="text-sm text-ink-muted">{progress.done} of {progress.total} page windows parsed{failedWindows > 0 ? ` · ${failedWindows} failed` : ''}.</p>
        <div className="h-1.5 bg-surface-raised rounded-full overflow-hidden max-w-xs mx-auto">
          <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }} />
        </div>
      </div>
    )
  }

  // ── Setup ──
  return (
    <div className="space-y-6 max-w-2xl mx-auto pb-12">
      <div>
        <h1 className="text-2xl font-semibold text-ink">From book pages</h1>
        <p className="text-sm text-ink-muted mt-1">
          Photograph the pages you read, in order. Lexify finds the words you marked and turns them
          into cards — each with the exact sentence it came from.
        </p>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="panel space-y-3">
        <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Book</label>
        <input className="input" placeholder="Book title — becomes the deck name" value={title}
          onChange={e => setTitle(e.target.value)} onBlur={e => hydrateMarkers(e.target.value)} />
        {pairs.length > 1 && (
          <select className="input" value={pairKey} onChange={e => setPairKey(e.target.value)}>
            {pairs.map(p => (
              <option key={p.id} value={`${p.sourceLanguage}|${p.targetLanguage}`}>
                {langFlag(p.sourceLanguage)} {langName(p.sourceLanguage)} → {langName(p.targetLanguage)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="panel space-y-3">
        <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">How do you mark words?</label>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {([['circled', 'Circled'], ['underlined', 'Underlined'], ['lineToMargin', 'Line to margin'], ['questionMark', 'Question mark'], ['highlighted', 'Highlighted']] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-accent" checked={markers[k]}
                onChange={e => setMarkers(m => ({ ...m, [k]: e.target.checked }))} />
              <span className="text-ink">{label}</span>
            </label>
          ))}
        </div>
        <input className="input text-sm" placeholder="Other marks — describe them (optional)" value={markers.custom}
          onChange={e => setMarkers(m => ({ ...m, custom: e.target.value }))} />
        <p className="text-xs text-ink-faint">Remembered per book — set it once.</p>
      </div>

      <div className="panel space-y-3">
        <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Pages ({photos.length})</label>
        <input type="file" accept="image/*" multiple className="text-sm text-ink-muted"
          onChange={e => { void addFiles(e.target.files); e.target.value = '' }} />
        {photos.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <div key={i} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.dataUrl} alt={`Page ${i + 1}`} className="h-24 rounded border border-line/15" />
                <button className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-surface-deep border border-line/20 text-xs text-ink-muted hover:text-danger"
                  onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-ink-faint">Upload in reading order — consecutive pages are parsed together so sentences crossing a page break stay whole. Photos are parsed, never stored.</p>
      </div>

      <button className="btn-primary w-full disabled:opacity-50"
        disabled={preparing || photos.length === 0 || !pair || !anyMarker}
        onClick={() => void parse()}>
        {preparing ? 'Preparing photos…'
          : photos.length === 0 ? 'Add page photos'
          : !anyMarker ? 'Pick at least one marker type'
          : `Parse ${photos.length} page${photos.length !== 1 ? 's' : ''}`}
      </button>
    </div>
  )
}
