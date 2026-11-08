'use client'

/**
 * /media — the media LOG (Extraction Engine Stage A, 2026-11-08: server-side processing).
 *
 * A log of what you read, one book at a time. Submitting pages now UPLOADS them (private
 * storage bucket) and returns immediately — the `media-worker` Edge Function parses in the
 * background (numbering pass when sentences are on, then window extraction) and deletes every
 * image on completion. The entry row shows per-page progress while you use the rest of
 * Lexify; when it finishes, "Review & save" opens the review fed from the STORED results.
 * The Media tab's poll both refreshes progress and re-kicks a chain that died mid-flight.
 *
 * Review-first still holds: no card is written until the review's save. Prompt options
 * (circled/underlined, sentences, noun article) are structured only — no free text —
 * snapshotted onto the entry and remembered on the book.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabasePipelineRepository } from '@/lib/data/pipelines'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseMediaEntryRepository } from '@/lib/data/mediaEntries'
import { SupabaseMediaBookRepository } from '@/lib/data/mediaBooks'
import { SupabaseMediaPageRepository } from '@/lib/data/mediaPages'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { forwardStateMap } from '@/lib/cardStateMap'
import { appendStoredCloze } from '@/lib/reviewCloze'
import { collapseOccurrences, compareWithLexicon, unmarkedLemmas, splitUnmarkedLemmas, parseOccurrences, parseAllLemmas, parseGlosses, CHIP_WINDOWS, CHIP_SEED_RATING, DEFAULT_OPTIONS, ARTICLE_LANGS, type IntakeOptions, type PageOccurrence, type LexiconMatch, type IntakeCandidate, type ChipBucket } from '@/lib/mediaIntake'
import { creditCardSighting } from '@/lib/implicitCredit'
import { buildEnabledTracksMap, buildRetentionMap, buildCalibrationMap, retentionFor, activeProductionTrack, type EnabledTracks } from '@/lib/sessionLimits'
import { claimSpreadDay, onboardDueIso, seedOnboardLoad } from '@/engine/density'
import { initialDifficulty, stabilityForInterval } from '@/engine/fsrs'
import { initialCardState } from '@/engine/pipeline'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { mapLimit, chunk } from '@/lib/mapLimit'
import { apiUrl } from '@/lib/apiBase'
import { routes } from '@/lib/routes'
import { langFlag, langName } from '@/lib/languages'
import { displayText } from '@/lib/cardText'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import type { Card, CardState, LanguagePair, MediaBook, MediaEntry, MediaPage } from '@/domain'

const UPLOAD_CONCURRENCY = 3
/** How many worker chains to start per submission (each claims one unit at a time). */
const WORKER_KICKS = 3
/** Long edge for the client downscale — plenty for marked print, keeps requests small. */
const MAX_EDGE = 1568

type RowAction = 'skip' | 'attach' | 'link' | 'add' | 'replace'
interface ReviewRow extends LexiconMatch {
  included: boolean          // new candidates only
  action:   RowAction        // matched candidates only
  gloss:    string           // editable back
  text:     string           // editable front
}

/** One unmarked word on the chip board: paint it into a bucket or leave it ignored. */
interface Chip {
  lemma:    string
  /** Existing NON-graduated card with this lemma — painting short/long graduates IT, no new card. */
  existing: Card | null
  bucket:   ChipBucket | null
}

const BUCKETS: { key: ChipBucket; label: string; hint: string; chipClass: string; dotClass: string }[] = [
  { key: 'short',    label: 'Short term',     hint: 'known — verify over ~2 weeks',   chipClass: 'border-sky-400/70 bg-sky-400/10 text-ink',     dotClass: 'bg-sky-400' },
  { key: 'long',     label: 'Long term',      hint: 'known — first check in ~3 months', chipClass: 'border-emerald-400/70 bg-emerald-400/10 text-ink', dotClass: 'bg-emerald-400' },
  { key: 'dontknow', label: "I don't know it", hint: 'forgot to mark — learn it',      chipClass: 'border-amber-400/70 bg-amber-400/10 text-ink', dotClass: 'bg-amber-400' },
]

/** File → downscaled JPEG data URL (canvas). Photos of book pages compress very well.
 *  Decode is two-tier: createImageBitmap first, then an <img> element (some browsers decode
 *  formats one way but not the other). A file neither can read throws with ITS NAME, so one
 *  bad photo never takes down the batch — the usual culprit is an iPhone HEIC in Chrome. */
async function fileToDataUrl(file: File): Promise<string> {
  const draw = (src: CanvasImageSource, width: number, height: number): string => {
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
    const w = Math.round(width * scale), h = Math.round(height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d')!.drawImage(src, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', 0.82)
  }
  try {
    const bitmap = await createImageBitmap(file)
    try { return draw(bitmap, bitmap.width, bitmap.height) } finally { bitmap.close() }
  } catch { /* fall through to the <img> decoder */ }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return draw(img, img.naturalWidth, img.naturalHeight)
  } catch {
    throw new Error(`“${file.name}” could not be read — if it's an iPhone HEIC photo, export or share it as JPEG first.`)
  } finally {
    URL.revokeObjectURL(url)
  }
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
/** A plain YYYY-MM-DD formatted WITHOUT timezone shifting (new Date('YYYY-MM-DD') is UTC midnight,
 *  which renders as the previous day west of Greenwich). */
const fmtDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
/** When this entry's reading happened: the chosen read_on day, else the log timestamp. */
const entryDate = (e: MediaEntry) => e.readOn ? fmtDay(e.readOn) : fmtDate(e.createdAt)
const localToday = () => new Date().toLocaleDateString('en-CA')

export default function MediaPage() {
  const offline = useOfflineMode()
  const [userId, setUserId] = useState('')
  const [pairs, setPairs] = useState<LanguagePair[]>([])
  const [entries, setEntries] = useState<MediaEntry[]>([])
  const [books, setBooks] = useState<MediaBook[]>([])
  const [loading, setLoading] = useState(true)

  const [view, setView] = useState<'books' | 'book' | 'detail' | 'wizard'>('books')
  const [activeBook, setActiveBook] = useState<MediaBook | null>(null)
  const [changingLang, setChangingLang] = useState(false)
  const [movePairKey, setMovePairKey] = useState('')
  const [moving, setMoving] = useState(false)
  /** Set when the parsed pages' detected language disagrees with the book's pair. */
  const [langWarning, setLangWarning] = useState<string | null>(null)
  const [detail, setDetail] = useState<MediaEntry | null>(null)
  /** The book this wizard run logs to — preset when launched from a book, created at parse otherwise. */
  const [wizardBook, setWizardBook] = useState<MediaBook | null>(null)

  // ── Wizard state (the former /create/book page) ──
  const [pairKey, setPairKey] = useState('')
  const [title, setTitle] = useState('')
  const [readOn, setReadOn] = useState(localToday())
  const [markers, setMarkers] = useState<{ circled: boolean; underlined: boolean }>({ circled: true, underlined: true })
  const [sentences, setSentences] = useState(true)
  const [nounArticle, setNounArticle] = useState(false)
  const [photos, setPhotos] = useState<{ name: string; dataUrl: string }[]>([])
  const [preparing, setPreparing] = useState(false)
  const [step, setStep] = useState<'setup' | 'uploading' | 'loading' | 'review' | 'committing' | 'done'>('setup')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [failedWindows, setFailedWindows] = useState(0)
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<{ created: number; attached: number; replaced: number; skipped: number; deckId: string | null; knownAdded: number; graduatedExisting: number; dontKnowAdded: number; credited: number; chipSkipped: number } | null>(null)
  const [unmarkedSummary, setUnmarkedSummary] = useState<{ total: number; known: number; unknown: number } | null>(null)
  const [chips, setChips] = useState<Chip[]>([])
  const [activeBucket, setActiveBucket] = useState<ChipBucket | null>(null)

  const libraryRef = useRef<{ cards: Card[]; forward: Map<string, CardState>; reverse: Map<string, CardState> }>({ cards: [], forward: new Map(), reverse: new Map() })
  /** Unmarked lemmas whose card is already GRADUATED — the implicit-credit targets on save. */
  const knownGradRef = useRef<{ lemma: string; card: Card }[]>([])
  /** Scheduler config loaded at parse time: track flags + per-track retention/calibration. */
  const paramsRef = useRef<{ tracksByPair: Map<string, EnabledTracks>; retMap: Map<string, number>; calMap: Map<string, number> }>({ tracksByPair: new Map(), retMap: new Map(), calMap: new Map() })
  const profileRef = useRef<{ tz: string; turnoverHour: number }>({ tz: 'UTC', turnoverHour: 0 })
  /** The log row for the wizard run in progress / under review. */
  const entryRef = useRef<MediaEntry | null>(null)
  /** Per-entry processing progress for the rows (polled while anything is processing). */
  const [progressMap, setProgressMap] = useState<Map<string, { done: number; failed: number; total: number }>>(new Map())

  useEffect(() => {
    if (offline) return
    void (async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) { setLoading(false); return }
      setUserId(session.user.id)
      const [ps, es, bs] = await Promise.all([
        new SupabaseLanguagePairRepository().list(session.user.id),
        new SupabaseMediaEntryRepository().list(session.user.id).catch(() => [] as MediaEntry[]),
        new SupabaseMediaBookRepository().list(session.user.id).catch(() => [] as MediaBook[]),
      ])
      setPairs(ps)
      setEntries(es)
      setBooks(bs)
      if (ps[0]) setPairKey(`${ps[0].sourceLanguage}|${ps[0].targetLanguage}`)
      setLoading(false)
    })()
  }, [offline])

  // While any entry is processing: poll progress, refresh entry rows, and re-kick the worker
  // (idempotent — an invocation that finds nothing claimable just returns, so this doubles as
  // the revival path for a chain that died mid-flight).
  const processingKey = entries.filter(e => e.status !== 'done').map(e => `${e.id}:${e.status}`).join(',')
  useEffect(() => {
    if (offline || !userId || processingKey === '') return
    const supabase = createClient()
    let cancelled = false
    const tick = async () => {
      const ids = entries.filter(e => e.status !== 'done').map(e => e.id)
      if (ids.length === 0) return
      const prog = await new SupabaseMediaPageRepository().progressForEntries(ids).catch(() => new Map<string, { done: number; failed: number; total: number }>())
      if (cancelled) return
      setProgressMap(prog)
      for (const id of ids) void supabase.functions.invoke('media-worker', { body: { entry_id: id } }).catch(() => {})
      const es = await new SupabaseMediaEntryRepository().list(userId).catch(() => null)
      if (es && !cancelled) setEntries(es)
    }
    void tick()
    const h = setInterval(() => { void tick() }, 6000)
    return () => { cancelled = true; clearInterval(h) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processingKey, offline, userId])

  /** Applies a stored options object (a book's `markers` or an old entry's) to the form. */
  function applyOptions(raw: unknown, srcLang: string) {
    const o = (raw ?? {}) as Partial<IntakeOptions>
    setMarkers({ circled: o.circled ?? true, underlined: o.underlined ?? true })
    setSentences(o.sentences ?? true)
    setNounArticle(o.nounArticle ?? ARTICLE_LANGS.has(srcLang))
  }

  /** A known book title (new-book mode) recalls its options from its latest entry. */
  function hydrateMarkers(forTitle: string) {
    const t = forTitle.trim().toLowerCase()
    if (!t || !pair) return
    const prior = entries.find(e => e.title.trim().toLowerCase() === t && e.markers != null)
    if (prior) applyOptions(prior.markers, pair.sourceLanguage)
  }

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setPreparing(true)
    setError(null)
    // Per-file: one unreadable photo reports its name and the rest still load.
    const results = await Promise.allSettled([...files].map(async f => ({ name: f.name, dataUrl: await fileToDataUrl(f) })))
    const prepared = results.filter((r): r is PromiseFulfilledResult<{ name: string; dataUrl: string }> => r.status === 'fulfilled').map(r => r.value)
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (prepared.length > 0) setPhotos(prev => [...prev, ...prepared])
    if (failures.length > 0) {
      setError(failures.map(f => f.reason instanceof Error ? f.reason.message : 'An image could not be read.').join(' '))
    }
    setPreparing(false)
  }

  const pair = pairs.find(p => `${p.sourceLanguage}|${p.targetLanguage}` === pairKey) ?? null
  const anyMarker = markers.circled || markers.underlined
  const articleLang = pair ? ARTICLE_LANGS.has(pair.sourceLanguage) : false
  const currentOptions = (): IntakeOptions => ({
    circled: markers.circled, underlined: markers.underlined,
    sentences, nounArticle: articleLang ? nounArticle : false,
  })

  /** Opens the wizard — logging to an existing book (fields prefilled + locked) or creating one. */
  function startWizard(book: MediaBook | null) {
    setWizardBook(book)
    setTitle(book?.title ?? '')
    if (book) setPairKey(`${book.sourceLanguage}|${book.targetLanguage}`)
    applyOptions(book?.markers ?? DEFAULT_OPTIONS, book?.sourceLanguage ?? pair?.sourceLanguage ?? '')
    setReadOn(localToday()); setPhotos([]); setRows([]); setSummary(null); setUnmarkedSummary(null); setError(null)
    setChips([]); setActiveBucket(null)
    knownGradRef.current = []
    entryRef.current = null
    setStep('setup')
    setView('wizard')
  }

  /** Library + scheduler config + profile into the refs the review and commit need. */
  async function loadContext() {
    const supabase = createClient()
    const [cards, states, paramRows, profile] = await Promise.all([
      new SupabaseCardRepository().listAllForUser(userId),
      new SupabaseCardStateRepository().listAllForUser(userId),
      new SupabaseUserSchedulerParamsRepository().listForUser(userId).catch(() => []),
      supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', userId).single()
        .then(r => r.data as { timezone: string | null; day_turnover_hour: number | null } | null, () => null),
    ])
    const reverse = new Map(states.filter(s => s.reviewDirection === 'reverse').map(s => [s.cardId, s]))
    libraryRef.current = { cards, forward: forwardStateMap(states.filter(s => s.reviewDirection !== 'reverse')), reverse }
    paramsRef.current = {
      tracksByPair: buildEnabledTracksMap(paramRows),
      retMap:       buildRetentionMap(paramRows),
      calMap:       buildCalibrationMap(paramRows),
    }
    profileRef.current = { tz: profile?.timezone ?? deviceTimeZone(), turnoverHour: profile?.day_turnover_hour ?? 0 }
  }

  /** Turns stored page results into the review screen's rows/chips (needs loadContext first). */
  function buildReview(all: PageOccurrence[], windowLemmas: string[][], detectedLangs: string[], src: string, tgt: string) {
    // Language guard: majority detected language vs the book's pair — warn before anything saves.
    const langTally = new Map<string, number>()
    for (const l of detectedLangs) langTally.set(l, (langTally.get(l) ?? 0) + 1)
    const detected = [...langTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    setLangWarning(detected && detected !== src.toLowerCase() ? detected : null)

    const candidates = collapseOccurrences(all).sort((a, b) => b.count - a.count)
    const unmarked = unmarkedLemmas(windowLemmas, candidates)
    const split = splitUnmarkedLemmas(unmarked, libraryRef.current.cards, src, tgt)
    setUnmarkedSummary({ total: unmarked.length, known: split.known.length, unknown: split.unknown.length })

    // Graduated matches earn implicit credit on save; everything else goes on the chip board —
    // existing-but-unstudied cards (painting graduates THEM) and brand-new words.
    const knownGrad: { lemma: string; card: Card }[] = []
    const chipRows: Chip[] = []
    for (const k of split.known) {
      if (libraryRef.current.forward.get(k.card.id)?.graduated) knownGrad.push(k)
      else chipRows.push({ lemma: k.lemma, existing: k.card, bucket: null })
    }
    for (const l of split.unknown) chipRows.push({ lemma: l, existing: null, bucket: null })
    knownGradRef.current = knownGrad
    setChips(chipRows)
    setActiveBucket(null)

    const matches = compareWithLexicon(candidates, libraryRef.current.cards, src, tgt)
    setRows(matches.map(m => {
      let action: RowAction = 'attach'
      if (m.existing) {
        const st = libraryRef.current.forward.get(m.existing.id)
        action = st?.graduated ? 'skip' : (st && (st.reps > 0 || st.currentStepOrder > 0)) ? 'attach' : 'replace'
      }
      // The card front defaults to the DISPLAY form (noun with article, infinitive, masc. sg.).
      return { ...m, included: true, action, gloss: m.candidate.gloss, text: m.candidate.display ?? m.candidate.text }
    }))
    return { candidates, unmarked, split }
  }

  /**
   * Submits the pages: creates the entry, uploads the photos to the private bucket, inserts
   * the page rows, flips the entry to 'processing', and kicks the Edge Function worker —
   * then returns to the book page. Parsing continues server-side even if the app closes.
   */
  async function submitPages() {
    if (!pair || photos.length === 0 || !anyMarker) return
    setError(null)
    setStep('uploading')
    setProgress({ done: 0, total: photos.length })
    try {
      const supabase = createClient()
      const options = currentOptions()

      // The book: preset keeps this run's options; a fresh title becomes a new book.
      let book = wizardBook
      if (book) {
        void new SupabaseMediaBookRepository().update(book.id, { markers: options })
          .then(b => setBooks(prev => prev.map(x => x.id === b.id ? b : x))).catch(() => {})
      } else {
        book = await new SupabaseMediaBookRepository().create(userId, {
          title: title.trim() || 'Untitled book',
          sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage, markers: options,
        })
        setBooks(prev => [book!, ...prev])
        setWizardBook(book)
      }

      // The entry first — its id names the storage folder.
      const entry = await new SupabaseMediaEntryRepository().create(userId, {
        bookId: book?.id ?? null,
        title: book?.title ?? (title.trim() || 'Untitled book'),
        sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage,
        pages: photos.length,
        readOn: readOn && readOn <= localToday() ? readOn : localToday(),
        markers: options, candidates: [], stats: {},
        status: 'uploading', options: options as unknown as Record<string, unknown>,
      })
      entryRef.current = entry

      const uploaded: { pageIndex: number; storagePath: string }[] = []
      let failedUploads = 0
      await mapLimit(photos.map((photo, i) => ({ photo, i })), UPLOAD_CONCURRENCY, async ({ photo, i }) => {
        try {
          const blob = await (await fetch(photo.dataUrl)).blob()
          const path = `${userId}/${entry.id}/${i}.jpg`
          const { error: upErr } = await supabase.storage.from('media-pages').upload(path, blob, { contentType: 'image/jpeg', upsert: true })
          if (upErr) throw upErr
          uploaded.push({ pageIndex: i, storagePath: path })
        } catch {
          failedUploads++
        } finally {
          setProgress(pr => ({ ...pr, done: pr.done + 1 }))
        }
        return null
      })
      if (uploaded.length === 0) throw new Error('No photos could be uploaded — check your connection and try again.')

      await new SupabaseMediaPageRepository().createBatch(userId, entry.id, uploaded.sort((a, b) => a.pageIndex - b.pageIndex))
      const live = await new SupabaseMediaEntryRepository().update(entry.id, {
        status: 'processing', pages: uploaded.length,
        ...(failedUploads > 0 ? { stats: { uploadFailed: failedUploads } } : {}),
      })
      setEntries(prev => [live, ...prev])

      // Kick a few worker chains; the Media tab's poll revives them if one dies.
      for (let k = 0; k < Math.min(WORKER_KICKS, uploaded.length); k++) {
        void supabase.functions.invoke('media-worker', { body: { entry_id: entry.id } }).catch(() => {})
      }

      backToLog(book)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.')
      setStep('setup')
    }
  }

  /** Opens the review for a PROCESSED entry, fed from the stored per-page results. */
  async function openReview(entry: MediaEntry) {
    setError(null)
    const book = books.find(b => b.id === entry.bookId) ?? null
    setWizardBook(book)
    setTitle(entry.title)
    setPairKey(`${entry.sourceLanguage}|${entry.targetLanguage}`)
    setReadOn(entry.readOn ?? localToday())
    setSummary(null)
    entryRef.current = entry
    setView('wizard')
    setStep('loading')
    try {
      const [pages] = await Promise.all([
        new SupabaseMediaPageRepository().listForEntry(entry.id),
        loadContext(),
      ])
      const all: PageOccurrence[] = []
      const windowLemmas: string[][] = []
      const detectedLangs: string[] = []
      let failed = 0
      for (const pg of pages) {
        if (pg.status === 'failed') { failed++; continue }
        if (!pg.result) continue
        all.push(...parseOccurrences(pg.result))
        const lemmas = parseAllLemmas(pg.result)
        if (lemmas.length > 0) windowLemmas.push(lemmas)
        const pl = (pg.result as { pageLanguage?: unknown }).pageLanguage
        if (typeof pl === 'string' && pl) detectedLangs.push(pl.toLowerCase())
      }
      setFailedWindows(failed)
      const { candidates, unmarked, split } = buildReview(all, windowLemmas, detectedLangs, entry.sourceLanguage, entry.targetLanguage)
      // Persist the extraction onto the entry so its detail view works without the pages.
      void new SupabaseMediaEntryRepository().update(entry.id, {
        candidates, unmarkedLemmas: unmarked,
        stats: { ...entry.stats, found: candidates.length, unmarked: unmarked.length, unmarkedKnown: split.known.length, unmarkedUnknown: split.unknown.length },
      }).then(u => { entryRef.current = u; setEntries(prev => prev.map(e => e.id === u.id ? u : e)) }).catch(() => {})
      setStep('review')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the results.')
      backToLog(book)
    }
  }

  async function commit() {
    if (!pair || step !== 'review') return
    setStep('committing')
    setError(null)
    try {
      const cardRepo = new SupabaseCardRepository()
      const deckRepo = new SupabaseDeckRepository()
      const stateRepo = new SupabaseCardStateRepository()
      const { tracksByPair, retMap, calMap } = paramsRef.current
      const pairTracks = tracksByPair.get(`${pair.sourceLanguage}|${pair.targetLanguage}`)
      const now = new Date()
      const nowIso = now.toISOString()

      const newRows = rows.filter(r => !r.existing && r.included && r.text.trim() && r.gloss.trim())
      const addRows = rows.filter(r => r.existing && r.action === 'add')
      const replaceRows = rows.filter(r => r.existing && r.action === 'replace')
      const attachRows = rows.filter(r => r.existing && r.action === 'attach')
      const linkRows = rows.filter(r => r.existing && r.action === 'link')
      const skipped = rows.length - newRows.length - addRows.length - replaceRows.length - attachRows.length - linkRows.length

      // ── Chips: paint → cards. New chips need a gloss first (the parse never extracted one —
      // the reader KNOWS these words); chips the gloss call misses are skipped, never created
      // with an empty back.
      const painted = chips.filter(c => c.bucket !== null)
      const dontKnowNew   = painted.filter(c => c.bucket === 'dontknow' && !c.existing)
      const knownNew      = painted.filter(c => c.bucket !== 'dontknow' && !c.existing)
      const knownExisting = painted.filter(c => c.bucket !== 'dontknow' && c.existing)

      const glossChips = [...dontKnowNew, ...knownNew]
      const glossByLemma = new Map<string, string>()
      if (glossChips.length > 0) {
        const batches = chunk(glossChips.map(c => c.lemma), 100)
        await mapLimit(batches, 2, async lemmas => {
          try {
            const res = await fetch(apiUrl('/api/media/gloss'), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ lemmas, sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage }),
            })
            const data = await res.json() as { ok: boolean; glosses?: { index: number; gloss: string }[] }
            if (data.ok && Array.isArray(data.glosses)) {
              for (const g of data.glosses) {
                const lemma = lemmas[g.index]
                if (lemma && typeof g.gloss === 'string' && g.gloss.trim()) glossByLemma.set(lemma, g.gloss.trim())
              }
            }
          } catch { /* chips without a gloss are skipped below */ }
          return null
        })
      }
      const glossedDontKnow = dontKnowNew.filter(c => glossByLemma.has(c.lemma))
      const glossedKnownNew = knownNew.filter(c => glossByLemma.has(c.lemma))
      const chipSkipped = glossChips.length - glossedDontKnow.length - glossedKnownNew.length

      // ── The book's deck — found or created, and only when something will live in it.
      const defaultPipeline = await new SupabasePipelineRepository().getDefault()
      const needsDeck = newRows.length + addRows.length + replaceRows.length + linkRows.length
        + glossedDontKnow.length + glossedKnownNew.length > 0
      let deck = null as Awaited<ReturnType<typeof deckRepo.list>>[number] | null
      if (needsDeck) {
        const decks = await deckRepo.list(userId)
        deck = decks.find(d => d.name === title.trim() && d.sourceLanguage === pair.sourceLanguage && d.targetLanguage === pair.targetLanguage) ?? null
        if (!deck) {
          deck = await deckRepo.create(userId, { name: title.trim() || 'Book intake', sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage, pipelineId: defaultPipeline.id })
        }
      }

      // ── Marked words (unchanged flow, plus Link).
      // Replace = soft-delete the stale card, then create fresh from the book.
      for (const r of replaceRows) await cardRepo.softDelete(r.existing!.id)

      const toCreate = [...newRows, ...replaceRows, ...addRows]
      const created = toCreate.length > 0 ? await cardRepo.bulkCreate(
        deck!.id, userId, pair.sourceLanguage, pair.targetLanguage,
        toCreate.map((r, i) => ({ front: r.text.trim(), back: r.gloss.trim(), position: i })),
      ) : []
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
      // Link = the SAME card joins the book's deck (shared card, not a duplicate); it also gains
      // the book sentences, like Attach.
      for (let i = 0; i < linkRows.length; i++) {
        await cardRepo.addToDeck(deck!.id, linkRows[i]!.existing!.id, 100000 + i)
      }
      // Attach/Link = the existing card gains the book sentences, nothing else changes.
      for (const r of [...attachRows, ...linkRows]) {
        if (r.candidate.sentences.length === 0) continue
        let choices = r.existing!.choices
        for (const s of r.candidate.sentences.slice(0, 3)) {
          choices = appendStoredCloze(choices, { sentence: s.sentence, answer: s.answer, translation: '', gloss: r.gloss.trim() || displayText(r.existing!.back) })
        }
        await cardRepo.update(r.existing!.id, { choices })
      }

      // ── Chip cards: don't-know = plain unlearned (the ladder picks them up); short/long = new
      // cards born graduated.
      let knownCreated: Card[] = []
      if (glossedDontKnow.length + glossedKnownNew.length > 0) {
        const chipInputs = [...glossedDontKnow, ...glossedKnownNew]
        const createdChips = await cardRepo.bulkCreate(
          deck!.id, userId, pair.sourceLanguage, pair.targetLanguage,
          chipInputs.map((c, i) => ({ front: c.lemma, back: glossByLemma.get(c.lemma)!, position: 1000 + i })),
        )
        knownCreated = createdChips.slice(glossedDontKnow.length)
      }

      // ── Auto-graduation: new known cards AND existing never-studied/mid-pipeline cards painted
      // short/long graduate NOW with the bucket's seeding (mirrors onboarding's buildStates:
      // spread due days, band-style difficulty, stability from the landed day, bulk_known so
      // daily goals never count a self-assessment).
      const toGraduate: { cardId: string; bucket: 'short' | 'long'; fwd?: CardState; rev?: CardState }[] = [
        ...knownCreated.map((c, i) => ({ cardId: c.id, bucket: glossedKnownNew[i]!.bucket as 'short' | 'long' })),
        ...knownExisting.map(c => ({
          cardId: c.existing!.id, bucket: c.bucket as 'short' | 'long',
          fwd: libraryRef.current.forward.get(c.existing!.id), rev: libraryRef.current.reverse.get(c.existing!.id),
        })),
      ]
      if (toGraduate.length > 0) {
        const load = await seedOnboardLoad(userId, now, 110, stateRepo)
        const prodTrack = activeProductionTrack(pairTracks) ?? 'typed'
        const states: CardState[] = []
        for (const g of toGraduate) {
          const window = CHIP_WINDOWS[g.bucket]
          const make = (direction: 'forward' | 'reverse'): CardState => {
            const offset = claimSpreadDay(load, window)
            const dueAt  = onboardDueIso(now, offset)
            const field  = direction === 'forward' ? (prodTrack === 'smart' ? 'forward_smart' : 'forward_typed') : 'reverse_recall'
            const base   = (direction === 'forward' ? g.fwd : g.rev)
              ?? { ...initialCardState(userId, g.cardId, g.fwd?.pipelineId ?? defaultPipeline.id), reviewDirection: direction }
            return {
              ...base,
              reviewDirection: direction,
              graduated: true, graduatedAt: nowIso,
              relearning: false, relearningStep: 0, goodStreak: 0, againStreak: 0,
              difficulty: initialDifficulty([CHIP_SEED_RATING[g.bucket]]),
              stability:  stabilityForInterval(offset, retentionFor(retMap, pair.sourceLanguage, pair.targetLanguage, field)),
              intervalDays: offset, scheduledIntervalDays: offset, dueAt,
              ...(direction === 'forward'
                ? (prodTrack === 'smart'
                    ? { smartIntervalDays: offset, smartDueAt: dueAt }
                    : { typedIntervalDays: offset, typedDueAt: dueAt })
                : { recallIntervalDays: offset, recallDueAt: dueAt }),
              acceleratedMode: 'bulk_known' as const,
            }
          }
          states.push(make('forward'), make('reverse'))
        }
        await stateRepo.upsertBatch(states)
      }

      // ── Implicit credit: every unmarked word whose card is already graduated is a verified
      // sighting — you read it and didn't need to mark it. Eligibility (long-term phase, not
      // overdue, daily cap, enabled tracks) is checked per row inside creditCardSighting.
      let credited = 0
      if (knownGradRef.current.length > 0) {
        const ctx = {
          userId, now, tz: profileRef.current.tz, turnoverHour: profileRef.current.turnoverHour,
          retMap, calMap, tracks: pairTracks, stateRepo,
        }
        await mapLimit(knownGradRef.current, 4, async k => {
          try {
            const out = await creditCardSighting({
              card: k.card,
              forward: libraryRef.current.forward.get(k.card.id) ?? null,
              reverse: libraryRef.current.reverse.get(k.card.id) ?? null,
            }, ctx)
            if (out) credited++
          } catch { /* best-effort per card — a failed credit just stays uncredited */ }
          return null
        })
      }

      // The book remembers its deck after the first commit creates/finds it.
      if (deck && wizardBook && wizardBook.deckId !== deck.id) {
        void new SupabaseMediaBookRepository().update(wizardBook.id, { deckId: deck.id })
          .then(b => { setWizardBook(b); setBooks(prev => prev.map(x => x.id === b.id ? b : x)) })
          .catch(() => {})
      }

      const stats = {
        ...(entryRef.current?.stats ?? {}),
        created: toCreate.length,
        attached: attachRows.length, replaced: replaceRows.length, skipped, linked: linkRows.length,
        knownAdded: glossedKnownNew.length, graduatedExisting: knownExisting.length,
        dontKnowAdded: glossedDontKnow.length, credited, chipSkipped,
        ...(deck ? { deckId: deck.id } : {}),
      }
      if (entryRef.current) {
        try {
          const updated = await new SupabaseMediaEntryRepository().update(entryRef.current.id, { stats })
          setEntries(prev => prev.map(e => e.id === updated.id ? updated : e))
        } catch { /* best-effort */ }
      }

      setSummary({
        created: toCreate.length, attached: attachRows.length, replaced: replaceRows.length, skipped,
        deckId: deck?.id ?? null,
        knownAdded: glossedKnownNew.length, graduatedExisting: knownExisting.length,
        dontKnowAdded: glossedDontKnow.length, credited, chipSkipped,
      })
      setStep('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Saving failed.')
      setStep('review')
    }
  }

  /** Leave the wizard/detail: back to the owning book's page when there is one, else the shelf. */
  function backToLog(book: MediaBook | null) {
    if (book) { setActiveBook(book); setView('book') } else { setActiveBook(null); setView('books') }
    setDetail(null)
  }

  /** Moves a book — its entries, deck, and every card in the deck — to a different language
   *  pair (fixing a book created under the wrong language). Language-derived card caches
   *  (labels, distractors, IPA, audio) clear and regenerate; schedules are untouched. */
  async function moveBookPair(book: MediaBook, src: string, tgt: string) {
    setMoving(true)
    setError(null)
    try {
      if (book.deckId) {
        const cardRepo = new SupabaseCardRepository()
        const cards = await cardRepo.listByDeck(book.deckId)
        await cardRepo.moveToPair(cards.map(c => c.id), src, tgt)
        await new SupabaseDeckRepository().update(book.deckId, { sourceLanguage: src, targetLanguage: tgt })
      }
      await new SupabaseMediaEntryRepository().updatePairForBook(book.id, src, tgt)
      const updated = await new SupabaseMediaBookRepository().update(book.id, { sourceLanguage: src, targetLanguage: tgt })
      setBooks(prev => prev.map(b => b.id === updated.id ? updated : b))
      setEntries(prev => prev.map(e => e.bookId === book.id ? { ...e, sourceLanguage: src, targetLanguage: tgt } : e))
      setActiveBook(updated)
      setChangingLang(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the language.')
    } finally {
      setMoving(false)
    }
  }

  async function deleteEntry(entry: MediaEntry) {
    if (!window.confirm(`Delete the ${entryDate(entry)} entry for “${entry.title}”? The cards it created stay in your library.`)) return
    try {
      await new SupabaseMediaEntryRepository().softDelete(entry.id)
      setEntries(prev => prev.filter(e => e.id !== entry.id))
      backToLog(activeBook)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed.')
    }
  }

  if (offline) return <OfflineUnavailable feature="Media log" />

  const statusOf = (c: Card): string => {
    const st = libraryRef.current.forward.get(c.id)
    if (!st) return 'never studied'
    if (st.dormant) return 'dormant'
    if (st.graduated) return `graduated · ${st.typedIntervalDays || st.intervalDays}d interval`
    if (st.reps > 0 || st.currentStepOrder > 0) return 'learning'
    return 'never studied'
  }

  // ═══ Entry detail ═══
  if (view === 'detail' && detail) {
    const cands = detail.candidates as IntakeCandidate[]
    const st = detail.stats as Record<string, number | string | undefined>
    const detailProg = progressMap.get(detail.id)
    const readyToReview = detail.status === 'done' && st.engine === 'v2' && st.created == null
    return (
      <div className="space-y-6 max-w-2xl mx-auto pb-12">
        <div className="flex items-start justify-between gap-3">
          <div>
            <button className="text-sm text-ink-muted hover:text-ink" onClick={() => backToLog(activeBook)}>← {activeBook ? activeBook.title : 'Media log'}</button>
            <h1 className="text-2xl font-semibold text-ink mt-1">{langFlag(detail.sourceLanguage)} {detail.title}</h1>
            <p className="text-sm text-ink-muted mt-1">
              {entryDate(detail)} · {detail.pages} page{detail.pages !== 1 ? 's' : ''} · {cands.length} word{cands.length !== 1 ? 's' : ''} marked
              {typeof st.created === 'number' && st.created > 0 ? ` · ${st.created} card${st.created !== 1 ? 's' : ''} created` : ''}
              {typeof st.attached === 'number' && st.attached > 0 ? ` · ${st.attached} gained sentences` : ''}
              {typeof st.failedWindows === 'number' && st.failedWindows > 0 ? ` · ${st.failedWindows} window${st.failedWindows !== 1 ? 's' : ''} failed` : ''}
            </p>
            {detail.unmarkedLemmas.length > 0 && (
              <p className="text-xs text-ink-faint mt-1">
                {detail.unmarkedLemmas.length} unmarked word{detail.unmarkedLemmas.length !== 1 ? 's' : ''} read
                {typeof st.unmarkedKnown === 'number' ? ` — ${st.unmarkedKnown} in your library, ${st.unmarkedUnknown ?? 0} not yet` : ''}.
                {typeof st.credited === 'number' && st.credited > 0 ? ` ${st.credited} earned reading credit.` : ''}
                {typeof st.knownAdded === 'number' && st.knownAdded > 0 ? ` ${st.knownAdded} added as known.` : ''}
                {typeof st.graduatedExisting === 'number' && st.graduatedExisting > 0 ? ` ${st.graduatedExisting} auto-graduated.` : ''}
                {typeof st.dontKnowAdded === 'number' && st.dontKnowAdded > 0 ? ` ${st.dontKnowAdded} added to learn.` : ''}
              </p>
            )}
          </div>
          <button className="btn-ghost text-danger text-sm shrink-0" onClick={() => void deleteEntry(detail)}>Delete</button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}

        {detail.status !== 'done' && (
          <div className="panel text-sm text-ink-muted text-center py-8 space-y-2">
            <p>Processing on the server — {detailProg ? `${detailProg.done} of ${detailProg.total} pages parsed${detailProg.failed > 0 ? `, ${detailProg.failed} failed` : ''}` : 'starting up'}…</p>
            <p className="text-xs text-ink-faint">You can close the app; this page updates on its own.</p>
          </div>
        )}
        {readyToReview && (
          <button className="btn-primary" onClick={() => void openReview(detail)}>
            Review &amp; save{typeof st.failedPages === 'number' && st.failedPages > 0 ? ` (${st.failedPages} page${st.failedPages !== 1 ? 's' : ''} failed to parse)` : ''} →
          </button>
        )}
        {typeof st.deckId === 'string' && (
          <Link href={routes.deck(st.deckId)} className="btn-ghost inline-block text-sm">Open the book&apos;s deck →</Link>
        )}

        {detail.status !== 'done' ? null : cands.length > 0 ? (
          <div className="space-y-2">
            <h2 className="text-base font-medium text-ink">Marked words</h2>
            {cands.map((c, i) => (
              <div key={i} className="panel space-y-1">
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="font-medium text-ink">{c.text}</span>
                  <span className="text-sm text-ink-muted">{c.gloss}</span>
                  <span className="text-xs text-ink-faint ml-auto">{c.kind === 'phrase' ? 'phrase · ' : ''}{c.count > 1 ? `marked ${c.count}×` : c.markers?.[0] ?? ''}</span>
                </div>
                {c.sentences?.[0] && <p className="text-xs text-ink-muted italic">{c.sentences[0].sentence}</p>}
              </div>
            ))}
          </div>
        ) : (
          <div className="panel text-sm text-ink-muted text-center py-8">No marked words in this entry — a clean read.</div>
        )}
      </div>
    )
  }

  // ═══ Wizard: done ═══
  if (view === 'wizard' && step === 'done' && summary) {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-4">
        <h1 className="text-xl font-semibold text-ink">Pages logged</h1>
        <p className="text-sm text-ink-muted">
          {summary.created} card{summary.created !== 1 ? 's' : ''} created with their book sentences
          {summary.attached > 0 && `, ${summary.attached} existing card${summary.attached !== 1 ? 's' : ''} gained sentences`}
          {summary.replaced > 0 && `, ${summary.replaced} replaced`}
          {summary.skipped > 0 && `, ${summary.skipped} skipped`}.
        </p>
        {(summary.knownAdded + summary.graduatedExisting + summary.dontKnowAdded + summary.credited > 0 || summary.chipSkipped > 0) && (
          <p className="text-sm text-ink-muted">
            {summary.knownAdded > 0 && `${summary.knownAdded} word${summary.knownAdded !== 1 ? 's' : ''} added as known. `}
            {summary.graduatedExisting > 0 && `${summary.graduatedExisting} existing card${summary.graduatedExisting !== 1 ? 's' : ''} auto-graduated. `}
            {summary.dontKnowAdded > 0 && `${summary.dontKnowAdded} added to learn. `}
            {summary.credited > 0 && `${summary.credited} long-term word${summary.credited !== 1 ? 's' : ''} earned reading credit. `}
            {summary.chipSkipped > 0 && `${summary.chipSkipped} chip${summary.chipSkipped !== 1 ? 's' : ''} skipped (no translation came back — paint them again next time).`}
          </p>
        )}
        <div className="flex justify-center gap-3">
          {summary.deckId && <Link href={routes.deck(summary.deckId)} className="btn-primary">Open the deck</Link>}
          <button className="btn-ghost" onClick={() => startWizard(wizardBook)}>More pages</button>
          <button className="btn-ghost" onClick={() => backToLog(wizardBook)}>Back to log</button>
        </div>
      </div>
    )
  }

  // ═══ Wizard: review ═══
  if (view === 'wizard' && (step === 'review' || step === 'committing')) {
    const newRows = rows.filter(r => !r.existing)
    const matchedRows = rows.filter(r => r.existing)
    return (
      <div className="space-y-6 max-w-2xl mx-auto pb-12">
        <div>
          <h1 className="text-2xl font-semibold text-ink">{title.trim() || 'Book intake'} — review</h1>
          <p className="text-sm text-ink-muted mt-1">
            {rows.length} word{rows.length !== 1 ? 's' : ''} found{failedWindows > 0 ? ` · ${failedWindows} window${failedWindows !== 1 ? 's' : ''} failed to parse (re-run those pages later)` : ''}. The entry is logged; no cards are saved until you confirm.
          </p>
          {langWarning && pair && (
            <p className="text-sm text-warning mt-2">
              ⚠ These pages read as {langName(langWarning)}, but this book is set to {langName(pair.sourceLanguage)}.
              If the book's language is wrong, go back WITHOUT saving and use “Change language” on the book's page first.
            </p>
          )}
          {unmarkedSummary && unmarkedSummary.total > 0 && (
            <p className="text-xs text-ink-faint mt-1">
              You also read {unmarkedSummary.total} unmarked word{unmarkedSummary.total !== 1 ? 's' : ''} — {unmarkedSummary.known} in your library, {unmarkedSummary.unknown} not yet.
            </p>
          )}
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
                    <option value="link">Link the same card into this book&apos;s set</option>
                    <option value="add">Add anyway as its own card</option>
                    <option value="replace">Replace the old card</option>
                  </select>
                </div>
                {r.candidate.sentences[0] && <p className="text-xs text-ink-muted italic">{r.candidate.sentences[0].sentence}</p>}
              </div>
            ))}
          </div>
        )}

        {rows.length === 0 && <div className="panel text-sm text-ink-muted text-center py-8">No marked words found on these pages — logged as a clean read.</div>}

        {/* Stage E: the unmarked words. Graduated matches credit silently; the rest are chips. */}
        {(chips.length > 0 || knownGradRef.current.length > 0) && (
          <div className="space-y-3">
            <h2 className="text-base font-medium text-ink">Words you read without marking</h2>
            {knownGradRef.current.length > 0 && (
              <p className="text-xs text-ink-muted">
                ✓ {knownGradRef.current.length} already-graduated word{knownGradRef.current.length !== 1 ? 's' : ''} will quietly earn reading
                credit when you save (long-term cards only — their next review moves out).
              </p>
            )}
            {chips.length > 0 && (
              <>
                <p className="text-xs text-ink-faint">
                  Pick a bucket, then tap the words that belong in it. Unpainted words are ignored.
                  A word with a dot is already in your library unstudied — painting it short/long-term
                  graduates that card instead of creating a new one.
                </p>
                <div className="flex flex-wrap gap-2">
                  {BUCKETS.map(b => {
                    const count = chips.filter(c => c.bucket === b.key).length
                    const active = activeBucket === b.key
                    return (
                      <button key={b.key}
                        className={[
                          'px-3 py-1.5 rounded-lg border text-sm transition-colors',
                          active ? b.chipClass + ' font-medium' : 'border-line/20 text-ink-muted hover:text-ink',
                        ].join(' ')}
                        onClick={() => setActiveBucket(prev => prev === b.key ? null : b.key)}>
                        <span className={`inline-block w-2 h-2 rounded-full mr-2 align-middle ${b.dotClass}`} />
                        {b.label}{count > 0 ? ` (${count})` : ''}
                        <span className="text-xs text-ink-faint ml-2">{b.hint}</span>
                      </button>
                    )
                  })}
                </div>
                <div className="panel flex flex-wrap gap-1.5">
                  {chips.map((c, i) => {
                    const bucket = BUCKETS.find(b => b.key === c.bucket)
                    return (
                      <button key={i}
                        title={c.existing ? `In your library unstudied: ${displayText(c.existing.front)} — ${displayText(c.existing.back)}` : undefined}
                        className={[
                          'px-2.5 py-1 rounded-full border text-sm transition-colors',
                          bucket ? bucket.chipClass : 'border-line/20 text-ink-muted hover:text-ink hover:border-line/40',
                        ].join(' ')}
                        onClick={() => setChips(prev => prev.map((x, j) => j === i
                          ? { ...x, bucket: activeBucket === null ? null : (x.bucket === activeBucket ? null : activeBucket) }
                          : x))}>
                        {c.lemma}{c.existing && <span className="ml-1 align-middle inline-block w-1.5 h-1.5 rounded-full bg-ink-faint" />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex gap-3">
          <button className="btn-primary px-6 disabled:opacity-50"
            disabled={step === 'committing' || (rows.length === 0 && chips.every(c => c.bucket === null) && knownGradRef.current.length === 0)}
            onClick={() => void commit()}>
            {step === 'committing' ? 'Saving…' : 'Save to Lexify'}
          </button>
          <button className="btn-ghost" disabled={step === 'committing'} onClick={() => backToLog(wizardBook)}>Done</button>
        </div>
      </div>
    )
  }

  // ═══ Wizard: uploading ═══
  if (view === 'wizard' && step === 'uploading') {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-4">
        <h1 className="text-xl font-semibold text-ink">Sending your pages…</h1>
        <p className="text-sm text-ink-muted">{progress.done} of {progress.total} uploaded. Once they're sent, parsing runs on the server — you can close the app.</p>
        <div className="h-1.5 bg-surface-raised rounded-full overflow-hidden max-w-xs mx-auto">
          <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }} />
        </div>
      </div>
    )
  }

  // ═══ Wizard: loading stored results for review ═══
  if (view === 'wizard' && step === 'loading') {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-4">
        <h1 className="text-xl font-semibold text-ink">Loading the results…</h1>
        <p className="text-sm text-ink-muted">Matching the extracted words against your lexicon.</p>
      </div>
    )
  }

  // ═══ Wizard: setup ═══
  if (view === 'wizard') {
    return (
      <div className="space-y-6 max-w-2xl mx-auto pb-12">
        <div>
          <button className="text-sm text-ink-muted hover:text-ink" onClick={() => backToLog(wizardBook ?? activeBook)}>← {wizardBook?.title ?? activeBook?.title ?? 'Media log'}</button>
          <h1 className="text-2xl font-semibold text-ink mt-1">{wizardBook ? `Log pages — ${wizardBook.title}` : 'New book — log pages'}</h1>
          <p className="text-sm text-ink-muted mt-1">
            Photograph the pages you read, in order. Lexify finds the words you marked and turns them
            into cards — each with the exact sentence it came from.
          </p>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="panel space-y-3">
          <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Book</label>
          {wizardBook ? (
            <p className="text-sm text-ink">
              {langFlag(wizardBook.sourceLanguage)} {wizardBook.title}
              <span className="text-ink-faint"> · {langName(wizardBook.sourceLanguage)} → {langName(wizardBook.targetLanguage)}</span>
            </p>
          ) : (<>
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
          </>)}
          <div className="flex items-center gap-3">
            <label className="text-sm text-ink-muted shrink-0">Read on</label>
            <input type="date" className="input py-1.5 text-sm w-auto" value={readOn} max={localToday()}
              onChange={e => setReadOn(e.target.value)} />
            <span className="text-xs text-ink-faint">the day you read these pages — today or earlier</span>
          </div>
        </div>

        <div className="panel space-y-3">
          <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">How do you mark words?</label>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {([['circled', 'Circled'], ['underlined', 'Underlined']] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="accent-accent" checked={markers[k]}
                  onChange={e => setMarkers(m => ({ ...m, [k]: e.target.checked }))} />
                <span className="text-ink">{label}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-ink-faint">Circling and underlining are the two marks Lexify reads. Remembered per book.</p>
        </div>

        <div className="panel space-y-3">
          <label className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Extraction</label>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input type="checkbox" className="accent-accent" checked={sentences} onChange={e => setSentences(e.target.checked)} />
            <span className="text-ink">Extract sentences</span>
            <span className="text-xs text-ink-faint">marked words keep the exact sentence they appeared in (pages are page-number-ordered first)</span>
          </label>
          {articleLang && (
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" className="accent-accent" checked={nounArticle} onChange={e => setNounArticle(e.target.checked)} />
              <span className="text-ink">Nouns with definite article</span>
              <span className="text-xs text-ink-faint">le sentier, la berge — the way you card gender</span>
            </label>
          )}
          <p className="text-xs text-ink-faint">
            Nouns: nominative singular (naturally-plural words stay plural) · Verbs: infinitive ·
            Adjectives: masculine singular · Phrases and idioms: kept exactly as printed.
          </p>
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
          <p className="text-xs text-ink-faint">Upload in any order. Parsing runs on the server — send the pages and close the app; results appear in the log when they're ready. Photos are deleted the moment parsing finishes.</p>
        </div>

        <button className="btn-primary w-full disabled:opacity-50"
          disabled={preparing || photos.length === 0 || !pair || !anyMarker}
          onClick={() => void submitPages()}>
          {preparing ? 'Preparing photos…'
            : photos.length === 0 ? 'Add page photos'
            : !anyMarker ? 'Pick circled, underlined, or both'
            : `Send ${photos.length} page${photos.length !== 1 ? 's' : ''}`}
        </button>
      </div>
    )
  }

  // Entries sorted by reading day (not logging day) — a backfilled entry files under when it was read.
  const sortedEntries = (list: MediaEntry[]) => [...list].sort((a, b) =>
    (b.readOn ?? b.createdAt.slice(0, 10)).localeCompare(a.readOn ?? a.createdAt.slice(0, 10)) || b.createdAt.localeCompare(a.createdAt))

  const entryRow = (e: MediaEntry, showTitle: boolean) => {
    const st = e.stats as Record<string, number | string | undefined>
    const found = (e.candidates as unknown[]).length
    const prog = progressMap.get(e.id)
    const readyToReview = e.status === 'done' && st.engine === 'v2' && st.created == null
    return (
      <button key={e.id} className="panel w-full text-left hover:border-accent/40 transition-colors"
        onClick={() => { setDetail(e); setView('detail'); setError(null) }}>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="font-medium text-ink">{showTitle ? <>{langFlag(e.sourceLanguage)} {e.title}</> : fmtDay(e.readOn ?? e.createdAt.slice(0, 10))}</span>
          {showTitle && <span className="text-xs text-ink-faint ml-auto">{entryDate(e)}</span>}
        </div>
        {e.status !== 'done' ? (
          <p className="text-xs text-accent-soft mt-1">
            Processing — {prog ? `${prog.done} of ${prog.total} pages parsed${prog.failed > 0 ? ` · ${prog.failed} failed` : ''}` : `${e.pages} page${e.pages !== 1 ? 's' : ''}`}…
          </p>
        ) : (
          <p className="text-xs text-ink-muted mt-1">
            {e.pages} page{e.pages !== 1 ? 's' : ''}{readyToReview ? '' : ` · ${found} marked`}
            {typeof st.created === 'number' && st.created > 0 ? ` · ${st.created} card${st.created !== 1 ? 's' : ''} created` : ''}
            {typeof st.attached === 'number' && st.attached > 0 ? ` · ${st.attached} gained sentences` : ''}
            {typeof st.credited === 'number' && st.credited > 0 ? ` · ${st.credited} credited` : ''}
            {readyToReview ? ' · ready to review' : st.created == null ? ' · review not saved' : ''}
          </p>
        )}
      </button>
    )
  }

  // ═══ One book's page ═══
  if (view === 'book' && activeBook) {
    const bookEntries = sortedEntries(entries.filter(e => e.bookId === activeBook.id))
    const pagesTotal = bookEntries.reduce((n, e) => n + e.pages, 0)
    const markedTotal = bookEntries.reduce((n, e) => n + (e.candidates as unknown[]).length, 0)
    return (
      <div className="space-y-6 max-w-2xl mx-auto pb-12">
        <div className="flex items-start justify-between gap-3">
          <div>
            <button className="text-sm text-ink-muted hover:text-ink" onClick={() => { setActiveBook(null); setView('books') }}>← Media log</button>
            <h1 className="text-2xl font-semibold text-ink mt-1">{langFlag(activeBook.sourceLanguage)} {activeBook.title}</h1>
            <p className="text-sm text-ink-muted mt-1">
              {bookEntries.length} entr{bookEntries.length === 1 ? 'y' : 'ies'} · {pagesTotal} page{pagesTotal !== 1 ? 's' : ''} · {markedTotal} word{markedTotal !== 1 ? 's' : ''} marked
            </p>
          </div>
          <button className="btn-primary shrink-0" onClick={() => startWizard(activeBook)}>+ Log pages</button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex items-center gap-3 flex-wrap">
          {activeBook.deckId && (
            <Link href={routes.deck(activeBook.deckId)} className="btn-ghost inline-block text-sm">Open the book&apos;s deck →</Link>
          )}
          {!changingLang && (
            <button className="text-xs text-ink-faint hover:text-ink transition-colors"
              onClick={() => { setChangingLang(true); setMovePairKey('') }}>
              Change language
            </button>
          )}
        </div>
        {changingLang && (
          <div className="panel space-y-3">
            <p className="text-sm text-ink-muted">
              Move this book — its entries, its deck, and every card in it — to a different language
              pair. Card labels, distractors, and audio regenerate under the new language; review
              schedules are untouched.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <select className="input py-1.5 text-sm w-auto" value={movePairKey} onChange={e => setMovePairKey(e.target.value)}>
                <option value="">Pick the correct pair…</option>
                {pairs.filter(p => `${p.sourceLanguage}|${p.targetLanguage}` !== `${activeBook.sourceLanguage}|${activeBook.targetLanguage}`).map(p => (
                  <option key={p.id} value={`${p.sourceLanguage}|${p.targetLanguage}`}>
                    {langFlag(p.sourceLanguage)} {langName(p.sourceLanguage)} → {langName(p.targetLanguage)}
                  </option>
                ))}
              </select>
              <button className="btn-primary text-sm disabled:opacity-50" disabled={!movePairKey || moving}
                onClick={() => { const [src, tgt] = movePairKey.split('|'); void moveBookPair(activeBook, src!, tgt!) }}>
                {moving ? 'Moving…' : 'Move book'}
              </button>
              <button className="btn-ghost text-sm" disabled={moving} onClick={() => setChangingLang(false)}>Cancel</button>
            </div>
          </div>
        )}
        {bookEntries.length === 0 ? (
          <div className="panel text-sm text-ink-muted text-center py-10">No entries yet — log the first pages you read.</div>
        ) : (
          <div className="space-y-2">{bookEntries.map(e => entryRow(e, false))}</div>
        )}
      </div>
    )
  }

  // ═══ The shelf ═══
  const unfiled = entries.filter(e => !e.bookId)
  return (
    <div className="space-y-6 max-w-2xl mx-auto pb-12">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Media</h1>
          <p className="text-sm text-ink-muted mt-1">
            A log of what you read, one book at a time. Each entry extracts the words you marked —
            and keeps Lexify in step with the words you didn&apos;t.
          </p>
        </div>
        <button className="btn-primary shrink-0" onClick={() => startWizard(null)}>+ New book</button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

      {loading ? (
        <div className="panel text-sm text-ink-muted text-center py-8">Loading…</div>
      ) : books.length === 0 && unfiled.length === 0 ? (
        <div className="panel text-sm text-ink-muted text-center py-10 space-y-2">
          <p>No books yet.</p>
          <p className="text-xs text-ink-faint">Add the book you&apos;re reading, photograph the pages as you go — marked words become cards with their book sentences.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {books.map(b => {
            const bookEntries = entries.filter(e => e.bookId === b.id)
            const pagesTotal = bookEntries.reduce((n, e) => n + e.pages, 0)
            const lastRead = sortedEntries(bookEntries)[0]
            return (
              <button key={b.id} className="panel w-full text-left hover:border-accent/40 transition-colors"
                onClick={() => { setActiveBook(b); setView('book'); setError(null); setChangingLang(false) }}>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="font-medium text-ink text-base">{langFlag(b.sourceLanguage)} {b.title}</span>
                  {lastRead && <span className="text-xs text-ink-faint ml-auto">last read {entryDate(lastRead)}</span>}
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {bookEntries.length} entr{bookEntries.length === 1 ? 'y' : 'ies'} · {pagesTotal} page{pagesTotal !== 1 ? 's' : ''}
                  {bookEntries.length === 0 ? ' — nothing logged yet' : ''}
                </p>
              </button>
            )
          })}
          {/* Legacy entries never linked to a book (pre-migration-130 rows the backfill missed). */}
          {unfiled.length > 0 && (
            <div className="space-y-2 pt-2">
              <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Unfiled entries</h2>
              {sortedEntries(unfiled).map(e => entryRow(e, true))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
