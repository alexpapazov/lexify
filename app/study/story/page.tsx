'use client'

/**
 * /study/story — story mode for due REVERSE reviews (2026-10-04): the day's due words woven into
 * short Sonnet-generated stories (themed by deck batches), read with the targets HIGHLIGHTED.
 *
 * The credit contract is express matching's, verbatim: reading past a highlighted word untapped
 * = reverse-track Good (via `creditExpressMatch`), applied when the story's Finish button is
 * pressed — never silently; tapping a word to reveal its meaning writes NOTHING, the card stays
 * due. Targets the model failed to weave (or that can't be located in the text) also stay due.
 * A story can never lapse or un-graduate a card.
 *
 * Two passage modes (`?passage=`): 'target' — the whole story in the learned language, every
 * non-target word tappable for its generation-time gloss (same mechanic as practice/cloze);
 * 'native' — the story in the learner's language with only the targets in the learned one.
 *
 * Stories generate progressively: reading starts after story one; the next batch generates in
 * the background while you read.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseReviewEventRepository } from '@/lib/data/reviewEvents'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildEnabledTracksMap, buildRetentionMap, buildCalibrationMap } from '@/lib/sessionLimits'
import { creditExpressMatch, type ExpressCandidate } from '@/lib/expressReview'
import { buildStoryPool, batchStories, storyTargets, locateTargets, type GeneratedStory, type TargetSpan, type StoryPassageMode } from '@/lib/storyReview'
import { segmentWords } from '@/lib/practiceRender'
import { displayText } from '@/lib/cardText'
import { getToday } from '@/lib/dates'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { apiUrl } from '@/lib/apiBase'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'

interface BatchState {
  status: 'loading' | 'error' | 'ready'
  /** Why generation failed (the route's reason string) — shown so failures are diagnosable. */
  reason?: string
  story?: GeneratedStory
  spans?: TargetSpan[]
  /** Tap-a-word glosses arrive from a PARALLEL Haiku call after the story renders. */
  glosses?: Map<string, string>
  glossStatus?: 'loading' | 'ready' | 'error'
}

export default function StoryReviewPage() {
  const offline = useOfflineMode()
  if (offline) return <OfflineUnavailable feature="Story review" />
  return (
    <Suspense fallback={<div className="text-ink-muted pt-16 text-center">Loading…</div>}>
      <StoryInner />
    </Suspense>
  )
}

function StoryInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const source = searchParams.get('source')
  const target = searchParams.get('target')
  const passage: StoryPassageMode = searchParams.get('passage') === 'native' ? 'native' : 'target'

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [userId, setUserId] = useState('')
  const [batches, setBatches] = useState<ExpressCandidate[][]>([])
  const [skippedNote, setSkippedNote] = useState({ ambiguous: 0, functionWords: 0 })
  const [batchStates, setBatchStates] = useState<Map<number, BatchState>>(new Map())
  const [batchIdx, setBatchIdx] = useState(0)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [picked, setPicked] = useState<string | null>(null)
  const [credited, setCredited] = useState(0)
  const [stayedDue, setStayedDue] = useState(0)
  const [notWoven, setNotWoven] = useState(0)
  const [saveErrors, setSaveErrors] = useState(0)
  const [finishing, setFinishing] = useState(false)
  const [done, setDone] = useState(false)

  const tzRef = useRef(deviceTimeZone())
  const turnoverRef = useRef(0)
  const retMapRef = useRef<Map<string, number>>(new Map())
  const calMapRef = useRef<Map<string, number>>(new Map())
  const creditedRef = useRef<Set<string>>(new Set())
  const generatingRef = useRef<Set<number>>(new Set())
  const batchesRef = useRef<ExpressCandidate[][]>([])

  const stateRepo = useMemo(() => new SupabaseCardStateRepository(), [])
  const eventRepo = useMemo(() => new SupabaseReviewEventRepository(), [])

  function generateBatch(i: number) {
    const batch = batchesRef.current[i]
    if (!batch || generatingRef.current.has(i)) return
    generatingRef.current.add(i)
    setBatchStates(prev => new Map(prev).set(i, { status: 'loading' }))
    void (async () => {
      try {
        const res = await fetch(apiUrl('/api/story/generate'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            targets: storyTargets(batch),
            sourceLanguage: batch[0]!.card.sourceLanguage,
            targetLanguage: batch[0]!.card.targetLanguage,
            passage,
          }),
        })
        const data = await res.json() as { ok: boolean; story?: GeneratedStory; reason?: string }
        if (!data.ok || !data.story) throw new Error(data.reason ?? `generate-failed (HTTP ${res.status})`)
        const spans = locateTargets(data.story.story, data.story.usages, batch)
        setBatchStates(prev => new Map(prev).set(i, { status: 'ready', story: data.story, spans, glossStatus: passage === 'target' ? 'loading' : 'ready' }))
        // Tap-a-word glosses: fired in parallel, never blocking the read (that split is what made
        // stories fast — the Sonnet call now writes prose only).
        if (passage === 'target') void fetchGlosses(i, data.story!)
      } catch (err) {
        setBatchStates(prev => new Map(prev).set(i, { status: 'error', reason: err instanceof Error ? err.message : String(err) }))
      } finally {
        generatingRef.current.delete(i)
      }
    })()
  }

  function fetchGlosses(i: number, story: GeneratedStory) {
    const batch = batchesRef.current[i]
    if (!batch) return
    void (async () => {
      try {
        const res = await fetch(apiUrl('/api/story/generate'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            phase: 'gloss', story: story.story,
            targets: storyTargets(batch),
            sourceLanguage: batch[0]!.card.sourceLanguage,
            targetLanguage: batch[0]!.card.targetLanguage,
            passage,
          }),
        })
        const data = await res.json() as { ok: boolean; tokens?: { text: string; gloss: string }[] }
        if (!data.ok || !data.tokens) throw new Error('gloss-failed')
        const m = new Map<string, string>()
        for (const t of data.tokens) if (!m.has(t.text.toLowerCase())) m.set(t.text.toLowerCase(), t.gloss)
        setBatchStates(prev => {
          const cur = prev.get(i)
          return cur ? new Map(prev).set(i, { ...cur, glosses: m, glossStatus: 'ready' }) : prev
        })
      } catch {
        setBatchStates(prev => {
          const cur = prev.get(i)
          return cur ? new Map(prev).set(i, { ...cur, glossStatus: 'error' }) : prev
        })
      }
    })()
  }

  useEffect(() => {
    void (async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setLoading(false); return }
        const uid = session.user.id
        setUserId(uid)
        const cardRepo = new SupabaseCardRepository()
        const [profileRes, cards, states, paramRows, decks] = await Promise.all([
          supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', uid).maybeSingle(),
          cardRepo.listAllForUser(uid),
          stateRepo.listAllForUser(uid),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
          new SupabaseDeckRepository().list(uid),
        ])
        const tz = (profileRes.data?.timezone as string | null) ?? deviceTimeZone()
        const turnover = (profileRes.data?.day_turnover_hour as number | null) ?? 0
        tzRef.current = tz
        turnoverRef.current = turnover
        retMapRef.current = buildRetentionMap(paramRows)
        calMapRef.current = buildCalibrationMap(paramRows)
        const { pool, skippedAmbiguous, skippedFunctionWords } = buildStoryPool(cards, states, {
          source, target, tracksByPair: buildEnabledTracksMap(paramRows), tz, today: getToday(tz, turnover),
        })
        setSkippedNote({ ambiguous: skippedAmbiguous, functionWords: skippedFunctionWords })
        const deckIdByCard = await cardRepo.deckIdsByCard(decks.map(d => d.id))
        const built = batchStories(pool, deckIdByCard)
        batchesRef.current = built
        setBatches(built)
        // The first TWO stories generate in parallel — the cold start is the only wait a reader
        // ever feels, so halve it; later batches prefetch one ahead as usual.
        if (built.length > 0) generateBatch(0)
        if (built.length > 1) generateBatch(1)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load.')
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, target, passage, stateRepo])

  // Prefetch the NEXT story while this one is being read.
  useEffect(() => {
    if (batchStates.get(batchIdx)?.status === 'ready' && batchIdx + 1 < batches.length && !batchStates.has(batchIdx + 1)) {
      generateBatch(batchIdx + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchStates, batchIdx, batches.length])

  const batch = batches[batchIdx]
  const bs = batchStates.get(batchIdx)
  const cardById = useMemo(() => new Map((batch ?? []).map(c => [c.card.id, c])), [batch])
  const tokenGloss = bs?.glosses ?? new Map<string, string>()

  /** Credit everything located + unrevealed in this story, tally the rest, advance. */
  function finishStory() {
    if (!batch || !bs?.spans || !userId || finishing) return
    setFinishing(true)
    const located = new Set(bs.spans.map(s => s.cardId))
    let creditedHere = 0, stayed = 0, missing = 0
    for (const cand of batch) {
      if (!located.has(cand.card.id)) { missing++; continue }
      if (revealed.has(cand.card.id)) { stayed++; continue }
      if (creditedRef.current.has(cand.card.id)) continue
      creditedRef.current.add(cand.card.id)
      creditedHere++
      void creditExpressMatch({
        userId, card: cand.card, state: cand.state, now: new Date(),
        tz: tzRef.current, turnoverHour: turnoverRef.current,
        retMap: retMapRef.current, calMap: calMapRef.current,
        stateRepo, eventRepo,
      }).catch(err => {
        console.error('Story credit failed:', err)
        creditedRef.current.delete(cand.card.id)
        setSaveErrors(n => n + 1)
      })
    }
    setCredited(n => n + creditedHere)
    setStayedDue(n => n + stayed)
    setNotWoven(n => n + missing)
    setFinishing(false)
    setPicked(null)
    if (batchIdx + 1 < batches.length) setBatchIdx(batchIdx + 1)
    else setDone(true)
  }

  /** A plain (non-target) stretch of story text — tappable per word in target mode. */
  function renderPlain(text: string, keyBase: string) {
    if (passage === 'native') return <span key={keyBase}>{text}</span>
    return segmentWords(text).map((run, j) => run.isWord
      ? <button key={`${keyBase}-${j}`} type="button" onClick={() => setPicked(p => p === run.text ? null : run.text)}
          className={`rounded-sm transition-colors ${picked === run.text ? 'bg-accent/15 text-accent-soft' : 'hover:bg-accent/10'}`}>{run.text}</button>
      : <span key={`${keyBase}-${j}`}>{run.text}</span>)
  }

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading session…</div>
  if (loadError) return <p className="p-6 text-sm text-danger text-center">{loadError}</p>

  const pairQuery = source && target ? `&source=${source}&target=${target}` : ''
  const normalUrl = `/study/all/session?category=due&present=selfgraded&dir=reverse${pairQuery}`
  const skippedTotal = skippedNote.ambiguous + skippedNote.functionWords

  if (batches.length === 0) {
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-4">
        <h1 className="text-xl font-semibold text-ink">Nothing to read</h1>
        <p className="text-sm text-ink-muted">
          No due reverse cards can be story-reviewed right now.
          {skippedTotal > 0 && ` ${skippedTotal} stay in normal review (${[skippedNote.functionWords > 0 ? `${skippedNote.functionWords} function words` : null, skippedNote.ambiguous > 0 ? `${skippedNote.ambiguous} duplicate meanings` : null].filter(Boolean).join(', ')}).`}
        </p>
        <div className="flex justify-center gap-3">
          {skippedTotal > 0 && <button onClick={() => router.push(normalUrl)} className="btn-primary">Normal review</button>}
          <Link href="/study/today" className="btn-ghost">Back to Today</Link>
        </div>
      </div>
    )
  }

  if (done) {
    const rest = stayedDue + notWoven + skippedTotal
    return (
      <div className="max-w-md mx-auto pt-16 text-center space-y-4">
        <h1 className="text-xl font-semibold text-ink">Stories finished</h1>
        <p className="text-ink-muted text-sm">
          {credited} word{credited === 1 ? '' : 's'} credited as Good.
          {stayedDue > 0 && ` ${stayedDue} you peeked at stay due.`}
          {notWoven > 0 && ` ${notWoven} couldn't be woven in and stay due.`}
          {skippedTotal > 0 && ` ${skippedTotal} never entered (function words / duplicates).`}
        </p>
        {saveErrors > 0 && <p className="text-xs text-danger">{saveErrors} credit{saveErrors === 1 ? '' : 's'} failed to save — those cards stay due.</p>}
        <div className="flex justify-center gap-3">
          {rest > 0 && <button onClick={() => router.push(normalUrl)} className="btn-primary">Review the rest ({rest})</button>}
          <Link href="/study/today" className="btn-ghost">Back to Today</Link>
        </div>
      </div>
    )
  }

  // ── Reading view ──
  const spans = bs?.spans ?? []
  const story = bs?.story
  const locatedUnrevealed = spans.filter(s => !revealed.has(s.cardId)).length
  const segments: React.ReactNode[] = []
  if (story) {
    let cursor = 0
    spans.forEach((sp, i) => {
      if (sp.start > cursor) segments.push(renderPlain(story.story.slice(cursor, sp.start), `p${i}`))
      const cand = cardById.get(sp.cardId)
      const isRevealed = revealed.has(sp.cardId)
      segments.push(
        <button key={`t${i}`} type="button"
          onClick={() => setRevealed(prev => { const n = new Set(prev); n.add(sp.cardId); return n })}
          title={isRevealed ? undefined : 'Tap to reveal the meaning — the card then stays due'}
          className={`rounded px-0.5 font-medium transition-colors ${isRevealed
            ? 'bg-warning/15 text-warning'
            : 'bg-accent/15 text-accent-soft hover:bg-accent/25'}`}>
          {sp.surface}{isRevealed && cand && <span className="font-normal text-xs"> ({displayText(cand.card.back)})</span>}
        </button>,
      )
      cursor = sp.end
    })
    segments.push(renderPlain(story.story.slice(cursor), 'tail'))
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5 pb-12">
      <div className="flex items-center justify-between gap-3">
        <Link href="/study/today" className="text-sm text-ink-muted hover:text-ink">✕ End session</Link>
        <span className="text-xs text-ink-muted">Story {batchIdx + 1} / {batches.length}</span>
        <span className="text-xs text-ink-faint">{passage === 'native' ? 'Targets only in language' : 'Full passage'}</span>
      </div>

      {bs?.status === 'loading' && (
        <div className="panel text-center py-16 space-y-2">
          <p className="text-ink">Writing story {batchIdx + 1}…</p>
          <p className="text-xs text-ink-faint">{batch?.length ?? 0} due words are being woven in.</p>
        </div>
      )}
      {bs?.status === 'error' && (
        <div className="panel text-center py-12 space-y-3">
          <p className="text-sm text-danger">This story failed to generate{bs.reason ? ` (${bs.reason})` : ''}.</p>
          <div className="flex justify-center gap-3">
            <button className="btn-primary text-sm" onClick={() => generateBatch(batchIdx)}>Try again</button>
            <button className="btn-ghost text-sm" onClick={() => batchIdx + 1 < batches.length ? setBatchIdx(batchIdx + 1) : setDone(true)}>Skip story</button>
          </div>
        </div>
      )}

      {bs?.status === 'ready' && story && (
        <>
          <div className="panel space-y-4">
            {story.title && <h1 className="text-lg font-semibold text-ink">{story.title}</h1>}
            <p className="text-[17px] leading-[1.9] text-ink whitespace-pre-wrap">{segments}</p>
            {picked && passage === 'target' && (
              <p className="text-sm border-t border-line/10 pt-3">
                <span className="text-ink font-medium">{picked}</span>
                {tokenGloss.get(picked.toLowerCase())
                  ? <span className="text-ink-muted"> — {tokenGloss.get(picked.toLowerCase())}</span>
                  : bs?.glossStatus === 'loading'
                    ? <span className="text-ink-faint"> — translating…</span>
                    : <span className="text-ink-faint"> — no translation available</span>}
              </p>
            )}
          </div>
          <p className="text-xs text-ink-faint text-center">
            Highlighted words are your due cards — read past the ones you understood, tap any you'd have missed.
            {spans.length < (batch?.length ?? 0) && ` ${(batch?.length ?? 0) - spans.length} of this batch couldn't be woven in and stay due.`}
          </p>
          <div className="flex justify-center">
            <button className="btn-primary px-8" disabled={finishing} onClick={finishStory}>
              {batchIdx + 1 < batches.length ? 'Next story' : 'Finish'} — credit {locatedUnrevealed} as Good
            </button>
          </div>
        </>
      )}
    </div>
  )
}
