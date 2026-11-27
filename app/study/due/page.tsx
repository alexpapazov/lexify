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
import { boostRow, creditRow, relearnReview, finalizeStalePrograms, openProgramsForToday, rowInterval, splitStates, type ProgramDeps } from '@/lib/program'
import { earnedStrength, finalStageRating, stagesForDirection, STAGE_LABEL, STAGE_STRENGTH, type StageKind, type WordProgress } from '@/engine/program'
import { initialCardState } from '@/engine/pipeline'
import { MatchingGame, type MatchPair } from '@/components/practice/MatchingGame'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { TypingMode } from '@/components/session/TypingMode'
import { CardEditModal } from '@/components/CardEditModal'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { nextDifficulty } from '@/engine/fsrs'
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
import type { Card, CardState, Deck, Rating, TypedStrictness } from '@/domain'

const PRESETS: Record<'production' | 'recognition', { name: string; stages: StageKind[] }[]> = {
  production: [
    { name: 'Busy day',  stages: ['matching'] },
    { name: 'Standard',  stages: ['matching', 'cloze'] },
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
  /** Batch row expanded on the picker — shows the batch's words with star toggles. */
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
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
  // The same per-review chrome the session pages have: IPA toggle + hint tracking + the ℹ modal.
  const [showIPA, setShowIPA] = useState(false)
  const [ipaCache, setIpaCache] = useState<Map<string, string>>(new Map())
  const [infoOpen, setInfoOpen] = useState(false)
  /** ℹ pressed on a matching tile — opens the same CardEditModal for that pair's card. */
  const [matchInfoId, setMatchInfoId] = useState<string | null>(null)
  const hintGFRef = useRef<number | null>(null)
  /** Settings → Audio → "Auto-play audio in Study mode" (profiles.study_mode_autoplay). Off =
   *  the whole runner is silent — no autoplay, no submit-speak, no matching tile audio — so
   *  studying never interrupts the learner's music. Listen buttons still work on request. */
  const autoplayGlobalRef = useRef(true)
  /** Settings → Due Now → "Relearning cards" (profiles.relearn_cloze, migration 135). On =
   *  a production-direction relearn review presents as a CLOZE (word blanked out of a
   *  sentence) instead of the plain typed prompt; falls back to plain when no cloze resolves. */
  const relearnClozeRef = useRef(true)
  /** Each card's deck — the source of its GRADING SETTINGS (the session pages grade with the
   *  deck's settings; defaults silently broke accent acceptance, user report 2026-11-20),
   *  deck name, and the ℹ modal's deck context. */
  const cardDeckRef = useRef<Map<string, Deck>>(new Map())
  /** Forward rows by card — the ℹ modal's `state` prop (recognition batches carry reverse rows). */
  const forwardRef = useRef<Map<string, CardState>>(new Map())

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
        // relearn_cloze rides a SEPARATE select: a missing column (migration 135 not yet
        // applied) nulls the whole combined read, silently resetting tz/turnover — the known
        // profiles-select landmine.
        const [profile, relearnCloze] = await Promise.all([
          supabase.from('profiles').select('timezone, day_turnover_hour, study_mode_autoplay').eq('user_id', uid).maybeSingle()
            .then(r => r.data as { timezone: string | null; day_turnover_hour: number | null; study_mode_autoplay: boolean | null } | null, () => null),
          supabase.from('profiles').select('relearn_cloze').eq('user_id', uid).maybeSingle()
            .then(r => (r.data as { relearn_cloze: boolean | null } | null)?.relearn_cloze ?? true, () => true),
        ])
        const tz = profile?.timezone ?? deviceTimeZone()
        const turnover = profile?.day_turnover_hour ?? 0
        autoplayGlobalRef.current = profile?.study_mode_autoplay ?? true
        relearnClozeRef.current = relearnCloze
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
        forwardRef.current = split.forward
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

  /** Re-open the BUILDER for an in-progress program (user decision 2026-11-26: "started with
   *  matching but want to do it differently"). `programRepo.open`'s upsert replaces the chain
   *  and keeps progress — cleared counts carry over (strength is max-over-prefix, so a lighter
   *  new chain never revokes earned credit) and credited/locked words stay done. */
  function openBuilderEdit(b: ProgramBatch) {
    setBatch(b)
    setDraft(todayPrograms.get(b.key)?.stages ?? PRESETS[b.direction][1]?.stages ?? ['matching'])
    setView('builder')
  }

  function startRun(b: ProgramBatch, prog: ReviewProgram) {
    setBatch(b)
    setProgram(prog)
    progressRef.current = { ...prog.progress }
    setProgress(progressRef.current)
    setProgressV(v => v + 1)
    // Relearn-loop words ride along in the SAME session (user decision 2026-11-20): real
    // relearn reviews woven between rounds/cards, never a separate mode.
    relearnKindRef.current = new Map(b.words.filter(w => w.relearn).map(w => [w.card.id, 'loop' as const]))
    setRelearnQ(b.words.filter(w => w.relearn).map(w => w.card.id))
    setView('run')
    void loadSessionCards(b)
  }

  /** Re-reads the batch's cards with SESSION columns (full choices, synonyms, sentences).
   *  Bulk cards stay only as placeholders until this lands; anything that writes `choices`
   *  back (cloze generation) waits for it. */
  async function loadSessionCards(b: ProgramBatch) {
    try {
      const cardRepo = new SupabaseCardRepository()
      const [cards, decks] = await Promise.all([
        cardRepo.listSessionByIds(b.words.map(w => w.card.id)),
        new SupabaseDeckRepository().list(userId),
      ])
      // Each card's deck → its grading settings / deck name / ℹ-modal context (first link wins,
      // like the session pages' deckIdsByCard usage).
      const linked = await cardRepo.deckIdsByCard(decks.map(d => d.id))
      const deckById = new Map(decks.map(d => [d.id, d]))
      const byCard = new Map<string, Deck>()
      for (const [cardId, deckId] of linked) {
        const d = deckById.get(deckId)
        if (d) byCard.set(cardId, d)
      }
      cardDeckRef.current = byCard
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
    // Keep the resume map in step with live progress — otherwise leaving the run and
    // re-entering the batch resumes from the PAGE-LOAD progress, forgetting every lock and
    // credit made since, and re-arms "Lock in progress" (the 2026-11-20 double-boost bug).
    if (batch) {
      const key = batch.key
      const snapshot = { ...progressRef.current }
      setTodayPrograms(prev => {
        const cur = prev.get(key)
        return cur ? new Map(prev).set(key, { ...cur, progress: snapshot }) : prev
      })
    }
  }

  const prog = (cardId: string): WordProgress => progress[cardId] ?? { cleared: 0 }

  // ── Runner derivations ──────────────────────────────────────────────────
  const stages = program?.stages ?? []
  // Stage pipeline pool = the NON-relearn words; relearn words run their own inline queue.
  const pool: ProgramWord[] = useMemo(
    () => (batch ? batch.words.filter(w => !w.relearn) : []),
    [batch],
  )
  const [relearnQ, setRelearnQ] = useState<string[]>([])
  /** 'loop' = a real relearn-loop row (real FSRS writes); 'remedial' = a word missed during
   *  matching this session — one written check, no schedule write. */
  const relearnKindRef = useRef<Map<string, 'loop' | 'remedial'>>(new Map())
  const addRemedial = (id: string) => {
    if (relearnKindRef.current.has(id)) return
    relearnKindRef.current.set(id, 'remedial')
    setRelearnQ(q => [...q, id])
  }
  const remaining = pool.filter(w => !prog(w.card.id).done)
  /** Stage PLACEMENT clamps cleared to the last stage: editing today's plan to a SHORTER chain
   *  can leave a word's cleared count past the end — it still owes the final (crediting) stage,
   *  so it queues there instead of falling out of `active` and wedging the run. Earned-strength
   *  math keeps the raw count. */
  const clearedFor = (id: string) => Math.min(prog(id).cleared, Math.max(0, stages.length - 1))
  const stageIdx = remaining.length > 0
    ? Math.min(stages.length - 1, Math.min(...remaining.map(w => clearedFor(w.card.id))))
    : 0
  const stageKind: StageKind | undefined = stages[stageIdx]
  const active = remaining.filter(w => clearedFor(w.card.id) === stageIdx)
  const isFinalStage = stageIdx === stages.length - 1

  /** Clears the current stage for a word; the final stage writes the real review (a hint used
   *  on the clearing answer dampens the growth, same as sessions). */
  function clearWord(word: ProgramWord, rating: Rating | null, hintGrowthFactor?: number | null) {
    const id = word.card.id
    const cleared = Math.max(prog(id).cleared, stageIdx + 1)
    // The pre-program interval, captured once at the first clear: every later boost computes
    // from it, so re-applications converge instead of compounding (WordProgress.base).
    const base = prog(id).base ?? rowInterval(word.state, batch!.direction)
    if (cleared >= stages.length) {
      const final = stages[stages.length - 1]!
      const updated = creditRow(word.state, batch!.direction, finalStageRating(final, rating), STAGE_STRENGTH[final], deps(),
        hintGrowthFactor != null ? { hintGrowthFactor } : {})
      saveQueueRef.current = saveQueueRef.current
        .then(() => stateRepo.upsert(updated).then(() => undefined))
        .catch(err => console.error('[program] credit failed:', err))
      updateProgress(id, { cleared, base, done: 'credited' })
    } else {
      updateProgress(id, { cleared, base })
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
      const boosted = boostRow(w.state, batch.direction, earnedStrength(stages, p.cleared), d, p.base)
      if (boosted !== w.state) rows.push(boosted)
      ids.push(w.card.id)
    }
    if (ids.length === 0) return
    try {
      // rows can be fewer than ids: a word already at (or past) its boost target is a no-op
      // write, but it still gets its 'locked' flag so nothing re-arms it later.
      if (rows.length > 0) await stateRepo.upsertBatch(rows)
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
    // Pending relearn/remedial cards drain between rounds — the next round waits for them.
    if (relearnQ.length > 0) { if (stageChanged) setMatchChunk(null); return }
    const fresh = active.filter(w => !missedStageRef.current.has(w.card.id))
    const retry = active.filter(w => missedStageRef.current.has(w.card.id))
    dirtyRef.current = new Set()
    setMatchChunk(nextMatchingChunk(fresh, retry))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, stageKind, stageIdx, matchChunk, progressV, relearnQ])

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
    if (view !== 'run') return
    const ids = stageKind === 'cloze' ? queue.slice(0, 3) : []
    // Relearn reviews present as cloze too (setting, default on) — their queue is set at
    // startRun, so clozes resolve during the first matching round, before a relearn surfaces.
    if (relearnClozeRef.current && batch?.direction === 'production') ids.push(...relearnQ.slice(0, 3))
    for (const id of ids) {
      const sc = sessionCards.get(id)
      if (!sc || clozeByCard.has(id) || clozeInFlight.current.has(id) || !clozeEligible(sc)) continue
      clozeInFlight.current.add(id)
      void resolveReviewCloze(sc, { allowGenerate: !isOfflineActive() })
        .then(cz => setClozeByCard(prev => new Map(prev).set(id, cz)))
        .catch(() => setClozeByCard(prev => new Map(prev).set(id, null)))
        .finally(() => clozeInFlight.current.delete(id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, stageKind, queue, relearnQ, sessionCards, clozeByCard])

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
  const currentCardId = queue.find(id => { const p = prog(id); return clearedFor(id) === stageIdx && !p.done })
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
    // Rebuilding an already-started program (the Edit path) — progress carries over.
    const builderEditing = Object.values(todayPrograms.get(batch.key)?.progress ?? {})
      .some(p => p.cleared > 0 || p.done)
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
          {builderEditing && (
            <p className="text-xs text-ink-faint">
              Changing today&apos;s plan — progress so far is kept: words keep the stages they&apos;ve
              already cleared, and anything credited or locked in stays done.
            </p>
          )}
          <button onClick={() => void handleStart()} disabled={draft.length === 0} className="btn-primary w-full">
            {builderEditing ? 'Update program' : 'Start'} ({batch.words.length} words)
          </button>
        </div>
      </div>
    )
  }

  if (view === 'run' && batch && program) {
    const credited = pool.filter(w => prog(w.card.id).done === 'credited').length
    const locked   = pool.filter(w => prog(w.card.id).done === 'locked').length
    const lockable = remaining.filter(w => prog(w.card.id).cleared > 0).length

    if (remaining.length === 0 && relearnQ.length === 0) {
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
          {langFlag(batch.src)} {dirLabel(batch)}
          {remaining.length > 0 ? ` · stage ${stageIdx + 1}/${stages.length}: ${stageKind ? STAGE_LABEL[stageKind] : ''} · ${remaining.length} left` : ''}
          {relearnQ.length > 0 ? ` · ${relearnQ.length} relearn` : ''}
        </span>
        {lockable > 0 && stages.length > 1 && (
          <button onClick={() => void lockInNow()} className="text-xs text-accent-soft hover:text-accent" title="Apply every started word's current boost now and finish">
            Lock in progress ({lockable})
          </button>
        )}
      </div>
    )

    // ── Relearn/remedial precedence — the natural seams: between matching rounds, before
    // stage cards, standalone when only relearns remain. A 'loop' card is a REAL relearn
    // review (Good×2/Easy escapes and schedules, Again×3 back to the pipeline); a 'remedial'
    // card is the written check a matching miss earned — practice only, no write. Never a
    // separate mode (user decision 2026-11-20).
    const relearnId = relearnQ[0]
    const relearnNow = relearnId != null && (stageKind !== 'matching' || !matchChunk || matchChunk.length === 0 || remaining.length === 0)

    if (!relearnNow && stageKind === 'matching') {
      if (!matchChunk || matchChunk.length === 0) {
        return <div className="space-y-6 pb-12">{header}<p className="text-sm text-ink-muted text-center pt-8">Preparing round…</p></div>
      }
      const pairs: MatchPair[] = matchChunk.map(w => ({ id: w.card.id, front: displayText(w.card.front), back: displayText(w.card.back) }))
      const infoCard = matchInfoId ? sessionCards.get(matchInfoId) : undefined
      const infoDeck = infoCard ? cardDeckRef.current.get(infoCard.id) : undefined
      return (
        <div className="space-y-6 pb-12">
          {header}
          <MatchingGame
            key={`${program.id}-${stageIdx}-${matchChunk[0]!.card.id}`}
            pairs={pairs}
            onInfo={p => { if (sessionCards.has(p.id)) setMatchInfoId(p.id) }}
            onExit={() => setView('batches')}
            onSpeakTarget={p => {
              if (!autoplayGlobalRef.current) return
              const w = matchChunk.find(x => x.card.id === p.id)
              if (w) speak(w.card.front, w.card.sourceLanguage)
            }}
            onAttempt={a => {
              if (!a.correct) {
                // No credit this round; the pair redistributes into the upcoming rounds AND
                // earns one written check in this session (queued at the next seam).
                dirtyRef.current.add(a.pair.id)
                missedStageRef.current.add(a.pair.id)
                addRemedial(a.pair.id)
                if (a.confused) {
                  dirtyRef.current.add(a.confused.id)
                  missedStageRef.current.add(a.confused.id)
                  addRemedial(a.confused.id)
                }
                return
              }
              if (dirtyRef.current.has(a.pair.id)) return
              const w = matchChunk.find(x => x.card.id === a.pair.id)
              if (w && clearedFor(w.card.id) === stageIdx) clearWord(w, 'good')
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
          {infoCard && infoDeck && (
            <CardEditModal
              card={infoCard}
              state={forwardRef.current.get(infoCard.id)}
              userId={userId}
              deckId={infoDeck.id}
              deckCards={pool.map(w => sessionCards.get(w.card.id) ?? w.card).filter(c => cardDeckRef.current.get(c.id)?.id === infoDeck.id)}
              sourceLanguage={batch.src}
              targetLanguage={batch.tgt}
              onSave={async (id, front, back) => {
                await new SupabaseCardRepository().update(id, { front, back })
                setSessionCards(prev => { const c0 = prev.get(id); return c0 ? new Map(prev).set(id, { ...c0, front, back }) : prev })
              }}
              onCardChange={c => setSessionCards(prev => new Map(prev).set(c.id, c))}
              onStateChange={s => {
                if (s.reviewDirection !== 'reverse') forwardRef.current.set(s.cardId, s)
                if ((batch.direction === 'production') === (s.reviewDirection !== 'reverse')) {
                  const w2 = batch.words.find(x => x.card.id === s.cardId)
                  if (w2) w2.state = s
                }
              }}
              onClose={() => setMatchInfoId(null)}
              initialShowStats
            />
          )}
        </div>
      )
    }

    // ── The active card: a relearn/remedial card at a seam, else the current stage card.
    // ONE shared chrome for both — deck grading settings, overrides, synonyms, hint, IPA,
    // audio, star, edits, ℹ modal — so a relearn review is a full review (user demand
    // 2026-11-20: "every single thing functional").
    const activeCardId = relearnNow ? relearnId : currentCardId
    const word = activeCardId ? batch.words.find(w => w.card.id === activeCardId) : undefined
    // The SESSION-column copy carries choices (synonyms, stored sentences, override targets)
    // and hydrated audio — the bulk placeholder must never reach the review components.
    const card = word ? sessionCards.get(word.card.id) : undefined
    if (!word || !card) {
      return <div className="space-y-6 pb-12">{header}<p className="text-sm text-ink-muted text-center pt-8">Loading…</p></div>
    }
    const rKind = relearnNow ? (relearnKindRef.current.get(card.id) ?? 'remedial') : null
    const promptSide = batch.direction === 'production' ? 'back' as const : 'front' as const
    const answerSide = promptSide === 'back' ? 'front' as const : 'back' as const
    const promptLanguage = promptSide === 'front' ? card.sourceLanguage : undefined
    const pairStrict = strictFor(batch.src, batch.tgt)
    const deck = cardDeckRef.current.get(card.id)
    // The DECK's grading settings, like sessions — defaults silently flipped accent handling.
    const gsWithLang = { ...(deck?.gradingSettings ?? DEFAULT_GRADING_SETTINGS), answerLanguage: answerSide === 'front' ? batch.src : batch.tgt }
    const autoplay = autoplayGlobalRef.current && (gsWithLang.autoPlayAudio ?? true)
    const currentIpaText = showIPA && promptSide === 'front' ? (ipaCache.get(card.id) ?? card.ipa ?? undefined) : undefined
    const ipaToggle = promptSide === 'front' ? () => setShowIPA(v => !v) : undefined

    const onStageRate = (rating: Rating, wasCorrect = rating !== 'again') => {
      const hintGF = hintGFRef.current
      hintGFRef.current = null
      setInfoOpen(false)
      setAttempt(a => a + 1)
      // The session rule: a hinted Hard wasn't a cold recall — it replays instead of clearing.
      if (!wasCorrect || rating === 'again' || (rating === 'hard' && hintGF != null)) {
        setQueue(q => [...q.filter(id => id !== word.card.id), word.card.id])   // replay in-stage
      } else {
        clearWord(word, rating, hintGF)
        setQueue(q => q.filter(id => id !== word.card.id))
      }
    }
    const onRelearnRate = (rating: Rating, wasCorrect = rating !== 'again') => {
      hintGFRef.current = null
      setInfoOpen(false)
      setAttempt(a => a + 1)
      const eff: Rating = wasCorrect && rating !== 'again' ? rating : 'again'
      if (rKind === 'remedial') {
        if (eff === 'again') setRelearnQ(q => [...q.slice(1), card.id])
        else { relearnKindRef.current.delete(card.id); setRelearnQ(q => q.slice(1)) }
        return
      }
      const out = relearnReview(word.state, batch.direction, eff, deps())
      if (out.kind === 'ladder') {
        // Three Agains: back to the learning pipeline, like sessions.
        const reset = { ...initialCardState(userId, card.id, word.state.pipelineId), reviewDirection: word.state.reviewDirection }
        void stateRepo.upsert(reset).catch(err => console.error('Relearn reset failed:', err))
        relearnKindRef.current.delete(card.id)
        setRelearnQ(q => q.slice(1))
        return
      }
      word.state = out.state
      void stateRepo.upsert(out.state).catch(err => console.error('Relearn save failed:', err))
      if (out.kind === 'scheduled') {
        relearnKindRef.current.delete(card.id)
        setRelearnQ(q => q.slice(1))        // escaped — scheduled forward, done for the day
      } else {
        setRelearnQ(q => [...q.slice(1), card.id])   // still looping — re-shows later
      }
    }
    const onRate = relearnNow ? onRelearnRate : onStageRate

    const patchCard = (patch: Partial<Card>) =>
      setSessionCards(prev => { const c0 = prev.get(card.id); return c0 ? new Map(prev).set(card.id, { ...c0, ...patch }) : prev })
    const onToggleStar = async (next: boolean) => {
      await new SupabaseCardRepository().setStarred(card.id, next)
      patchCard({ starred: next })
    }
    const onSideEdit = (side: 'front' | 'back') => (text: string) => {
      void new SupabaseCardRepository().update(card.id, { [side]: text }).catch(err => console.error('Card edit failed:', err))
      patchCard({ [side]: text })
    }
    // The sessions' "Almost" for a near-miss self-graded recall: small difficulty bump, replay
    // this stage, no schedule change (no review event — programs never write them).
    const onAlmost = !relearnNow && word.state.graduated ? () => {
      const bumped = { ...word.state, difficulty: nextDifficulty(word.state.difficulty ?? 5, 'hard') }
      word.state = bumped
      void stateRepo.upsert(bumped).catch(err => console.error('Almost save failed:', err))
      setAttempt(a => a + 1)
      setQueue(q => [...q.filter(id => id !== word.card.id), word.card.id])
    } : undefined

    const typedPresentation = relearnNow ? batch.direction === 'production' : (stageKind === 'typed' || stageKind === 'cloze')
    // A production relearn presents as cloze when the setting is on (user decision 2026-11-26)
    // — plain typed card when no cloze resolved (ineligible card, offline, generation failed).
    const relearnClozeData = relearnNow && batch.direction === 'production' && relearnClozeRef.current
      ? clozeByCard.get(card.id) || undefined
      : undefined
    return (
      <div className="space-y-6 pb-12">
        {header}
        {relearnNow && (
          <p className="text-xs text-ink-faint text-center uppercase tracking-wider">
            {rKind === 'loop' ? 'Relearning — two Goods in a row (or Easy) puts it back on schedule' : 'Missed in matching — get it right once to move on'}
          </p>
        )}
        {typedPresentation ? (
          // Cloze is TYPED production (user decision 2026-11-20): the sentence's blank is the
          // prompt and the word is typed into the usual grader. Articles auto-accept in cloze —
          // the sentence's own article sits visibly before the blank.
          <TypingMode
            key={`${relearnNow ? 'relearn' : stageIdx}-${card.id}-${attempt}`}
            card={card}
            promptSide={promptSide}
            promptLanguage={promptLanguage}
            cloze={relearnNow ? relearnClozeData : stageKind === 'cloze' ? clozeByCard.get(card.id) || undefined : undefined}
            strictness={(!relearnNow && stageKind === 'cloze') || relearnClozeData ? clozeStrictness(pairStrict) : pairStrict}
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
            deckName={deck?.name}
            onInfo={deck ? () => setInfoOpen(true) : undefined}
            onToggleStar={onToggleStar}
            onPromptEdit={onSideEdit(promptSide)}
            onAnswerEdit={onSideEdit(answerSide)}
            autoPlayAudio={autoplay}
            ipaText={currentIpaText} onToggleIPA={ipaToggle}
            onRate={(r, wasCorrect) => onRate(r, wasCorrect)}
          />
        ) : (
          <FlashcardMode
            key={`${relearnNow ? 'relearn' : stageIdx}-${card.id}-${attempt}`}
            card={card}
            promptSide={promptSide}
            promptLanguage={promptLanguage}
            answerLanguage={answerSide === 'front' ? batch.src : batch.tgt}
            hintable
            onHint={(_level, growthFactor) => { hintGFRef.current = growthFactor }}
            deckName={deck?.name}
            onInfo={deck ? () => setInfoOpen(true) : undefined}
            onToggleStar={onToggleStar}
            onPromptEdit={onSideEdit(promptSide)}
            onAnswerEdit={onSideEdit(answerSide)}
            onAlmost={onAlmost}
            autoPlayAudio={autoplay}
            ipaText={currentIpaText} onToggleIPA={ipaToggle}
            onRate={r => onRate(r)}
          />
        )}
        {infoOpen && deck && (
          <CardEditModal
            card={card}
            state={forwardRef.current.get(card.id)}
            userId={userId}
            deckId={deck.id}
            deckCards={pool.map(w => sessionCards.get(w.card.id) ?? w.card).filter(c => cardDeckRef.current.get(c.id)?.id === deck.id)}
            sourceLanguage={batch.src}
            targetLanguage={batch.tgt}
            onSave={async (id, front, back) => {
              await new SupabaseCardRepository().update(id, { front, back })
              patchCard({ front, back })
            }}
            onCardChange={c => setSessionCards(prev => new Map(prev).set(c.id, c))}
            onStateChange={s => {
              if (s.reviewDirection !== 'reverse') forwardRef.current.set(s.cardId, s)
              // Keep the run's scheduling source honest when the modal reschedules THIS
              // direction's row (maturity buttons, resets).
              if ((batch.direction === 'production') === (s.reviewDirection !== 'reverse')) {
                const w2 = batch.words.find(x => x.card.id === s.cardId)
                if (w2) w2.state = s
              }
            }}
            onClose={() => setInfoOpen(false)}
            initialShowStats
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
            // Must mirror openBuilder's auto-resume condition exactly: whenever Continue would
            // skip the builder, Edit is the only path back to it. A single-stage chain (matching
            // only) never has a mid-chain word — cleared>0 implies done — so `!p.done` here hid
            // Edit for exactly those programs.
            const inProgress = open && Object.values(open.progress).some(p => p.cleared > 0 || p.done)
            const expanded = expandedKey === b.key
            return (
              <div key={b.key}>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <button
                    onClick={() => setExpandedKey(expanded ? null : b.key)}
                    className="min-w-0 flex-1 text-left group"
                    aria-expanded={expanded}
                  >
                    <div className="text-sm text-ink font-medium">
                      {langFlag(b.src)} {dirLabel(b)}
                      <span className={`ml-2 inline-block text-ink-muted/60 text-xs transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
                    </div>
                    <div className="text-xs text-ink-muted">
                      {b.words.length - b.relearning} due
                      {b.relearning > 0 ? ` · ${b.relearning} relearning (reviewed in-session)` : ''}
                      {inProgress && open ? ` · in progress (${open.stages.map(s => STAGE_LABEL[s]).join(' → ')})` : ''}
                    </div>
                  </button>
                  {b.words.length > 0 && (
                    <div className="flex items-center gap-2 shrink-0">
                      {inProgress && (
                        <button onClick={() => openBuilderEdit(b)}
                          title="Change today's stage chain — progress so far is kept"
                          className="rounded-lg border border-line/20 px-3 py-2 text-xs text-ink-muted hover:text-ink transition-colors">
                          Edit
                        </button>
                      )}
                      <button onClick={() => openBuilder(b)} className="btn-primary text-sm">
                        {inProgress ? 'Continue' : 'Start'}
                      </button>
                    </div>
                  )}
                </div>
                {expanded && (
                  <div className="px-4 pb-3">
                    <div className="rounded-lg border border-line/10 divide-y divide-line/5 max-h-80 overflow-y-auto">
                      {b.words.map(w => (
                        <div key={w.card.id} className="flex items-center justify-between gap-3 px-3 py-2">
                          <div className="min-w-0 text-sm">
                            <span className="text-ink">{displayText(w.card.front)}</span>
                            <span className="text-ink-muted"> — {displayText(w.card.back)}</span>
                            {w.relearn && <span className="ml-2 text-[10px] uppercase tracking-wide text-warning">relearning</span>}
                          </div>
                          <button
                            onClick={() => {
                              // The batch's Card objects come from the cached library read —
                              // shared and immutable, so swap the object instead of mutating it.
                              const prevCard = w.card
                              const next = !prevCard.starred
                              w.card = { ...prevCard, starred: next }
                              setBatches(bs => [...bs])
                              new SupabaseCardRepository().setStarred(prevCard.id, next).catch(() => {
                                w.card = prevCard
                                setBatches(bs => [...bs])
                              })
                            }}
                            className={`shrink-0 w-6 h-6 flex items-center justify-center transition-colors ${w.card.starred ? 'text-warning hover:text-warning/80' : 'text-ink-faint hover:text-ink-muted'}`}
                            aria-pressed={w.card.starred ?? false}
                            title={w.card.starred ? 'Starred — click to unstar' : 'Star this card'}
                          >
                            <svg viewBox="0 0 24 24" className="w-4 h-4"
                              fill={w.card.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"
                              strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.4l-5.81 3.05 1.11-6.47-4.7-4.58 6.5-.95L12 2.5z" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
