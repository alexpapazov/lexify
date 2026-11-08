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
import { DEFAULT_OPTIONS, ARTICLE_LANGS, type IntakeOptions, type IntakeCandidate, type ChipBucket } from '@/lib/mediaIntake'
import { buildWorklist, type WorklistItem, type WorklistPageSection } from '@/lib/mediaWorklist'
import { fetchGlosses, seedKnownStates, applyRecognitionPenalty } from '@/lib/mediaRate'
import { creditCardSighting } from '@/lib/implicitCredit'
import { buildEnabledTracksMap, buildRetentionMap, buildCalibrationMap, type EnabledTracks } from '@/lib/sessionLimits'
import { seedOnboardLoad } from '@/engine/density'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { mapLimit } from '@/lib/mapLimit'
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

/** A worklist item with its live UI state: the painted bucket, or the penalty toggle. */
interface UIItem extends WorklistItem {
  bucket:   ChipBucket | null
  penalize: boolean
  /** ×-ed away: hidden immediately, recorded as 'ignored' on the next auto-save. */
  removed:  boolean
}
interface UIPage extends Omit<WorklistPageSection, 'items'> { items: UIItem[] }

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

  const [view, setView] = useState<'books' | 'book' | 'detail' | 'wizard' | 'rate'>('books')
  const [activeBook, setActiveBook] = useState<MediaBook | null>(null)
  const [changingLang, setChangingLang] = useState(false)
  const [movePairKey, setMovePairKey] = useState('')
  const [moving, setMoving] = useState(false)
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
  const [step, setStep] = useState<'setup' | 'uploading'>('setup')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [activeBucket, setActiveBucket] = useState<ChipBucket | null>(null)
  /** The rating worklist for the entry being rated (view 'rate'); null while it loads. */
  const [wl, setWl] = useState<{ pages: UIPage[]; quietCount: number; detectedLang: string | null } | null>(null)
  /** Mirror of `wl` for the save engine — sequential saves must never read stale state. */
  const wlRef = useRef<{ pages: UIPage[]; quietCount: number; detectedLang: string | null } | null>(null)
  const setWorklist = (next: { pages: UIPage[]; quietCount: number; detectedLang: string | null } | null) => {
    wlRef.current = next
    setWl(next)
  }
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const commitBusyRef = useRef(false)
  /** Latest commitWork, so the unmount flush never runs a stale closure. */
  const commitWorkRef = useRef<((opts: { chips: boolean; penalties: boolean }) => Promise<void>) | null>(null)

  const libraryRef = useRef<{ cards: Card[]; forward: Map<string, CardState>; reverse: Map<string, CardState> }>({ cards: [], forward: new Map(), reverse: new Map() })
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
    setReadOn(localToday()); setPhotos([]); setError(null)
    setActiveBucket(null)
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

  /**
   * Opens the RATING WORKLIST for a processed entry: pages in reading order, each showing only
   * the items that still need something — don't-know chips (marked words), long-term-prepainted
   * chips (unmarked new words), and recognition failures. Credits apply automatically.
   */
  async function openWorklist(entry: MediaEntry) {
    setError(null)
    const book = books.find(b => b.id === entry.bookId) ?? null
    setWizardBook(book)
    entryRef.current = entry
    setWorklist(null)
    setActiveBucket(null)
    setView('rate')
    try {
      const [pages] = await Promise.all([
        new SupabaseMediaPageRepository().listForEntry(entry.id),
        loadContext(),
      ])
      const built = buildWorklist(pages, entry.ratings, libraryRef.current.cards, libraryRef.current.forward, entry.sourceLanguage, entry.targetLanguage)
      setWorklist({
        pages: built.pages.map(pg => ({
          ...pg,
          items: pg.items.map(it => ({
            ...it,
            // Only MARKED words auto-fill ("I don't know"); everything else starts blank —
            // unpainted means undecided, and undecided words simply wait for a later visit
            // (user decision 2026-11-08: never silently file a word as known).
            bucket: it.cls === 'dontknow' ? 'dontknow' as ChipBucket : null,
            penalize: it.cls === 'penalty',
            removed: false,
          })),
        })),
        quietCount: built.quietCount,
        detectedLang: built.detectedLang,
      })
      if (built.creditTargets.length > 0) void applyCredits(entry, built.creditTargets)
      setSaveState('idle')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the results.')
      backToLog(book)
    }
  }

  /** Implicit credit is automatic — ×1.3 for every unrated unmarked long-term word, recorded
   *  as 'credited' so it never re-applies (the ≥20h per-row cap guards double-uploads too). */
  async function applyCredits(entry: MediaEntry, targets: WorklistItem[]) {
    const { retMap, calMap, tracksByPair } = paramsRef.current
    const ctx = {
      userId, now: new Date(), tz: profileRef.current.tz, turnoverHour: profileRef.current.turnoverHour,
      retMap, calMap, tracks: tracksByPair.get(`${entry.sourceLanguage}|${entry.targetLanguage}`),
      stateRepo: new SupabaseCardStateRepository(),
    }
    let credited = 0
    await mapLimit(targets, 4, async t => {
      try {
        const out = await creditCardSighting({
          card: t.existing!,
          forward: libraryRef.current.forward.get(t.existing!.id) ?? null,
          reverse: libraryRef.current.reverse.get(t.existing!.id) ?? null,
        }, ctx)
        if (out) credited++
      } catch { /* best-effort per card */ }
      return null
    })
    try {
      const cur = entryRef.current ?? entry
      const ratings = { ...cur.ratings }
      for (const t of targets) ratings[t.key] = 'credited'
      const updated = await new SupabaseMediaEntryRepository().update(entry.id, {
        ratings,
        stats: { ...cur.stats, credited: Number((cur.stats as Record<string, unknown>).credited ?? 0) + credited },
      })
      entryRef.current = updated
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e))
      const cur2 = wlRef.current
      if (cur2) setWorklist({
        ...cur2,
        pages: cur2.pages.map((pg, i) => ({ ...pg, credited: pg.credited + targets.filter(t => t.pageIdx === i).length })),
      })
    } catch { /* the credit writes landed; the bookkeeping retries next open */ }
  }

  /** The book's deck — remembered on the book, found by name, or created. */
  async function ensureDeck(entry: MediaEntry): Promise<{ deckId: string; pipelineId: string }> {
    const deckRepo = new SupabaseDeckRepository()
    const defaultPipeline = await new SupabasePipelineRepository().getDefault()
    const decks = await deckRepo.list(userId)
    let deck = (wizardBook?.deckId ? decks.find(d => d.id === wizardBook.deckId) : undefined)
      ?? decks.find(d => d.name === entry.title && d.sourceLanguage === entry.sourceLanguage && d.targetLanguage === entry.targetLanguage)
      ?? null
    if (!deck) {
      deck = await deckRepo.create(userId, { name: entry.title || 'Book intake', sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage, pipelineId: defaultPipeline.id })
    }
    if (wizardBook && wizardBook.deckId !== deck.id) {
      void new SupabaseMediaBookRepository().update(wizardBook.id, { deckId: deck.id })
        .then(b => { setWizardBook(b); setBooks(prev => prev.map(x => x.id === b.id ? b : x)) }).catch(() => {})
    }
    return { deckId: deck.id, pipelineId: defaultPipeline.id }
  }

  /**
   * Commits worklist items exactly as painted — CHIPS on the idle auto-save (a few seconds
   * after the last interaction), PENALTIES only when leaving the entry (the whole visit is the
   * window to flip an accidental mark). Items whose gloss fails stay unrated and retry on the
   * next trigger. There is no Save button anywhere — this runs itself.
   */
  async function commitWork(opts: { chips: boolean; penalties: boolean }) {
    const entry = entryRef.current
    const wlNow = wlRef.current
    if (!wlNow || !entry || commitBusyRef.current) return
    const all = wlNow.pages.flatMap(pg => pg.items)
    const penalties  = opts.penalties ? all.filter(it => it.cls === 'penalty' && it.penalize) : []
    const dismissed  = opts.penalties ? all.filter(it => it.cls === 'penalty' && !it.penalize) : []
    const chipsItems = opts.chips ? all.filter(it => it.cls !== 'penalty') : []
    if (penalties.length + dismissed.length + chipsItems.length === 0) return

    commitBusyRef.current = true
    setSaveState('saving')
    try {
      const cardRepo = new SupabaseCardRepository()
      const stateRepo = new SupabaseCardStateRepository()
      const { retMap, calMap, tracksByPair } = paramsRef.current
      const tracks = tracksByPair.get(`${entry.sourceLanguage}|${entry.targetLanguage}`)
      const now = new Date()

      const dontKnow   = chipsItems.filter(it => !it.removed && it.bucket === 'dontknow')
      const shortLong  = chipsItems.filter(it => !it.removed && (it.bucket === 'short' || it.bucket === 'long'))
      // Only an explicit × is "ignored"; an unpainted chip is UNDECIDED and waits for you.
      const ignored    = chipsItems.filter(it => it.removed)
      const dkNew      = dontKnow.filter(it => !it.existing)
      const dkExisting = dontKnow.filter(it => it.existing)
      const slNew      = shortLong.filter(it => !it.existing)
      const slExisting = shortLong.filter(it => it.existing)

      // Glosses + display forms: marked items carry theirs from the page; unmarked new cards
      // gloss here (the display form adds the noun's article when the book's option asks).
      const nounArticle = (entry.options as { nounArticle?: boolean }).nounArticle === true
      const needGloss = [...dkNew, ...slNew].filter(it => !it.gloss)
      const glossMap = needGloss.length > 0
        ? await fetchGlosses(needGloss.map(it => it.lemma), entry.sourceLanguage, entry.targetLanguage, nounArticle)
        : new Map<string, { gloss: string; display: string | null }>()
      const glossOf = (it: UIItem) => it.gloss ?? glossMap.get(it.lemma)?.gloss ?? null
      const frontOf = (it: UIItem) => it.marked ? it.display : (glossMap.get(it.lemma)?.display ?? it.display)
      const dkReady = dkNew.filter(it => glossOf(it) != null)
      const slReady = slNew.filter(it => glossOf(it) != null)
      const glossSkipped = (dkNew.length - dkReady.length) + (slNew.length - slReady.length)

      const needsDeck = dkReady.length + slReady.length + dkExisting.length + penalties.length > 0
      let deckId: string | null = null
      let pipelineId = ''
      if (needsDeck) ({ deckId, pipelineId } = await ensureDeck(entry))
      if (!pipelineId && slExisting.length > 0) pipelineId = (await new SupabasePipelineRepository().getDefault()).id

      const toCreate = [...dkReady, ...slReady]
      const created = toCreate.length > 0 ? await cardRepo.bulkCreate(
        deckId!, userId, entry.sourceLanguage, entry.targetLanguage,
        toCreate.map((it, i) => ({ front: frontOf(it), back: glossOf(it)!, position: 1000 + i })),
      ) : []
      for (let i = 0; i < created.length; i++) {
        const it = toCreate[i]!
        if (it.sentences.length === 0) continue
        let choices = created[i]!.choices
        for (const sn of it.sentences.slice(0, 3)) {
          choices = appendStoredCloze(choices, { sentence: sn.sentence, answer: sn.answer, translation: '', gloss: glossOf(it)! })
        }
        await cardRepo.update(created[i]!.id, { choices })
      }
      const slCreated = created.slice(dkReady.length)

      if (slCreated.length + slExisting.length > 0) {
        const deps = {
          userId, src: entry.sourceLanguage, tgt: entry.targetLanguage, now, tracks,
          retMap, calMap, stateRepo, pipelineId,
          load: await seedOnboardLoad(userId, now, 110, stateRepo),
        }
        const states: CardState[] = []
        slCreated.forEach((c, i) => states.push(...seedKnownStates(c.id, slReady[i]!.bucket as 'short' | 'long', undefined, undefined, deps)))
        for (const it of slExisting) {
          states.push(...seedKnownStates(it.existing!.id, it.bucket as 'short' | 'long',
            libraryRef.current.forward.get(it.existing!.id), libraryRef.current.reverse.get(it.existing!.id), deps))
        }
        await stateRepo.upsertBatch(states)
      }

      let linkPos = 100000
      for (const it of [...dkExisting, ...penalties]) {
        if (deckId) await cardRepo.addToDeck(deckId, it.existing!.id, linkPos++)
        if (it.sentences.length > 0) {
          let choices = it.existing!.choices
          for (const sn of it.sentences.slice(0, 3)) {
            choices = appendStoredCloze(choices, { sentence: sn.sentence, answer: sn.answer, translation: '', gloss: it.gloss ?? displayText(it.existing!.back) })
          }
          await cardRepo.update(it.existing!.id, { choices })
        }
      }

      if (penalties.length > 0) {
        const deps = { userId, src: entry.sourceLanguage, tgt: entry.targetLanguage, now, tracks, retMap, calMap, stateRepo, pipelineId, load: new Map<number, number>() }
        for (const it of penalties) {
          await applyRecognitionPenalty(it.existing!, libraryRef.current.forward.get(it.existing!.id) ?? null, libraryRef.current.reverse.get(it.existing!.id) ?? null, deps)
        }
      }

      const ratings = { ...(entryRef.current?.ratings ?? entry.ratings) }
      for (const it of [...dkReady, ...dkExisting]) ratings[it.key] = 'dontknow'
      for (const it of [...slReady, ...slExisting]) ratings[it.key] = it.bucket as string
      for (const it of ignored) ratings[it.key] = 'ignored'
      for (const it of penalties) ratings[it.key] = 'penalized'
      for (const it of dismissed) ratings[it.key] = 'dismissed'

      const prevStats = (entryRef.current?.stats ?? entry.stats) as Record<string, unknown>
      const n = (k: string) => Number(prevStats[k] ?? 0)
      const remaining = wlNow.pages.reduce((sum, pg) => sum + pg.items.filter(it => ratings[it.key] == null).length, 0)
      const stats = {
        ...prevStats,
        dontKnowAdded: n('dontKnowAdded') + dkReady.length,
        knownAdded: n('knownAdded') + slReady.length,
        graduatedExisting: n('graduatedExisting') + slExisting.length,
        linked: n('linked') + dkExisting.length + penalties.length,
        penalized: n('penalized') + penalties.length,
        chipSkipped: n('chipSkipped') + glossSkipped,
        remaining,
        ...(deckId ? { deckId } : {}),
      }
      const updated = await new SupabaseMediaEntryRepository().update(entry.id, { ratings, stats })
      entryRef.current = updated
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e))
      const cur = wlRef.current
      if (cur) setWorklist({
        ...cur,
        pages: cur.pages.map(pg => ({
          ...pg,
          items: pg.items.filter(it => ratings[it.key] == null),
          settled: pg.settled + pg.items.filter(it => ratings[it.key] != null && it.cls !== 'credit').length,
        })),
      })
      setSaveState('saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Saving failed — your paints are kept, it will retry.')
      setSaveState('idle')
    } finally {
      commitBusyRef.current = false
    }
  }
  commitWorkRef.current = commitWork

  /** THE save point (user decision 2026-11-08): everything commits when you leave the entry —
   *  painted chips, × removals, penalty decisions. Nothing saves while you're looking. */
  function flushOnLeave() {
    void commitWorkRef.current?.({ chips: true, penalties: true })
  }

  // Unmount (navigating off /media entirely) counts as leaving the entry.
  useEffect(() => () => {
    void commitWorkRef.current?.({ chips: true, penalties: true })
  }, [])

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

  // ═══ Entry detail ═══
  if (view === 'detail' && detail) {
    const cands = detail.candidates as IntakeCandidate[]
    const st = detail.stats as Record<string, number | string | undefined>
    const detailProg = progressMap.get(detail.id)
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

  // ═══ The rating worklist ═══
  if (view === 'rate') {
    const entry = entryRef.current
    const remaining = wl ? wl.pages.reduce((n2, pg) => n2 + pg.items.filter(it => !it.removed).length, 0) : 0
    const creditedTotal = wl ? wl.pages.reduce((n2, pg) => n2 + pg.credited, 0) : 0
    const bucketCount = (k: ChipBucket) => wl ? wl.pages.reduce((n2, pg) => n2 + pg.items.filter(it => it.cls !== 'penalty' && !it.removed && it.bucket === k).length, 0) : 0
    const setItem = (key: string, fn: (it: UIItem) => UIItem) => {
      const cur = wlRef.current
      if (!cur) return
      setWorklist({ ...cur, pages: cur.pages.map(pg => ({ ...pg, items: pg.items.map(it => it.key === key ? fn(it) : it) })) })
    }
    return (
      <div className="space-y-6 max-w-2xl mx-auto pb-12">
        <div className="flex items-start justify-between gap-3">
          <div>
            <button className="text-sm text-ink-muted hover:text-ink" onClick={() => { flushOnLeave(); backToLog(wizardBook) }}>← {wizardBook?.title ?? 'Media log'}</button>
            <h1 className="text-2xl font-semibold text-ink mt-1">{entry ? `${langFlag(entry.sourceLanguage)} ${entry.title}` : 'Rating'}</h1>
            {wl && entry && (
              <p className="text-sm text-ink-muted mt-1">
                {entryDate(entry)} · {remaining} word{remaining !== 1 ? 's' : ''} left to rate
                {creditedTotal > 0 ? ` · ${creditedTotal} credited automatically` : ''}
                {wl.quietCount > 0 ? ` · ${wl.quietCount} short-term word${wl.quietCount !== 1 ? 's' : ''} seen (no change)` : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xs text-ink-faint">
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'All changes saved' : ''}
            </span>
            {entry && <button className="btn-ghost text-danger text-sm" onClick={() => void deleteEntry(entry)}>Delete</button>}
          </div>
        </div>
        {wl && entry && wl.detectedLang && wl.detectedLang !== entry.sourceLanguage.toLowerCase() && (
          <p className="text-sm text-warning">
            ⚠ These pages read as {langName(wl.detectedLang)}, but this book is set to {langName(entry.sourceLanguage)}.
            If the book's language is wrong, fix it with “Change language” on the book's page BEFORE rating anything.
          </p>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}

        {!wl ? (
          <div className="panel text-sm text-ink-muted text-center py-10">Matching the extracted words against your lexicon…</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {BUCKETS.map(b => {
                const active = activeBucket === b.key
                const count = bucketCount(b.key)
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
            <p className="text-xs text-ink-faint">
              Marked words come pre-painted “I don't know”; everything else starts blank. Pick a bucket,
              tap the words that belong in it — unpainted words stay undecided and keep for a later
              visit. × throws a word out for good. Everything saves when you leave the entry.
            </p>

            {wl.pages.map((pg, pi) => {
              const penaltyItems = pg.items.filter(it => it.cls === 'penalty')
              const chipItems = pg.items.filter(it => it.cls !== 'penalty' && !it.removed)
              return (
                <div key={pi} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-medium text-ink">
                      {pg.label}
                      <span className="text-xs text-ink-faint font-normal ml-2">
                        {pg.items.filter(it => !it.removed).length > 0 ? `${pg.items.filter(it => !it.removed).length} to rate` : '✓ done'}
                        {pg.credited > 0 ? ` · ${pg.credited} credited` : ''}
                        {pg.failed ? ' · failed to parse' : ''}
                      </span>
                    </h2>

                  </div>

                  {penaltyItems.map(it => (
                    <div key={it.key} className="panel space-y-1">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="font-medium text-ink">{it.display}</span>
                        <span className="text-xs text-ink-faint">
                          in your lexicon: {displayText(it.existing!.front)} — {displayText(it.existing!.back)} · you marked it anyway
                        </span>
                        <div className="ml-auto flex gap-1">
                          <button className={`px-2.5 py-1 rounded-lg border text-xs transition-colors ${it.penalize ? 'border-danger/70 bg-danger/10 text-ink font-medium' : 'border-line/20 text-ink-muted hover:text-ink'}`}
                            onClick={() => setItem(it.key, x => ({ ...x, penalize: true }))}>
                            Didn't recognize it — due today
                          </button>
                          <button className={`px-2.5 py-1 rounded-lg border text-xs transition-colors ${!it.penalize ? 'border-line/60 bg-surface-raised text-ink font-medium' : 'border-line/20 text-ink-muted hover:text-ink'}`}
                            onClick={() => setItem(it.key, x => ({ ...x, penalize: false }))}>
                            Accidental mark
                          </button>
                        </div>
                      </div>
                      {it.sentences[0] && <p className="text-xs text-ink-muted italic">{it.sentences[0].sentence}</p>}
                    </div>
                  ))}

                  {chipItems.length > 0 && (
                    <div className="panel flex flex-wrap gap-1.5">
                      {chipItems.map(it => {
                        const bucket = BUCKETS.find(b => b.key === it.bucket)
                        return (
                          <span key={it.key}
                            title={(it.existing ? `In your library unstudied: ${displayText(it.existing.front)} — ${displayText(it.existing.back)}. ` : '') + (it.gloss ? `${it.gloss}` : '')}
                            className={[
                              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-sm transition-colors cursor-pointer select-none',
                              bucket ? bucket.chipClass : 'border-line/20 text-ink-muted hover:text-ink hover:border-line/40',
                            ].join(' ')}
                            onClick={() => setItem(it.key, x => ({
                              ...x,
                              bucket: activeBucket === null ? null : (x.bucket === activeBucket ? null : activeBucket),
                            }))}>
                            {it.display}
                            <span
                              className="text-ink-faint hover:text-danger text-xs leading-none px-0.5 -mr-1"
                              title="Remove — don't add this word"
                              onClick={e => { e.stopPropagation(); setItem(it.key, x => ({ ...x, removed: true, bucket: null })) }}>
                              ×
                            </span>
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}

            {remaining === 0 && (
              <div className="panel text-sm text-ink-muted text-center py-6">
                Everything rated. {entryRef.current && typeof (entryRef.current.stats as Record<string, unknown>).deckId === 'string'
                  ? <Link href={routes.deck((entryRef.current.stats as Record<string, string>).deckId!)} className="text-accent hover:text-accent-soft"> Open the book's deck →</Link>
                  : null}
              </div>
            )}
          </>
        )}
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
    const isV2 = st.engine === 'v2'
    const remainingToRate = typeof st.remaining === 'number' ? st.remaining : null
    // A processed entry IS its worklist — the row opens the rating view directly, no detail hop.
    const open = () => {
      setError(null)
      if (e.status === 'done' && isV2) { void openWorklist(e) } else { setDetail(e); setView('detail') }
    }
    return (
      <button key={e.id} className="panel w-full text-left hover:border-accent/40 transition-colors"
        onClick={open}>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="font-medium text-ink">{showTitle ? <>{langFlag(e.sourceLanguage)} {e.title}</> : fmtDay(e.readOn ?? e.createdAt.slice(0, 10))}</span>
          {showTitle && <span className="text-xs text-ink-faint ml-auto">{entryDate(e)}</span>}
        </div>
        {e.status !== 'done' ? (
          <p className="text-xs text-accent-soft mt-1">
            Processing — {prog ? `${prog.done} of ${prog.total} pages parsed${prog.failed > 0 ? ` · ${prog.failed} failed` : ''}` : `${e.pages} page${e.pages !== 1 ? 's' : ''}`}…
          </p>
        ) : isV2 ? (
          <p className="text-xs text-ink-muted mt-1">
            {e.pages} page{e.pages !== 1 ? 's' : ''}
            {remainingToRate == null ? ' · ready to rate' : remainingToRate > 0 ? ` · ${remainingToRate} word${remainingToRate !== 1 ? 's' : ''} left to rate` : ' · ✓ rated'}
            {typeof st.dontKnowAdded === 'number' && st.dontKnowAdded > 0 ? ` · ${st.dontKnowAdded} to learn` : ''}
            {typeof st.knownAdded === 'number' && st.knownAdded > 0 ? ` · ${st.knownAdded} known` : ''}
            {typeof st.penalized === 'number' && st.penalized > 0 ? ` · ${st.penalized} punished` : ''}
            {typeof st.credited === 'number' && st.credited > 0 ? ` · ${st.credited} credited` : ''}
          </p>
        ) : (
          <p className="text-xs text-ink-muted mt-1">
            {e.pages} page{e.pages !== 1 ? 's' : ''} · {found} marked
            {typeof st.created === 'number' && st.created > 0 ? ` · ${st.created} card${st.created !== 1 ? 's' : ''} created` : ''}
            {typeof st.attached === 'number' && st.attached > 0 ? ` · ${st.attached} gained sentences` : ''}
            {typeof st.credited === 'number' && st.credited > 0 ? ` · ${st.credited} credited` : ''}
            {st.created == null ? ' · review not saved' : ''}
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
