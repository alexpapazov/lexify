'use client'

/**
 * /study/due — Due Now as a PROGRAM you build (Due Now Redesign Part 2, design concluded
 * 2026-11-20; math in engine/program.ts, writes in lib/program.ts).
 *
 * BATCHES: one row per language pair × direction with its due count. BUILDER: pick a preset
 * or compose an ordered chain of stages (Matching / Cloze / Active recall / Typed recall).
 * RUNNER: the batch moves stage by stage — matching in chunked rounds, the graded stages one
 * card at a time; a miss replays in-stage (never ejects to another exercise). Clearing the
 * FINAL stage credits immediately (real FSRS review, growth capped by that stage's strength);
 * intermediate progress persists on the day's program row and pays out its grow-only boost at
 * day turnover (lazy finalization on the next open), or right away via "Lock in".
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseUserSchedulerParamsRepository, type SchedulerParamsRow } from '@/lib/data/userSchedulerParams'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import { SupabaseReviewProgramRepository, type ReviewProgram } from '@/lib/data/reviewPrograms'
import { hydrateSessionAudio, applyAudioPatch } from '@/lib/sessionAudio'
import { apiUrl } from '@/lib/apiBase'
import { buildCalibrationMap, buildEnabledTracksMap, buildRetentionMap, type EnabledTracks } from '@/lib/sessionLimits'
import { buildProgramBatches, nextMatchingChunk, type ProgramBatch, type ProgramWord } from '@/lib/programPool'
import { boostRow, creditRow, finalizeStalePrograms, openProgramsForToday, splitStates, type ProgramDeps } from '@/lib/program'
import { earnedStrength, finalStageRating, stagesForDirection, STAGE_LABEL, STAGE_STRENGTH, type StageKind, type WordProgress } from '@/engine/program'
import { MatchingGame, type MatchPair } from '@/components/practice/MatchingGame'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { TypingMode } from '@/components/session/TypingMode'
import { resolveReviewCloze, clozeEligible, clozeStrictness, type ReviewCloze } from '@/lib/reviewCloze'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { isOfflineActive } from '@/lib/offline/mode'
import { getToday } from '@/lib/dates'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { displayText } from '@/lib/cardText'
import { langFlag, langName } from '@/lib/languages'
import { speak } from '@/lib/speak'
import { DEFAULT_GRADING_SETTINGS, DEFAULT_TYPED_STRICTNESS } from '@/domain'
import type { Card, Rating, TypedStrictness } from '@/domain'

const PRESETS: Record<'production' | 'recognition', { name: string; stages: StageKind[] }[]> = {
  production: [
    { name: 'Busy day',  stages: ['matching'] },
    { name: 'Standard',  stages: ['matching', 'recall'] },
    { name: 'Deep',      stages: ['matching', 'cloze', 'typed'] },
  ],
  recognition: [
    { name: 'Busy day',  stages: ['matching'] },
    { name: 'Standard',  stages: ['matching', 'recall'] },
  ],
}

const dirLabel = (b: { src: string; tgt: string; direction: 'production' | 'recognition' }) =>
  b.direction === 'production'
    ? `${langName(b.tgt)} → ${langName(b.src)} · production`
    : `${langName(b.src)} → ${langName(b.tgt)} · recognition`

export default function DuePage() {
  const offline = useOfflineMode()
  if (offline) return <OfflineUnavailable feature="Due programs" />
  return <DueInner />
}

function DueInner() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [userId, setUserId] = useState('')
  const [batches, setBatches] = useState<ProgramBatch[]>([])
  const [todayPrograms, setTodayPrograms] = useState<Map<string, ReviewProgram>>(new Map())
  const [view, setView] = useState<'batches' | 'builder' | 'run'>('batches')
  const [batch, setBatch] = useState<ProgramBatch | null>(null)
  const [draft, setDraft] = useState<StageKind[]>([])
  const [program, setProgram] = useState<ReviewProgram | null>(null)
  const [progress, setProgress] = useState<Record<string, WordProgress>>({})
  const [progressV, setProgressV] = useState(0)

  const todayRef = useRef('')
  const tracksRef = useRef<Map<string, EnabledTracks>>(new Map())
  const retMapRef = useRef<Map<string, number>>(new Map())
  const calMapRef = useRef<Map<string, number>>(new Map())
  const paramRowsRef = useRef<SchedulerParamsRow[]>([])
  /** Persisted typed-answer overrides, `${cardId}:${side}` → normalized texts — same map the
   *  session pages feed TypingMode. */
  const overridesRef = useRef<Map<string, Set<string>>>(new Map())
  const stateRepo = useMemo(() => new SupabaseCardStateRepository(), [])
  const programRepo = useMemo(() => new SupabaseReviewProgramRepository(), [])
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const progressRef = useRef<Record<string, WordProgress>>({})

  /** The run's cards re-read with SESSION columns (full `choices`, synonyms, cloze sentences;
   *  bulk cards must NEVER reach anything that writes `choices` back) + audio patched in. */
  const [sessionCards, setSessionCards] = useState<Map<string, Card>>(new Map())
  // The same per-review chrome the session pages have: IPA toggle + hint tracking.
  const [showIPA, setShowIPA] = useState(false)
  const [ipaCache, setIpaCache] = useState<Map<string, string>>(new Map())
  const hintGFRef = useRef<number | null>(null)

  /** Per-pair typed strictness off the forward_typed row — exactly what sessions use. */
  const strictFor = (src: string, tgt: string): TypedStrictness => {
    const row = paramRowsRef.current.find(r => r.sourceLanguage === src && r.targetLanguage === tgt && r.answerField === 'forward_typed')
    return row
      ? { spelling: row.strictSpelling, accents: row.strictAccents, articles: row.strictArticles }
      : DEFAULT_TYPED_STRICTNESS
  }

  useEffect(() => {
    void (async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.push('/auth'); return }
        const uid = session.user.id
        setUserId(uid)
        const profile = await supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', uid).maybeSingle()
          .then(r => r.data as { timezone: string | null; day_turnover_hour: number | null } | null, () => null)
        const tz = profile?.timezone ?? deviceTimeZone()
        const turnover = profile?.day_turnover_hour ?? 0
        todayRef.current = getToday(tz, turnover)

        // Yesterday's unfinished programs pay out their boosts BEFORE today's batches build.
        await finalizeStalePrograms(uid, tz, turnover)

        const [cards, states, paramRows, open, overrideRows] = await Promise.all([
          new SupabaseCardRepository().listAllForUser(uid),
          stateRepo.listAllForUser(uid),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid).catch(() => []),
          openProgramsForToday(uid, todayRef.current),
          new SupabaseTypedAnswerOverrideRepository().listForUser(uid).catch(() => []),
        ])
        const ov = new Map<string, Set<string>>()
        for (const o of overrideRows) {
          const key = `${o.cardId}:${o.answerSide}`
          if (!ov.has(key)) ov.set(key, new Set())
          ov.get(key)!.add(o.answerText)
        }
        overridesRef.current = ov
        paramRowsRef.current = paramRows
        tracksRef.current = buildEnabledTracksMap(paramRows)
        retMapRef.current = buildRetentionMap(paramRows)
        calMapRef.current = buildCalibrationMap(paramRows)
        const split = splitStates(states)
        setBatches(buildProgramBatches(cards, split.forward, split.reverse, tracksRef.current, new Date()))
        setTodayPrograms(open)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [router, stateRepo])

  const deps = (): ProgramDeps => ({
    userId, src: batch!.src, tgt: batch!.tgt, now: new Date(),
    tracks: tracksRef.current.get(`${batch!.src}|${batch!.tgt}`),
    retMap: retMapRef.current, calMap: calMapRef.current,
  })

  function openBuilder(b: ProgramBatch) {
    setBatch(b)
    const existing = todayPrograms.get(b.key)
    if (existing && Object.values(existing.progress).some(p => p.cleared > 0 || p.done)) {
      // A program already ran today — continue it as-is rather than re-opening the builder.
      startRun(b, existing)
      return
    }
    setDraft(existing?.stages ?? PRESETS[b.direction][1]?.stages ?? ['matching'])
    setView('builder')
  }

  function startRun(b: ProgramBatch, prog: ReviewProgram) {
    setBatch(b)
    setProgram(prog)
    progressRef.current = { ...prog.progress }
    setProgress(progressRef.current)
    setProgressV(v => v + 1)
    setView('run')
    void loadSessionCards(b)
  }

  /** Re-reads the batch's cards with SESSION columns (full choices, synonyms, sentences).
   *  Bulk cards stay only as placeholders until this lands; anything that writes `choices`
   *  back (cloze generation) waits for it. */
  async function loadSessionCards(b: ProgramBatch) {
    try {
      const cards = await new SupabaseCardRepository().listSessionByIds(b.words.map(w => w.card.id))
      setSessionCards(new Map(cards.map(c => [c.id, c])))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleStart() {
    if (!batch || draft.length === 0) return
    try {
      const row = await programRepo.open(userId, {
        sourceLanguage: batch.src, targetLanguage: batch.tgt,
        direction: batch.direction, day: todayRef.current, stages: draft,
      })
      setTodayPrograms(prev => new Map(prev).set(batch.key, row))
      startRun(batch, { ...row, stages: draft })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function persistProgress() {
    const id = program?.id
    if (!id) return
    const snapshot = { ...progressRef.current }
    saveQueueRef.current = saveQueueRef.current
      .then(() => programRepo.saveProgress(id, snapshot))
      .catch(err => console.error('[program] progress save failed:', err))
  }

  function updateProgress(cardId: string, patch: WordProgress) {
    progressRef.current = { ...progressRef.current, [cardId]: patch }
    setProgress(progressRef.current)
    setProgressV(v => v + 1)
    persistProgress()
  }

  const prog = (cardId: string): WordProgress => progress[cardId] ?? { cleared: 0 }

  // ── Runner derivations ──────────────────────────────────────────────────
  const stages = program?.stages ?? []
  const pool: ProgramWord[] = useMemo(
    () => (batch ? batch.words : []),
    [batch],
  )
  const remaining = pool.filter(w => !prog(w.card.id).done)
  const stageIdx = remaining.length > 0
    ? Math.min(stages.length - 1, Math.min(...remaining.map(w => prog(w.card.id).cleared)))
    : 0
  const stageKind: StageKind | undefined = stages[stageIdx]
  const active = remaining.filter(w => prog(w.card.id).cleared === stageIdx)
  const isFinalStage = stageIdx === stages.length - 1

  /** Clears the current stage for a word; the final stage writes the real review (a hint used
   *  on the clearing answer dampens the growth, same as sessions). */
  function clearWord(word: ProgramWord, rating: Rating | null, hintGrowthFactor?: number | null) {
    const id = word.card.id
    const cleared = Math.max(prog(id).cleared, stageIdx + 1)
    if (cleared >= stages.length) {
      const final = stages[stages.length - 1]!
      const updated = creditRow(word.state, batch!.direction, finalStageRating(final, rating), STAGE_STRENGTH[final], deps(),
        hintGrowthFactor != null ? { hintGrowthFactor } : {})
      saveQueueRef.current = saveQueueRef.current
        .then(() => stateRepo.upsert(updated).then(() => undefined))
        .catch(err => console.error('[program] credit failed:', err))
      updateProgress(id, { cleared, done: 'credited' })
    } else {
      updateProgress(id, { cleared })
    }
  }

  /** Cashes out every progressed word's current boost now (the "too tired" button). */
  async function lockInNow() {
    if (!batch || !program) return
    const d = deps()
    const rows = []
    const ids: string[] = []
    for (const w of remaining) {
      const p = prog(w.card.id)
      if (p.cleared <= 0) continue
      rows.push(boostRow(w.state, batch.direction, earnedStrength(stages, p.cleared), d))
      ids.push(w.card.id)
    }
    if (rows.length === 0) return
    try {
      await stateRepo.upsertBatch(rows)
      for (const id of ids) updateProgress(id, { ...prog(id), done: 'locked' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Matching stage state ────────────────────────────────────────────────
  // A missed/?-marked pair does NOT clear in its round — it stays active and the next rounds
  // mix it back in (an even share per remaining round, lib/programPool.nextMatchingChunk),
  // never one clumped redo round (user decision 2026-11-20). Rounds advance on the finish
  // button; a round of nothing-but-misses is simply what's left at the end.
  const [matchChunk, setMatchChunk] = useState<ProgramWord[] | null>(null)
  const dirtyRef = useRef<Set<string>>(new Set())          // this round's misses (no credit)
  const missedStageRef = useRef<Set<string>>(new Set())    // the stage's misses (redistribute)
  const matchStageRef = useRef(-1)
  useEffect(() => {
    if (view !== 'run' || stageKind !== 'matching') { matchStageRef.current = -1; setMatchChunk(null); return }
    const stageChanged = matchStageRef.current !== stageIdx
    if (stageChanged) {
      matchStageRef.current = stageIdx
      missedStageRef.current = new Set()
    }
    if (!stageChanged && matchChunk) return
    const fresh = active.filter(w => !missedStageRef.current.has(w.card.id))
    const retry = active.filter(w => missedStageRef.current.has(w.card.id))
    dirtyRef.current = new Set()
    setMatchChunk(nextMatchingChunk(fresh, retry))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, stageKind, stageIdx, matchChunk, progressV])

  // ── Card-stage queue (cloze / recall / typed) ───────────────────────────
  const [queue, setQueue] = useState<string[]>([])
  const [attempt, setAttempt] = useState(0)   // bumps on every replay so the card remounts blank
  const stageKeyRef = useRef('')
  useEffect(() => {
    if (view !== 'run' || !stageKind || stageKind === 'matching') { stageKeyRef.current = ''; return }
    const key = `${program?.id}:${stageIdx}`
    if (stageKeyRef.current === key) return
    stageKeyRef.current = key
    setQueue(active.map(w => w.card.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, stageKind, stageIdx, program, progressV])

  // Cloze prefetch for the next few queued cards (stored sentence or one generation).
  // STRICTLY session cards only: resolveReviewCloze persists onto card.choices, and a bulk
  // card's null choices would clobber the stored distractors/synonyms/sentences.
  const [clozeByCard, setClozeByCard] = useState<Map<string, ReviewCloze | null>>(new Map())
  const clozeInFlight = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (view !== 'run' || stageKind !== 'cloze') return
    for (const id of queue.slice(0, 3)) {
      const sc = sessionCards.get(id)
      if (!sc || clozeByCard.has(id) || clozeInFlight.current.has(id) || !clozeEligible(sc)) continue
      clozeInFlight.current.add(id)
      void resolveReviewCloze(sc, { allowGenerate: !isOfflineActive() })
        .then(cz => setClozeByCard(prev => new Map(prev).set(id, cz)))
        .catch(() => setClozeByCard(prev => new Map(prev).set(id, null)))
        .finally(() => clozeInFlight.current.delete(id))
    }
  }, [view, stageKind, queue, sessionCards, clozeByCard])

  // Stored audio clips for the next few cards (SESSION columns exclude the blobs). Playback
  // without a clip would fall back to regenerating TTS — hydration keeps real recordings.
  useEffect(() => {
    if (view !== 'run' || !stageKind || stageKind === 'matching') return
    const targets = queue.slice(0, 3).map(id => sessionCards.get(id)).filter((c): c is Card => !!c)
    if (targets.length === 0) return
    void hydrateSessionAudio(targets, patch => setSessionCards(prev => {
      const next = new Map(prev)
      for (const c of targets) next.set(c.id, applyAudioPatch(next.get(c.id) ?? c, patch))
      return next
    }))
  }, [view, stageKind, queue, sessionCards])

  // IPA for the current card when the prompt shows the target word (recognition direction) —
  // same transcribe-once-and-store behavior as sessions.
  const currentCardId = queue.find(id => { const p = prog(id); return p.cleared === stageIdx && !p.done })
  useEffect(() => {
    if (view !== 'run' || !batch || batch.direction !== 'recognition' || !currentCardId) return
    const sc = sessionCards.get(currentCardId)
    if (!sc || sc.ipa || ipaCache.has(sc.id)) return
    fetch(apiUrl('/api/ipa'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: sc.front, language: sc.sourceLanguage }),
    })
      .then(r => r.json())
      .then((d: { ok: boolean; ipa?: string }) => {
        if (!d.ok || !d.ipa) return
        setIpaCache(prev => new Map(prev).set(sc.id, d.ipa!))
        new SupabaseCardRepository().update(sc.id, { ipa: d.ipa }).catch(() => {})
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, batch, currentCardId, sessionCards])

  // ── Views ───────────────────────────────────────────────────────────────
  if (loading) return <div className="max-w-2xl mx-auto pt-24 text-center text-ink-muted text-sm">Loading…</div>

  if (view === 'builder' && batch) {
    const strength = draft.length > 0 ? earnedStrength(draft, draft.length) : 0
    const palette = stagesForDirection(batch.direction)
    return (
      <div className="max-w-2xl mx-auto space-y-5 pb-16">
        <button onClick={() => setView('batches')} className="text-sm text-ink-muted hover:text-ink">← Back</button>
        <h1 className="text-xl font-semibold text-ink">{langFlag(batch.src)} {dirLabel(batch)}</h1>
        <p className="text-sm text-ink-muted">{batch.words.length} due — build today&apos;s program. A word clears each stage once (misses replay in-stage); the final stage schedules it.</p>
        <div className="panel space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs text-ink-faint">Presets:</p>
            <div className="flex gap-1.5 flex-wrap">
              {PRESETS[batch.direction].map(p => (
                <button key={p.name} onClick={() => setDraft(p.stages)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${JSON.stringify(p.stages) === JSON.stringify(draft) ? 'border-accent/50 bg-accent/10 text-ink' : 'border-line/10 text-ink-muted hover:text-ink'}`}>
                  {p.name} <span className="text-xs text-ink-faint">({p.stages.map(s => STAGE_LABEL[s]).join(' → ')})</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs text-ink-faint">Or build your own — tap stages in order:</p>
            <div className="flex gap-1.5 flex-wrap">
              {palette.map(s => (
                <button key={s} onClick={() => setDraft(d => d.includes(s) ? d : [...d, s])}
                  disabled={draft.includes(s)}
                  className="rounded-lg border border-line/10 px-3 py-1.5 text-sm text-ink-muted hover:text-ink disabled:opacity-40">
                  + {STAGE_LABEL[s]}
                </button>
              ))}
              {draft.length > 0 && (
                <button onClick={() => setDraft([])} className="text-xs text-danger hover:underline">clear</button>
              )}
            </div>
            {draft.length > 0 && (
              <p className="text-sm text-ink">{draft.map(s => STAGE_LABEL[s]).join(' → ')}</p>
            )}
          </div>
          <p className="text-xs text-ink-muted">
            Completing every stage credits <span className="text-ink font-medium">{Math.round(strength * 100)}%</span> of a full review&apos;s interval growth.
            {strength < 1 && ' Lighter programs keep you current — the words just come back a bit sooner.'}
            {' '}Quitting midway keeps each word&apos;s highest cleared stage: its smaller boost applies automatically at day turnover.
          </p>
          {error && <p className="text-danger text-xs">⚠ {error}</p>}
          <button onClick={() => void handleStart()} disabled={draft.length === 0} className="btn-primary w-full">
            Start ({batch.words.length} words)
          </button>
        </div>
      </div>
    )
  }

  if (view === 'run' && batch && program) {
    const credited = pool.filter(w => prog(w.card.id).done === 'credited').length
    const locked   = pool.filter(w => prog(w.card.id).done === 'locked').length
    const lockable = remaining.filter(w => prog(w.card.id).cleared > 0).length

    if (remaining.length === 0) {
      return (
        <div className="max-w-md mx-auto pt-16 space-y-4 text-center">
          <h1 className="text-2xl font-semibold text-ink">Program complete</h1>
          <p className="text-ink-muted text-sm">
            {credited > 0 && `${credited} word${credited !== 1 ? 's' : ''} credited (${Math.round(earnedStrength(stages, stages.length) * 100)}% growth).`}
            {locked > 0 && ` ${locked} locked in at their earned boost.`}
          </p>
          <button onClick={() => { setView('batches'); window.location.reload() }} className="btn-primary">Back to Due</button>
        </div>
      )
    }

    const header = (
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button onClick={() => setView('batches')} className="text-sm text-ink-muted hover:text-ink">← Due{lockable > 0 ? ' (progress saved)' : ''}</button>
        <span className="text-xs text-ink-muted">
          {langFlag(batch.src)} {dirLabel(batch)} · stage {stageIdx + 1}/{stages.length}: {stageKind ? STAGE_LABEL[stageKind] : ''} · {remaining.length} left
        </span>
        {lockable > 0 && stages.length > 1 && (
          <button onClick={() => void lockInNow()} className="text-xs text-accent-soft hover:text-accent" title="Apply every started word's current boost now and finish">
            Lock in progress ({lockable})
          </button>
        )}
      </div>
    )

    if (stageKind === 'matching') {
      if (!matchChunk || matchChunk.length === 0) {
        return <div className="space-y-6 pb-12">{header}<p className="text-sm text-ink-muted text-center pt-8">Preparing round…</p></div>
      }
      const pairs: MatchPair[] = matchChunk.map(w => ({ id: w.card.id, front: displayText(w.card.front), back: displayText(w.card.back) }))
      return (
        <div className="space-y-6 pb-12">
          {header}
          <MatchingGame
            key={`${program.id}-${stageIdx}-${matchChunk[0]!.card.id}`}
            pairs={pairs}
            onExit={() => setView('batches')}
            onSpeakTarget={p => {
              const w = matchChunk.find(x => x.card.id === p.id)
              if (w) speak(w.card.front, w.card.sourceLanguage)
            }}
            onAttempt={a => {
              if (!a.correct) {
                // No credit this round; the pair redistributes into the upcoming rounds.
                dirtyRef.current.add(a.pair.id)
                missedStageRef.current.add(a.pair.id)
                if (a.confused) {
                  dirtyRef.current.add(a.confused.id)
                  missedStageRef.current.add(a.confused.id)
                }
                return
              }
              if (dirtyRef.current.has(a.pair.id)) return
              const w = matchChunk.find(x => x.card.id === a.pair.id)
              if (w && prog(w.card.id).cleared === stageIdx) clearWord(w, 'good')
            }}
            renderFinish={() => {
              const missedHere = matchChunk.filter(w => prog(w.card.id).cleared === stageIdx && !prog(w.card.id).done).length
              return (
                <div className="max-w-md mx-auto pt-10 space-y-4 text-center">
                  <p className="text-ink text-sm">
                    Round done.{missedHere > 0 ? ` ${missedHere} missed — they'll come back mixed into the next rounds.` : ''}
                  </p>
                  <button onClick={() => setMatchChunk(null)} className="btn-primary">
                    {active.length > 0 ? 'Next round' : isFinalStage ? 'Finish' : 'Next stage'}
                  </button>
                </div>
              )
            }}
          />
        </div>
      )
    }

    // Card stages — one at a time; Again replays at the end of the stage queue.
    const word = currentCardId ? pool.find(w => w.card.id === currentCardId) : undefined
    // The SESSION-column copy carries choices (synonyms, stored sentences, overrides targets)
    // and hydrated audio — the bulk placeholder must never reach the review components.
    const card = word ? sessionCards.get(word.card.id) : undefined
    if (!word || !card) {
      return <div className="space-y-6 pb-12">{header}<p className="text-sm text-ink-muted text-center pt-8">Loading…</p></div>
    }
    const promptSide = batch.direction === 'production' ? 'back' as const : 'front' as const
    const answerSide = promptSide === 'back' ? 'front' as const : 'back' as const
    const promptLanguage = promptSide === 'front' ? card.sourceLanguage : undefined
    const pairStrict = strictFor(batch.src, batch.tgt)
    const gsWithLang = { ...DEFAULT_GRADING_SETTINGS, answerLanguage: answerSide === 'front' ? batch.src : batch.tgt }
    const currentIpaText = showIPA && promptSide === 'front' ? (ipaCache.get(card.id) ?? card.ipa ?? undefined) : undefined
    const ipaToggle = promptSide === 'front' ? () => setShowIPA(v => !v) : undefined
    const onRate = (rating: Rating, wasCorrect = rating !== 'again') => {
      const hintGF = hintGFRef.current
      hintGFRef.current = null
      setAttempt(a => a + 1)
      // The session rule: a hinted Hard wasn't a cold recall — it replays instead of clearing.
      if (!wasCorrect || rating === 'again' || (rating === 'hard' && hintGF != null)) {
        setQueue(q => [...q.filter(id => id !== word.card.id), word.card.id])   // replay in-stage
      } else {
        clearWord(word, rating, hintGF)
        setQueue(q => q.filter(id => id !== word.card.id))
      }
    }
    return (
      <div className="space-y-6 pb-12">
        {header}
        {stageKind === 'typed' || stageKind === 'cloze' ? (
          // Cloze is TYPED production (user decision 2026-11-20): the sentence's blank is the
          // prompt and the word is typed into the usual grader. Articles auto-accept in cloze —
          // the sentence's own article sits visibly before the blank.
          <TypingMode
            key={`${card.id}-${stageIdx}-${attempt}`}
            card={card}
            promptSide={promptSide}
            promptLanguage={promptLanguage}
            cloze={stageKind === 'cloze' ? clozeByCard.get(card.id) || undefined : undefined}
            strictness={stageKind === 'cloze' ? clozeStrictness(pairStrict) : pairStrict}
            gradingSettings={gsWithLang}
            gradedReview={true}
            answerLanguage={answerSide === 'front' ? batch.src : batch.tgt}
            synonyms={answerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
            onAddSynonym={answerSide === 'front' ? (normalizedText) => {
              // Same write as sessions: append to the SESSION card's choices (full copy — never
              // the bulk placeholder) and persist; the local map keeps the next render honest.
              const choices = card.choices ?? { front: [], back: [] }
              const updated = { ...choices, frontSynonyms: [...(choices.frontSynonyms ?? []), normalizedText] }
              new SupabaseCardRepository().update(card.id, { choices: updated }).catch(err => console.error('Failed to save synonym:', err))
              setSessionCards(prev => new Map(prev).set(card.id, { ...card, choices: updated }))
            } : undefined}
            overrideAnswers={Array.from(overridesRef.current.get(`${card.id}:${answerSide}`) ?? [])}
            onOverrideAnswer={(answerText, accept) => {
              const key = `${card.id}:${answerSide}`
              const set = overridesRef.current.get(key) ?? new Set<string>()
              if (accept) set.add(answerText); else set.delete(answerText)
              overridesRef.current.set(key, set)
              void new SupabaseTypedAnswerOverrideRepository()[accept ? 'add' : 'remove'](userId, card.id, answerSide, answerText).catch(console.error)
            }}
            hintable
            onHint={(_level, growthFactor) => { hintGFRef.current = growthFactor }}
            onIDontKnow={() => onRate('again', false)}
            autoPlayAudio
            ipaText={currentIpaText} onToggleIPA={ipaToggle}
            onRate={(r, wasCorrect) => onRate(r, wasCorrect)}
          />
        ) : (
          <FlashcardMode
            key={`${card.id}-${stageIdx}-${attempt}`}
            card={card}
            promptSide={promptSide}
            promptLanguage={promptLanguage}
            answerLanguage={answerSide === 'front' ? batch.src : batch.tgt}
            hintable
            onHint={(_level, growthFactor) => { hintGFRef.current = growthFactor }}
            autoPlayAudio
            ipaText={currentIpaText} onToggleIPA={ipaToggle}
            onRate={r => onRate(r)}
          />
        )}
      </div>
    )
  }

  // ── Batches ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto space-y-5 pb-16">
      <div className="flex items-center justify-between gap-3">
        <Link href="/study" className="text-sm text-ink-muted hover:text-ink">← Study</Link>
      </div>
      <h1 className="text-xl font-semibold text-ink">Due now</h1>
      <p className="text-sm text-ink-muted">Pick a batch and build today&apos;s review out of exercise stages — a light program on a busy day still counts.</p>
      {error && <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">⚠ {error}</p>}
      {batches.length === 0 ? (
        <div className="panel text-ink-muted text-sm text-center py-10">Nothing due right now.</div>
      ) : (
        <div className="panel divide-y divide-line/5 p-0 overflow-hidden">
          {batches.map(b => {
            const open = todayPrograms.get(b.key)
            const inProgress = open && b.words.some(w => {
              const p = open.progress[w.card.id]
              return p && p.cleared > 0 && !p.done
            })
            return (
              <div key={b.key} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink font-medium">{langFlag(b.src)} {dirLabel(b)}</div>
                  <div className="text-xs text-ink-muted">
                    {b.words.length} due
                    {inProgress && open ? ` · in progress (${open.stages.map(s => STAGE_LABEL[s]).join(' → ')})` : ''}
                    {b.relearning > 0 && (
                      <>
                        {' · '}
                        <Link
                          className="text-accent-soft hover:text-accent"
                          href={`/study/all/session?category=due&source=${b.src}&target=${b.tgt}`}
                          title="Relearn-loop cards finish in a normal session"
                        >{b.relearning} relearning →</Link>
                      </>
                    )}
                  </div>
                </div>
                {b.words.length > 0 && (
                  <button onClick={() => openBuilder(b)} className="btn-primary text-sm shrink-0">
                    {inProgress ? 'Continue' : 'Start'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
