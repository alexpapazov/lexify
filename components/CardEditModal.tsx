'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository }              from '@/lib/data/cards'
import { SupabaseCardStateRepository }         from '@/lib/data/cardStates'
import { SupabasePipelineRepository }          from '@/lib/data/pipelines'
import { SupabaseCardConfusionRepository }     from '@/lib/data/cardConfusions'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import { SupabasePendingSynonymLinkRepository } from '@/lib/data/pendingSynonymLinks'
import { SupabaseCardConfusionLinkRepository } from '@/lib/data/cardConfusionLinks'
import { SupabaseReviewEventRepository }       from '@/lib/data/reviewEvents'
import type { Card, CardState, CardChoices, CardConfusion, CardConfusionLink, Pipeline, TypedAnswerOverride, ReviewEvent } from '@/domain'
import { prefetchChoices, needsChoices, ensureChoicesGenerated, regenerateChoicesExcluding } from '@/lib/distractors'
import { langName, TTS_SUPPORTED_LANGUAGES } from '@/lib/languages'
import { displayText } from '@/lib/cardText'
import { speak, fetchAudioSource } from '@/lib/speak'
import type { AudioSource } from '@/domain'
import { classifyReviewMode, MULTIPLIER_RANGE } from '@/engine/scheduler'
import { initialCardState, fastTrackCardState } from '@/engine/pipeline'
import { batchFastTrackDueDates } from '@/engine/density'
import { ConfirmDialog } from './ConfirmDialog'

function formatDate(iso: string | null, fallback = '—'): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (isNaN(d.getTime())) return fallback
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Format a (possibly fractional, sub-day) interval in days as a human-friendly duration. */
function formatIntervalDays(days: number | null | undefined): string {
  if (days == null) return '—'
  if (days <= 0) return '0 days'
  if (days < 1) {
    const mins = Math.round(days * 24 * 60)
    return `${mins} min${mins === 1 ? '' : 's'}`
  }
  const rounded = Math.round(days * 10) / 10
  return `${rounded} day${rounded === 1 ? '' : 's'}`
}

/** A labeled group of stat rows inside the "Card stats" panel. */
function StatGroup({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {rows.map(([label, value]) => (
          <div key={label} className="space-y-0.5">
            <div className="text-xs text-ink-faint uppercase tracking-wider">{label}</div>
            <div className="text-ink font-medium text-sm break-words">{value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CardEditModal({ card, state, userId, deckId, deckCards, sourceLanguage, targetLanguage, onSave, onCardChange, onStateChange, onClose, onJumpToCard, onSyncCard, initialShowStats, onDelete, onMerge }: {
  card:           Card
  state:          CardState | undefined
  userId:         string
  deckId:         string
  deckCards:      Card[]
  sourceLanguage: string
  targetLanguage: string
  onSave:  (id: string, front: string, back: string) => Promise<void>
  onCardChange:  (card: Card) => void
  onStateChange: (state: CardState) => void
  onClose: () => void
  /** Jump the editor to another card in this deck (used by the "Often confused with" list). */
  onJumpToCard?: (cardId: string) => void
  /** Open the sync-review modal for this card. */
  onSyncCard?: () => void
  /** Open directly to the stats/info panel. */
  initialShowStats?: boolean
  /** Called after the card has been soft-deleted. */
  onDelete?: (cardId: string) => void
  /** Called after two cards have been merged. deletedId is the removed card; survivor + its final state replace it. */
  onMerge?: (deletedCardId: string, survivorCard: Card, survivorState: CardState | undefined) => void
}) {
  const [front,   setFront]   = useState(card.front)
  const [back,    setBack]    = useState(card.back)
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [validErr, setValidErr] = useState<string | null>(null)
  const [showStats, setShowStats] = useState(initialShowStats ?? false)
  const [showResetMenu, setShowResetMenu] = useState(false)
  const [resetAction, setResetAction] = useState<'distractors' | 'progress' | 'audio' | 'all' | null>(null)
  const [resetting,   setResetting]   = useState(false)
  const [resetError,  setResetError]  = useState<string | null>(null)
  const [dormancyInput, setDormancyInput] = useState('')
  const [dormancyBusy,  setDormancyBusy]  = useState(false)
  const [dormancyMsg,   setDormancyMsg]   = useState<{ ok: boolean; text: string } | null>(null)
  // Keep the input showing the saved threshold (not a faint placeholder that reads as "unsaved").
  useEffect(() => {
    setDormancyInput(state?.dormancyThreshold != null ? String(state.dormancyThreshold) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, state?.dormancyThreshold])

  // Persist a dormancy change (threshold and/or dormant flag) on the forward row.
  // Every outcome sets an inline message so failures are never silent.
  async function applyDormancy(patch: { dormant?: boolean; dormancyThreshold?: number | null }) {
    if (!state) { setDormancyMsg({ ok: false, text: 'No card state loaded — cannot save.' }); return }
    if (!userId) { setDormancyMsg({ ok: false, text: 'No user id — cannot save.' }); return }
    setDormancyBusy(true)
    setDormancyMsg(null)
    try {
      const updated = await new SupabaseCardStateRepository().setDormancy(userId, card.id, patch)
      onStateChange(updated)
      setDormancyMsg({ ok: true, text: `Saved (threshold: ${updated.dormancyThreshold ?? 'none'}, dormant: ${updated.dormant})` })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      console.error('[dormancy] save failed:', err)
      setDormancyMsg({ ok: false, text })
    } finally {
      setDormancyBusy(false)
    }
  }
  const [resetDone,   setResetDone]   = useState<string | null>(null)
  const [graduating,          setGraduating]          = useState(false)
  const [graduateAccelerated, setGraduateAccelerated] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting,         setDeleting]         = useState(false)
  // Distractor editing state — tracks which chip is being edited: [side, originalText]
  const [editingDistractor,  setEditingDistractor]  = useState<['front'|'back', string] | null>(null)
  const [distractorEditText, setDistractorEditText] = useState('')
  const [distractorAddText,  setDistractorAddText]  = useState<{front: string; back: string}>({front: '', back: ''})
  const [deletedDistractors, setDeletedDistractors] = useState<{front: string[]; back: string[]}>({front: [], back: []})
  const [reviewHistory,      setReviewHistory]      = useState<ReviewEvent[] | null>(null)
  const [reviewsLoading,     setReviewsLoading]     = useState(false)
  const [historyTrack,       setHistoryTrack]       = useState<'typed' | 'recall' | 'recognition'>('typed')
  const [reverseCardState,   setReverseCardState]   = useState<CardState | null | undefined>(undefined) // undefined = not yet loaded
  // Synonym editing state
  const [sourceSynonymInput, setSourceSynonymInput] = useState('')
  const [targetSynonymInput, setTargetSynonymInput] = useState('')
  const [synonymSaving,      setSynonymSaving]      = useState(false)
  const [linkSynonymMode,    setLinkSynonymMode]    = useState(false)
  const [linkQuery,          setLinkQuery]          = useState('')
  const [linkSaving,         setLinkSaving]         = useState(false)
  const [linkError,          setLinkError]          = useState<string | null>(null)
  const [pendingLinkSaved,   setPendingLinkSaved]   = useState<string | null>(null) // word saved as pending
  // Merge state
  const [merging,            setMerging]            = useState(false)
  const [mergeQuery,         setMergeQuery]         = useState('')
  const [allPairCards,       setAllPairCards]       = useState<Card[] | null>(null)
  const [mergeCardsLoading,  setMergeCardsLoading]  = useState(false)
  const [mergeTarget,        setMergeTarget]        = useState<Card | null>(null)
  const [mergeTargetState,   setMergeTargetState]   = useState<CardState | null | undefined>(undefined)
  const [mergeTargetDecks,   setMergeTargetDecks]   = useState<string[]>([])
  const [mergeSurvivorId,    setMergeSurvivorId]    = useState<string | null>(null)
  const [mergeExecuting,     setMergeExecuting]     = useState(false)
  const [mergeError,         setMergeError]         = useState<string | null>(null)
  const [confusions,       setConfusions]       = useState<CardConfusion[]>([])
  const [confusionLinks,   setConfusionLinks]   = useState<CardConfusionLink[]>([])
  const [linkConfusionMode,  setLinkConfusionMode]  = useState(false)
  const [linkConfusionQuery, setLinkConfusionQuery] = useState('')
  const [linkConfusionSaving,setLinkConfusionSaving]= useState(false)
  const [linkConfusionError, setLinkConfusionError] = useState<string | null>(null)
  const [overrides,        setOverrides]        = useState<TypedAnswerOverride[]>([])
  const [pipeline,         setPipeline]         = useState<Pipeline | null>(null)
  const [audioError,       setAudioError]       = useState<string | null>(null)
  const [busySource,       setBusySource]       = useState<AudioSource | null>(null)
  const frontRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { frontRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      new SupabaseCardConfusionRepository().listForCard(userId, card.id),
      new SupabaseCardConfusionLinkRepository().listForCard(userId, card.id),
      new SupabaseTypedAnswerOverrideRepository().listForUser(userId),
      new SupabasePipelineRepository().getDefault(),
    ]).then(([rows, links, allOverrides, pl]) => {
      if (cancelled) return
      setConfusions(rows)
      setConfusionLinks(links)
      setOverrides(allOverrides.filter(o => o.cardId === card.id))
      setPipeline(pl)
    }).catch(err => console.error('Failed to load card stats:', err))
    return () => { cancelled = true }
  }, [userId, card.id])

  useEffect(() => {
    if (!showStats || reviewHistory !== null || reviewsLoading) return
    setReviewsLoading(true)
    Promise.all([
      new SupabaseReviewEventRepository().listForCard(userId, card.id),
      new SupabaseCardStateRepository().get(userId, card.id, 'reverse'),
    ])
      .then(([events, revState]) => {
        setReviewHistory(events)
        setReverseCardState(revState)
        const counts = { typed: 0, recall: 0, recognition: 0 }
        for (const e of events) {
          const t = e.wasTyped === true ? 'typed'
            : e.wasTyped === false ? (e.reviewDirection === 'reverse' ? 'recognition' : 'recall')
            : e.mode === 'typing' ? 'typed' : 'recognition'
          counts[t]++
        }
        if (counts.typed > 0) setHistoryTrack('typed')
        else if (counts.recall > 0) setHistoryTrack('recall')
        else setHistoryTrack('recognition')
      })
      .catch(err => console.error('Failed to load review history:', err))
      .finally(() => setReviewsLoading(false))
  }, [showStats, userId, card.id, reviewHistory, reviewsLoading])

  async function handleSave() {
    if (!front.trim()) { setValidErr('Front cannot be empty.'); return }
    if (!back.trim())  { setValidErr('Back cannot be empty.');  return }
    setValidErr(null)
    setSaving(true)
    try {
      // Persist the dormancy threshold along with the card edit (if it changed).
      if (state) {
        const raw = dormancyInput.trim()
        const newThreshold = raw ? (parseInt(raw, 10) || null) : null
        if (newThreshold !== (state.dormancyThreshold ?? null)) {
          const updated = await new SupabaseCardStateRepository().setDormancy(userId, card.id, { dormancyThreshold: newThreshold })
          onStateChange(updated)
        }
      }
      await onSave(card.id, front.trim(), back.trim())
      setSaved(true)
      setTimeout(() => { setSaved(false); onClose() }, 600)
    } catch (err: unknown) {
      setValidErr(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  /** Clears all cached audio (every source) so it will be re-fetched fresh. */
  async function resetAudio() {
    const cardRepo = new SupabaseCardRepository()
    const updated  = await cardRepo.update(card.id, { audioGenerated: false, audioData: null, audioSource: null, audioSources: null })
    onCardChange(updated)
  }

  /** Clears cached AI distractors and kicks off background regeneration. */
  async function resetDistractors() {
    const cardRepo = new SupabaseCardRepository()
    const updated  = await cardRepo.update(card.id, { choices: null })
    onCardChange(updated)

    const resetCard      = { ...updated, choices: null }
    const resetDeckCards = deckCards.map(c => c.id === card.id ? resetCard : c)
    void prefetchChoices(
      [{ card: resetCard, side: 'front', deckCards: resetDeckCards, sourceLanguage, targetLanguage }],
      (_cardId, choices) => onCardChange({ ...resetCard, choices }),
    )
  }

  // ── Multi-source audio ──────────────────────────────────────────────────────
  // The active source ('browser' = on-device Web Speech). Legacy cards with audio
  // but no explicit source are treated as ElevenLabs.
  const activeSource: AudioSource = card.audioSource ?? (card.audioData ? 'elevenlabs' : 'browser')
  // The cached clip for a provider (legacy audioData counts as the ElevenLabs clip).
  function cachedClip(source: AudioSource): string | null {
    if (source === 'browser') return null
    return card.audioSources?.[source] ?? (source === 'elevenlabs' ? (card.audioData ?? null) : null)
  }

  function audioReason(reason?: string): string {
    if (reason === 'forvo-no-pronunciation') return 'Forvo has no recording for this word.'
    if (reason === 'no-forvo-key')           return 'Forvo isn’t configured (missing API key).'
    if (reason === 'unsupported-language')   return 'This language isn’t supported.'
    return 'Couldn’t fetch this audio. Try again.'
  }

  /** Fetches a provider's clip (caching it on the card) unless already cached. */
  async function fetchAndCache(source: 'elevenlabs' | 'forvo'): Promise<string | null> {
    const existing = cachedClip(source)
    if (existing) return existing
    const { audioData, reason } = await fetchAudioSource(card.front, sourceLanguage, source)
    if (!audioData) { setAudioError(audioReason(reason)); return null }
    const newSources = { ...(card.audioSources ?? {}), [source]: audioData }
    const updated = await new SupabaseCardRepository().update(card.id, { audioSources: newSources, audioGenerated: true })
    onCardChange(updated)
    return audioData
  }

  async function playSource(source: AudioSource) {
    setAudioError(null)
    if (source === 'browser') { speak(card.front, sourceLanguage, null); return }
    setBusySource(source)
    try { const clip = await fetchAndCache(source); if (clip) speak(card.front, sourceLanguage, clip) }
    finally { setBusySource(null) }
  }

  /** Makes a source the active one (fetching its clip first if needed). */
  async function selectSource(source: AudioSource) {
    setAudioError(null)
    let clip: string | null = null
    if (source !== 'browser') {
      setBusySource(source)
      try { clip = await fetchAndCache(source) } finally { setBusySource(null) }
      if (!clip) return
    }
    const updated = await new SupabaseCardRepository().update(card.id, { audioSource: source, audioData: clip })
    onCardChange(updated)
  }

  /** Wipes spaced-repetition progress back to "never studied", preserving when the card was first introduced. */
  async function resetProgress() {
    const stateRepo = new SupabaseCardStateRepository()
    let pipelineId = state?.pipelineId
    if (!pipelineId) {
      const pipelineRepo = new SupabasePipelineRepository()
      pipelineId = (await pipelineRepo.getDefault()).id
    }
    const fresh    = initialCardState(userId, card.id, pipelineId)
    const preserved = { ...fresh, introducedDate: state?.introducedDate ?? fresh.introducedDate }
    const updated  = await stateRepo.upsert(preserved)
    onStateChange(updated)
  }

  async function handleConfirmReset() {
    if (!resetAction) return
    setResetting(true)
    setResetError(null)
    try {
      if (resetAction === 'distractors' || resetAction === 'all') await resetDistractors()
      if (resetAction === 'progress'    || resetAction === 'all') await resetProgress()
      if (resetAction === 'audio'       || resetAction === 'all') await resetAudio()
      setResetDone(
        resetAction === 'distractors' ? 'Distractors reset — new ones are being generated.'
        : resetAction === 'progress'  ? 'Progress reset.'
        : resetAction === 'audio'     ? 'Audio cleared — will regenerate next session.'
        : 'Card fully reset.'
      )
      setTimeout(() => setResetDone(null), 2500)
    } catch (err: unknown) {
      setResetError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setResetting(false)
      setResetAction(null)
    }
  }

  /** Skip the learning pipeline and graduate the card immediately. */
  async function handleGraduateNow() {
    setGraduating(true)
    setResetError(null)
    try {
      const stateRepo = new SupabaseCardStateRepository()
      let pipelineId = state?.pipelineId
      if (!pipelineId) {
        const pipelineRepo = new SupabasePipelineRepository()
        pipelineId = (await pipelineRepo.getDefault()).id
      }
      const now    = new Date()
      const nowIso = now.toISOString()
      let graduated: CardState
      if (graduateAccelerated) {
        const [dueAt] = await batchFastTrackDueDates(userId, 1, now, stateRepo)
        graduated = fastTrackCardState(userId, card.id, pipelineId, dueAt ?? nowIso, now)
      } else {
        const dueAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
        const base  = state ?? initialCardState(userId, card.id, pipelineId)
        graduated = {
          ...base,
          graduated:             true,
          currentStepOrder:      0,
          correctInStep:         0,
          dueAt,
          intervalDays:          3,
          scheduledIntervalDays: 3,
          ease:                  base.graduated ? base.ease : 2.5,
          reps:                  Math.max(base.reps, 1),
          lapses:                base.lapses,
          lastRating:            'good',
          lastReviewedAt:        nowIso,
          graduatedAt:           base.graduatedAt ?? nowIso,
          relearningStep:        0,
          pendingIntervalDays:   null,
          lapseClusterCount:     0,
          lastLapseAt:           null,
        }
      }
      const updated = await stateRepo.upsert(graduated)
      onStateChange(updated)
      setResetDone('Card graduated.')
      setTimeout(() => setResetDone(null), 2500)
    } catch (err: unknown) {
      setResetError(err instanceof Error ? err.message : 'Graduate failed')
    } finally {
      setGraduating(false)
    }
  }

  function stateProgress(s: CardState | null | undefined): string {
    if (!s) return 'Not started'
    if (s.graduated) {
      const days = s.scheduledIntervalDays || s.intervalDays
      return `Graduated · ${days}d interval · ${s.reps} review${s.reps !== 1 ? 's' : ''}`
    }
    return `Learning — Step ${s.currentStepOrder + 1}`
  }

  function isAMoreAdvanced(a: CardState | undefined, b: CardState | null | undefined): boolean {
    if (!a && !b) return true
    if (!b) return true
    if (!a) return false
    if (a.graduated !== b.graduated) return a.graduated
    if (a.graduated) {
      const ai = a.scheduledIntervalDays || a.intervalDays
      const bi = b.scheduledIntervalDays || b.intervalDays
      return ai !== bi ? ai > bi : a.reps >= b.reps
    }
    if (a.currentStepOrder !== b.currentStepOrder) return a.currentStepOrder > b.currentStepOrder
    return a.correctInStep >= b.correctInStep
  }

  async function loadAllPairCards() {
    if (allPairCards) return
    setMergeCardsLoading(true)
    try {
      const cardRepo = new SupabaseCardRepository()
      const all = await cardRepo.listOwned(userId, sourceLanguage, targetLanguage)
      setAllPairCards(all.filter(c => c.id !== card.id))
    } catch { setLinkError('Failed to load cards.') }
    finally { setMergeCardsLoading(false) }
  }

  async function updateDistractorPool(side: 'front' | 'back', newPool: string[]) {
    const supabase = createClient()
    const base: CardChoices = card.choices ?? { front: [], back: [] }
    const updated: CardChoices = { ...base, [side]: newPool }
    await supabase.from('cards').update({ choices: updated }).eq('id', card.id)
    onCardChange({ ...card, choices: updated })
  }

  async function handleDistractorDelete(side: 'front' | 'back', text: string) {
    const pool    = card.choices?.[side] ?? []
    const newPool = pool.filter(d => d !== text)

    // Track which distractors have been deleted from this side so we can
    // exclude them from the regeneration prompt if the pool empties.
    const nowDeleted = [...deletedDistractors[side], text]
    setDeletedDistractors(prev => ({ ...prev, [side]: nowDeleted }))

    await updateDistractorPool(side, newPool)

    if (newPool.length === 0) {
      // All distractors on this side were deleted — regenerate, explicitly
      // excluding every deleted option so the AI doesn't reuse them.
      setDeletedDistractors(prev => ({ ...prev, [side]: [] }))
      const excludedFront = side === 'front' ? nowDeleted : deletedDistractors.front
      const excludedBack  = side === 'back'  ? nowDeleted : deletedDistractors.back
      void regenerateChoicesExcluding(card, deckCards, sourceLanguage, targetLanguage, excludedFront, excludedBack)
        .then(fresh => { if (fresh) onCardChange({ ...card, choices: fresh }) })
    }
  }

  async function handleDistractorSaveEdit(side: 'front' | 'back', original: string) {
    const newText = distractorEditText.trim()
    setEditingDistractor(null)
    if (!newText || newText === original) return
    const pool = card.choices?.[side] ?? []
    await updateDistractorPool(side, pool.map(d => d === original ? newText : d))
  }

  async function handleDistractorAdd(side: 'front' | 'back') {
    const text = distractorAddText[side].trim()
    if (!text) return
    const pool = card.choices?.[side] ?? []
    if (pool.some(d => d.toLowerCase() === text.toLowerCase())) {
      setDistractorAddText(prev => ({ ...prev, [side]: '' }))
      return
    }
    setDistractorAddText(prev => ({ ...prev, [side]: '' }))
    const base: CardChoices = card.choices ?? { front: [], back: [] }
    await updateDistractorPool(side, [...pool, text])
    // If still below threshold, trigger background regeneration
    const updated = { ...card, choices: { ...base, [side]: [...pool, text] } }
    if (needsChoices(updated, side)) {
      void ensureChoicesGenerated(updated, side, deckCards, sourceLanguage, targetLanguage)
        .then(ai => { if (ai) onCardChange({ ...updated, choices: ai }) })
    }
  }

  async function updateBackSynonyms(newList: string[]) {
    const supabase = createClient()
    const base: CardChoices = card.choices ?? { front: [], back: [] }
    const updated: CardChoices = { ...base, backSynonyms: newList.length > 0 ? newList : undefined }
    await supabase.from('cards').update({ choices: updated }).eq('id', card.id)
    onCardChange({ ...card, choices: updated })
  }

  async function updateFrontSynonyms(newList: string[]) {
    const supabase = createClient()
    const base: CardChoices = card.choices ?? { front: [], back: [] }
    const updated: CardChoices = { ...base, frontSynonyms: newList.length > 0 ? newList : undefined }
    await supabase.from('cards').update({ choices: updated }).eq('id', card.id)
    onCardChange({ ...card, choices: updated })
  }

  async function handleAddSourceSynonym() {
    const text = sourceSynonymInput.trim()
    if (!text || synonymSaving) return
    setSynonymSaving(true)
    setSourceSynonymInput('')
    try {
      // Source-language synonym: check if a card with this front already exists.
      await loadAllPairCards()
      const matchedCard = allPairCards?.find(
        c => c.front.toLowerCase() === text.toLowerCase()
      ) ?? null

      if (matchedCard) {
        await handleLinkSynonym(matchedCard)
        return
      }

      // No card exists yet — save COMMON pending link so it auto-resolves later,
      // and add as placeholder to frontSynonyms so it's accepted during study now.
      const [pendingRepo] = [new SupabasePendingSynonymLinkRepository()]
      await pendingRepo.create(userId, text, sourceLanguage, targetLanguage, card.id)

      const existing = card.choices?.frontSynonyms ?? []
      if (!existing.some(s => s.toLowerCase() === text.toLowerCase())) {
        await updateFrontSynonyms([...existing, text])
      }
    } catch { /* non-fatal */ }
    finally { setSynonymSaving(false) }
  }

  async function handleAddTargetSynonym() {
    const text = targetSynonymInput.trim()
    if (!text || synonymSaving) return
    setSynonymSaving(true)
    setTargetSynonymInput('')
    try {
      const existing = card.choices?.backSynonyms ?? []
      if (!existing.some(s => s.toLowerCase() === text.toLowerCase())) {
        await updateBackSynonyms([...existing, text])
      }
    } catch { /* non-fatal */ }
    finally { setSynonymSaving(false) }
  }

  async function handleRemoveBackSynonym(text: string) {
    const existing = card.choices?.backSynonyms ?? []
    try { await updateBackSynonyms(existing.filter(s => s !== text)) }
    catch { /* non-fatal */ }
  }

  async function handleRemoveFrontSynonym(text: string) {
    const existing = card.choices?.frontSynonyms ?? []
    try { await updateFrontSynonyms(existing.filter(s => s !== text)) }
    catch { /* non-fatal */ }
  }

  async function handleLinkSynonym(target: Card) {
    if (linkSaving) return
    setLinkSaving(true)
    setLinkError(null)
    try {
      const supabase  = createClient()
      const thisBase  : CardChoices = card.choices   ?? { front: [], back: [] }
      const targetBase: CardChoices = target.choices ?? { front: [], back: [] }
      const thisBack   = displayText(card.back)
      const thisFront  = displayText(card.front)
      const targetBack = displayText(target.back)
      const targetFront = displayText(target.front)

      // backSynonyms: each card accepts the other's back (target-language) as correct
      const thisBacks   = thisBase.backSynonyms   ?? []
      const targetBacks = targetBase.backSynonyms ?? []
      const thisUpdatedBack = thisBacks.some(s => s.toLowerCase() === targetBack.toLowerCase())
        ? thisBacks : [...thisBacks, targetBack]
      const targetUpdatedBack = targetBacks.some(s => s.toLowerCase() === thisBack.toLowerCase())
        ? targetBacks : [...targetBacks, thisBack]

      // frontSynonyms: each card accepts the other's front (source-language) as correct
      const thisFronts   = thisBase.frontSynonyms   ?? []
      const targetFronts = targetBase.frontSynonyms ?? []
      const thisUpdatedFront = thisFronts.some(s => s.toLowerCase() === targetFront.toLowerCase())
        ? thisFronts : [...thisFronts, targetFront]
      const targetUpdatedFront = targetFronts.some(s => s.toLowerCase() === thisFront.toLowerCase())
        ? targetFronts : [...targetFronts, thisFront]

      const thisChoices: CardChoices   = { ...thisBase,   backSynonyms: thisUpdatedBack,   frontSynonyms: thisUpdatedFront }
      const targetChoices: CardChoices = { ...targetBase, backSynonyms: targetUpdatedBack, frontSynonyms: targetUpdatedFront }

      await supabase.from('cards').update({ choices: thisChoices   }).eq('id', card.id)
      await supabase.from('cards').update({ choices: targetChoices }).eq('id', target.id)
      onCardChange({ ...card, choices: thisChoices })

      setLinkSynonymMode(false)
      setLinkQuery('')
    } catch (err: unknown) {
      setLinkError(err instanceof Error ? err.message : 'Link failed')
    } finally {
      setLinkSaving(false)
    }
  }

  async function handleSavePendingLink(word: string) {
    if (linkSaving) return
    setLinkSaving(true)
    setLinkError(null)
    try {
      const repo = new SupabasePendingSynonymLinkRepository()
      await repo.create(userId, word, sourceLanguage, targetLanguage, card.id)
      setPendingLinkSaved(word)
      setLinkSynonymMode(false)
      setLinkQuery('')
      setTimeout(() => setPendingLinkSaved(null), 3000)
    } catch (err: unknown) {
      setLinkError(err instanceof Error ? err.message : 'Failed to save pending link')
    } finally {
      setLinkSaving(false)
    }
  }

  async function openMerge() {
    setMerging(true)
    setMergeQuery('')
    setMergeTarget(null)
    setMergeTargetState(undefined)
    setMergeSurvivorId(null)
    setMergeError(null)
    await loadAllPairCards()
  }

  async function selectMergeTarget(target: Card) {
    setMergeTarget(target)
    setMergeSurvivorId(isAMoreAdvanced(state, undefined) ? card.id : target.id)
    setMergeTargetState(undefined)
    try {
      const [stateRepo, cardRepo] = [new SupabaseCardStateRepository(), new SupabaseCardRepository()]
      const [ts, deckIds] = await Promise.all([
        stateRepo.get(userId, target.id),
        cardRepo.listDeckNamesForCards([target.id]),
      ])
      setMergeTargetState(ts ?? null)
      setMergeTargetDecks(deckIds[target.id] ?? [])
      setMergeSurvivorId(isAMoreAdvanced(state, ts) ? card.id : target.id)
    } catch { /* non-fatal */ }
  }

  async function executeMerge() {
    if (!mergeTarget || !mergeSurvivorId || mergeExecuting) return
    setMergeExecuting(true)
    setMergeError(null)
    try {
      const cardRepo  = new SupabaseCardRepository()
      const stateRepo = new SupabaseCardStateRepository()

      const deletedId  = mergeSurvivorId === card.id ? mergeTarget.id : card.id
      const survivorId = mergeSurvivorId

      // Get all deck memberships for both cards
      const [survivorDeckIds, deletedDeckIds] = await Promise.all([
        cardRepo.listDeckIdsForCard(survivorId),
        cardRepo.listDeckIdsForCard(deletedId),
      ])
      const survivorDeckSet = new Set(survivorDeckIds)

      // Add survivor to any deck the deleted card was in that survivor isn't
      for (const did of deletedDeckIds) {
        if (!survivorDeckSet.has(did)) await cardRepo.addToDeck(did, survivorId, 0)
      }

      // Determine final state for survivor: keep the more advanced one
      const currentState = state
      const targetState  = mergeTargetState
      const survivorIsCurrentCard = survivorId === card.id
      const survivorState = survivorIsCurrentCard ? currentState : targetState
      const deletedState  = survivorIsCurrentCard ? targetState  : currentState

      if (deletedState && !isAMoreAdvanced(survivorState ?? undefined, deletedState)) {
        // Deleted card's state is more advanced — copy it onto the survivor
        await stateRepo.copy(userId, deletedId, survivorId)
      }

      // Soft-delete the loser
      await cardRepo.softDelete(deletedId)

      // Fetch final survivor state to pass back
      const finalState = await stateRepo.get(userId, survivorId)
      const survivorCard = survivorIsCurrentCard ? card : mergeTarget

      onMerge?.(deletedId, survivorCard, finalState ?? undefined)
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Merge failed.')
    } finally {
      setMergeExecuting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="panel w-full max-w-lg space-y-4 mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Edit card</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => setShowResetMenu(s => !s)}
                title="Reset card"
                aria-label="Reset card"
                disabled={resetting}
                className="w-7 h-7 rounded-full border border-white/10 text-danger/80 hover:text-danger hover:border-danger/40 flex items-center justify-center transition-colors disabled:opacity-40"
              >
                <span className="text-base leading-none select-none">↺</span>
              </button>
              {showResetMenu && (
                <div className="absolute right-0 top-9 z-10 w-56 rounded-card border border-white/10 bg-surface-raised shadow-xl py-1 text-sm">
                  <button
                    onClick={() => { setShowResetMenu(false); setResetAction('distractors') }}
                    className="w-full text-left px-3 py-2 hover:bg-white/5 text-ink"
                  >
                    Reset distractors
                    <span className="block text-xs text-ink-faint">Clears cached multiple-choice options and regenerates them.</span>
                  </button>
                  <button
                    onClick={() => { setShowResetMenu(false); setResetAction('progress') }}
                    className="w-full text-left px-3 py-2 hover:bg-white/5 text-ink"
                  >
                    Reset progress
                    <span className="block text-xs text-ink-faint">Erases reps, lapses, schedule, etc. Keeps distractors and when it was introduced.</span>
                  </button>
                  {card.audioGenerated && TTS_SUPPORTED_LANGUAGES.has(sourceLanguage) && (
                    <button
                      onClick={() => { setShowResetMenu(false); setResetAction('audio') }}
                      className="w-full text-left px-3 py-2 hover:bg-white/5 text-ink"
                    >
                      Reset audio
                      <span className="block text-xs text-ink-faint">Clears cached audio so it will be regenerated.</span>
                    </button>
                  )}
                  <button
                    onClick={() => { setShowResetMenu(false); setResetAction('all') }}
                    className="w-full text-left px-3 py-2 hover:bg-white/5 text-danger"
                  >
                    Reset entirely
                    <span className="block text-xs text-ink-faint">Resets progress, distractors, and audio.</span>
                  </button>
                </div>
              )}
            </div>
            {onDelete && (
              confirmingDelete ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-danger">Delete?</span>
                  <button
                    onClick={async () => {
                      setDeleting(true)
                      try {
                        const cardRepo = new SupabaseCardRepository()
                        await cardRepo.softDelete(card.id)
                        onDelete(card.id)
                      } finally {
                        setDeleting(false)
                        setConfirmingDelete(false)
                      }
                    }}
                    disabled={deleting}
                    className="text-xs bg-danger/80 hover:bg-danger text-white px-2 py-0.5 rounded transition-colors disabled:opacity-50"
                  >
                    {deleting ? '…' : 'Yes'}
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                    className="text-xs text-ink-faint hover:text-ink px-1.5 py-0.5 rounded border border-white/10 transition-colors"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingDelete(true)}
                  title="Delete card"
                  aria-label="Delete card"
                  className="w-7 h-7 rounded-full border border-white/10 text-danger/60 hover:text-danger hover:border-danger/40 flex items-center justify-center transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                  </svg>
                </button>
              )
            )}
            <button
              onClick={() => setShowStats(s => !s)}
              title="Card stats"
              aria-label="Card stats"
              className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors
                ${showStats ? 'text-accent border-accent/40 bg-surface-raised' : 'border-white/10 text-ink-faint hover:text-ink hover:border-white/20'}`}
            >
              <span className="font-serif italic font-bold text-[13px] leading-none select-none">i</span>
            </button>
            <button onClick={onClose} className="text-ink-faint hover:text-ink text-lg leading-none">✕</button>
          </div>
        </div>

        {resetAction && (
          <ConfirmDialog
            message={
              resetAction === 'distractors'
                ? 'Clear the cached multiple-choice distractors for this card? Fresh ones will be generated in the background.'
                : resetAction === 'progress'
                  ? 'Erase this card\'s study progress (reps, lapses, ease, schedule, etc.)? It will go back to "never studied" but keep its cached distractors and introduction date.'
                  : resetAction === 'audio'
                    ? 'Clear the cached audio for this card? It will be regenerated the next time the card appears in a session.'
                    : 'Reset this card entirely — clears study progress, cached distractors, and audio? This can\'t be undone.'
            }
            onConfirm={handleConfirmReset}
            onCancel={() => setResetAction(null)}
          />
        )}

        {resetError && (
          <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">⚠ {resetError}</p>
        )}
        {resetDone && (
          <p className="text-success text-xs bg-success/10 border border-success/20 rounded-lg px-3 py-2">✓ {resetDone}</p>
        )}

        {/* Audio sources — pick which recording plays for this card */}
        {TTS_SUPPORTED_LANGUAGES.has(sourceLanguage) && (
          <div className="space-y-1.5">
            <p className="text-xs text-ink-faint">Audio for &ldquo;{card.front}&rdquo; — pick the one that sounds best:</p>
            {([
              { key: 'elevenlabs' as const, label: 'ElevenLabs', hint: 'AI voice' },
              { key: 'forvo' as const,      label: 'Forvo',      hint: 'native speaker' },
              { key: 'browser' as const,    label: 'Robotic',    hint: 'on-device' },
            ]).map(s => {
              const isActive = activeSource === s.key
              const hasClip  = s.key === 'browser' ? true : cachedClip(s.key) != null
              const busy     = busySource === s.key
              return (
                <div key={s.key} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${isActive ? 'border-accent/40 bg-accent/5' : 'border-white/10'}`}>
                  <button
                    onClick={() => playSource(s.key)}
                    disabled={busy}
                    className="text-ink-muted hover:text-ink disabled:opacity-40 shrink-0"
                    title={hasClip ? 'Play' : 'Fetch & play'}
                  >
                    {busy ? '…' : '🔊'}
                  </button>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-ink">{s.label}</span>
                    <span className="text-xs text-ink-faint ml-1.5">{s.hint}{s.key !== 'browser' && !hasClip ? ' · not fetched' : ''}</span>
                  </div>
                  {isActive ? (
                    <span className="text-xs text-accent font-medium shrink-0">Active</span>
                  ) : (
                    <button
                      onClick={() => selectSource(s.key)}
                      disabled={busy}
                      className="text-xs text-ink-muted hover:text-accent disabled:opacity-40 shrink-0"
                    >
                      Use this
                    </button>
                  )}
                </div>
              )
            })}
            {audioError && <p className="text-danger text-xs">{audioError}</p>}
          </div>
        )}

        {showStats && (
          <div className="rounded-card border border-white/5 bg-surface-raised/50 p-4 space-y-4 text-sm">
            {!state?.graduated && (
              <div className="border-b border-white/5 pb-3 space-y-2">
                <button
                  onClick={handleGraduateNow}
                  disabled={graduating || resetting}
                  className="w-full text-left px-3 py-2 rounded-lg border border-accent/20 bg-accent/5 hover:bg-accent/10 text-accent text-xs font-medium transition-colors disabled:opacity-40"
                >
                  {graduating ? 'Graduating…' : 'Graduate now'}
                  <span className="block text-ink-faint font-normal mt-0.5">
                    {graduateAccelerated
                      ? 'Accelerated track — first review spread across the next 14 days.'
                      : 'Skip the learning pipeline — card goes straight to graduated review (3-day first interval).'}
                  </span>
                </button>
                <label className="flex items-center gap-2 cursor-pointer select-none px-1">
                  <input
                    type="checkbox"
                    checked={graduateAccelerated}
                    onChange={e => setGraduateAccelerated(e.target.checked)}
                    className="accent-accent w-3.5 h-3.5"
                  />
                  <span className="text-xs text-ink-muted">Accelerated track</span>
                </label>
              </div>
            )}

            {/* ── Card properties ──────────────────────────────────────────── */}
            <div className="space-y-2">
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                Card
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-0.5">
                  <div className="text-xs text-ink-faint uppercase tracking-wider">Created</div>
                  <div className="text-ink font-medium text-sm">{formatDate(card.createdAt)}</div>
                </div>
                <div className="space-y-0.5">
                  <div className="text-xs text-ink-faint uppercase tracking-wider">Updated</div>
                  <div className="text-ink font-medium text-sm">{formatDate(card.updatedAt)}</div>
                </div>
                {card.register && card.register !== 'neutral' && (
                  <div className="space-y-0.5">
                    <div className="text-xs text-ink-faint uppercase tracking-wider">Register</div>
                    <div className="text-ink font-medium text-sm capitalize">{card.register}</div>
                  </div>
                )}
                {card.region && (
                  <div className="space-y-0.5">
                    <div className="text-xs text-ink-faint uppercase tracking-wider">Region</div>
                    <div className="text-ink font-medium text-sm">{card.region}</div>
                  </div>
                )}
                <div className="space-y-0.5">
                  <div className="text-xs text-ink-faint uppercase tracking-wider">Audio</div>
                  <div className={`text-sm font-medium ${card.audioGenerated ? 'text-success' : 'text-ink-faint'}`}>
                    {card.audioGenerated ? 'Generated' : 'Not yet generated'}
                  </div>
                </div>
                {card.synonymGroupId && (
                  <div className="space-y-0.5">
                    <div className="text-xs text-ink-faint uppercase tracking-wider">Synonym group</div>
                    <div className="text-ink font-medium text-sm font-mono text-[10px]">{card.synonymGroupId.slice(0, 8)}…</div>
                  </div>
                )}
                {card.ipa && (
                  <div className="space-y-0.5">
                    <div className="text-xs text-ink-faint uppercase tracking-wider">IPA</div>
                    <div className="text-ink font-medium text-sm">{card.ipa}</div>
                  </div>
                )}
              </div>
              {card.hints.length > 0 && (
                <div>
                  <div className="text-[10px] text-ink-faint mb-1">Hints</div>
                  <div className="flex flex-wrap gap-1">
                    {card.hints.map(h => <span key={h} className="chip">{h}</span>)}
                  </div>
                </div>
              )}
              {(card.acceptedFrontAlternatives?.length ?? 0) > 0 && (
                <div>
                  <div className="text-[10px] text-ink-faint mb-1">Accepted {langName(sourceLanguage)} alternatives</div>
                  <div className="flex flex-wrap gap-1">
                    {card.acceptedFrontAlternatives!.map(a => <span key={a} className="chip text-success/80">{a}</span>)}
                  </div>
                </div>
              )}
              {(card.acceptedBackAlternatives?.length ?? 0) > 0 && (
                <div>
                  <div className="text-[10px] text-ink-faint mb-1">Accepted {langName(targetLanguage)} alternatives</div>
                  <div className="flex flex-wrap gap-1">
                    {card.acceptedBackAlternatives!.map(a => <span key={a} className="chip text-success/80">{a}</span>)}
                  </div>
                </div>
              )}
            </div>

            {/* ── Synonyms (editable) ───────────────────────────────────────── */}
            <div className="space-y-2">
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                Synonyms <span className="normal-case font-normal opacity-60">(accepted as correct answers)</span>
              </div>
              {(card.choices?.backSynonyms?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-[10px] text-ink-faint self-center">{langName(targetLanguage)}:</span>
                  {card.choices!.backSynonyms!.map(s => (
                    <span key={s} className="flex items-center gap-1 chip text-success/80">
                      {s}
                      <button onClick={() => handleRemoveBackSynonym(s)} className="text-ink-faint hover:text-danger transition-colors leading-none ml-0.5" title="Remove">×</button>
                    </span>
                  ))}
                </div>
              )}
              {(card.choices?.frontSynonyms?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-[10px] text-ink-faint self-center">{langName(sourceLanguage)}:</span>
                  {card.choices!.frontSynonyms!.map(s => (
                    <span key={s} className="flex items-center gap-1 chip text-accent-soft">
                      {s}
                      <button onClick={() => handleRemoveFrontSynonym(s)} className="text-ink-faint hover:text-danger transition-colors leading-none ml-0.5" title="Remove">×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2 items-center">
                <span className="text-xs text-ink-faint w-20 shrink-0">{langName(targetLanguage)}:</span>
                <input className="input text-sm flex-1" placeholder={`Add ${langName(targetLanguage)} synonym…`}
                  value={targetSynonymInput} onChange={e => setTargetSynonymInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAddTargetSynonym() } }} />
                <button onClick={() => void handleAddTargetSynonym()} disabled={!targetSynonymInput.trim() || synonymSaving}
                  className="btn-ghost text-sm px-3 disabled:opacity-40">Add</button>
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-xs text-ink-faint w-20 shrink-0">{langName(sourceLanguage)}:</span>
                <input className="input text-sm flex-1" placeholder={`Add ${langName(sourceLanguage)} synonym…`}
                  value={sourceSynonymInput} onChange={e => setSourceSynonymInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAddSourceSynonym() } }} />
                <button onClick={() => void handleAddSourceSynonym()} disabled={!sourceSynonymInput.trim() || synonymSaving}
                  className="btn-ghost text-sm px-3 disabled:opacity-40">Add</button>
              </div>
              {pendingLinkSaved && (
                <p className="text-xs text-success/80">Pending link saved for &quot;{pendingLinkSaved}&quot; — it will auto-connect when you create that card.</p>
              )}
              {!linkSynonymMode ? (
                <button onClick={async () => { setLinkSynonymMode(true); setLinkQuery(''); setLinkError(null); setPendingLinkSaved(null); await loadAllPairCards() }}
                  className="text-xs text-ink-faint hover:text-ink-muted transition-colors">
                  ⇌ Link another card as synonym…
                </button>
              ) : (
                <div className="space-y-2 rounded-card border border-white/10 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-ink-muted uppercase tracking-wider">Link synonym card</p>
                    <button onClick={() => { setLinkSynonymMode(false); setLinkQuery(''); setLinkError(null) }} className="text-xs text-ink-faint hover:text-ink transition-colors">Cancel</button>
                  </div>
                  <p className="text-xs text-ink-faint">Pick an existing card, or type a word that doesn&apos;t exist yet to save a pending connection.</p>
                  <input autoFocus className="input text-sm w-full" placeholder="Search by front or back…"
                    value={linkQuery} onChange={e => setLinkQuery(e.target.value)} />
                  {mergeCardsLoading && <p className="text-xs text-ink-faint">Loading…</p>}
                  {linkError && <p className="text-xs text-danger">{linkError}</p>}
                  {allPairCards && (() => {
                    const q = linkQuery.trim()
                    const results = q
                      ? allPairCards.filter(c => c.front.toLowerCase().includes(q.toLowerCase()) || c.back.toLowerCase().includes(q.toLowerCase()))
                      : allPairCards
                    return (
                      <>
                        {results.length > 0 && (
                          <div className="rounded-card border border-white/10 divide-y divide-white/5 max-h-44 overflow-y-auto">
                            {results.slice(0, 50).map(c => (
                              <button key={c.id} onClick={() => void handleLinkSynonym(c)} disabled={linkSaving}
                                className="w-full flex items-center gap-4 px-3 py-2.5 hover:bg-surface-raised/50 text-left transition-colors disabled:opacity-50">
                                <span className="text-sm font-medium text-ink w-32 truncate shrink-0">{displayText(c.front)}</span>
                                <span className="text-sm text-ink-muted truncate">{displayText(c.back)}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {results.length === 0 && q && (
                          <div className="rounded-card border border-white/10 px-3 py-3 space-y-2">
                            <p className="text-xs text-ink-faint">No card named &quot;{q}&quot; exists yet.</p>
                            <button onClick={() => void handleSavePendingLink(q)} disabled={linkSaving}
                              className="text-xs text-accent hover:text-accent/80 transition-colors disabled:opacity-50">
                              {linkSaving ? 'Saving…' : `Save pending link for "${q}" →`}
                            </button>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              )}
            </div>

            {!state ? (
              <p className="text-ink-faint text-xs">New — not yet studied. No stats yet.</p>
            ) : (() => {
              const status = state.dormant
                ? 'Dormant'
                : state.graduated
                ? 'Graduated'
                : `Learning — Step ${state.currentStepOrder + 1}`
              const rating = state.lastRating
              const reviewMode = state.graduated ? classifyReviewMode(state, new Date()) : null
              const reviewModeLabel = reviewMode === 'due'
                ? 'Due now'
                : reviewMode === 'elective'
                  ? 'Elective (early)'
                  : '—'

              const typedTotal = state.typedAccuracyWindow.length
              const typedCorrect = state.typedAccuracyWindow.reduce((sum, v) => sum + v, 0)
              const typedAccuracy = typedTotal > 0
                ? `${Math.round((typedCorrect / typedTotal) * 100)}% (${typedCorrect}/${typedTotal})`
                : '—'

              const relearnLabel = state.relearningStep === 0
                ? 'Not in relearn loop'
                : `Step ${state.relearningStep} (10-min retry)`

              const intervalHistoryLabel = state.intervalHistory.length > 0
                ? state.intervalHistory.map(d => formatIntervalDays(d)).join(' → ')
                : '—'

              const currentStep = pipeline?.steps.find(s => s.stepOrder === state.currentStepOrder)
              const errorTotal = state.accentMistakeCount + state.articleMistakeCount + state.genderMistakeCount
                + state.typoMistakeCount + state.semanticMistakeCount + state.wrongSynonymCount

              return (
                <>
                  <StatGroup title="Status" rows={[
                    ['Status',         status],
                    ['Review mode',    reviewModeLabel],
                    ['Reps',           String(state.reps)],
                    ['Lapses',         String(state.lapses)],
                    ['Ease',           state.ease.toFixed(2)],
                    ['Last rating',    rating ? rating.charAt(0).toUpperCase() + rating.slice(1) : '—'],
                    ["I don't know",   String(state.iDontKnowCount)],
                  ]} />

                  {/* Dormancy controls */}
                  <div className="space-y-1.5">
                    <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                      Dormancy
                    </div>
                    <p className="text-[10px] text-ink-faint leading-relaxed">
                      A dormant card stays in the deck and is reviewable, but never becomes due automatically.
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-ink-muted">Go dormant after</span>
                      <input
                        type="number" min={1} max={999}
                        className="input text-center text-sm px-1 py-1 w-16"
                        placeholder="—"
                        value={dormancyInput}
                        onChange={e => setDormancyInput(e.target.value)}
                      />
                      <span className="text-xs text-ink-muted">production reviews</span>
                    </div>
                    <div className="flex items-center gap-3 pt-0.5">
                      {state.dormant ? (
                        <button
                          disabled={dormancyBusy}
                          className="text-xs text-accent hover:underline disabled:opacity-50"
                          onClick={() => applyDormancy({ dormant: false }).catch(() => {})}
                        >↺ Wake from dormancy</button>
                      ) : (
                        <>
                        <button
                          disabled={!state.graduated}
                          className="text-xs text-accent hover:underline disabled:opacity-40"
                          onClick={() => setDormancyInput(String(state.reps + 1))}
                          title="Sets the threshold so this card goes dormant after your next production review (save to apply)"
                        >Dormant after next review</button>
                        <button
                          disabled={dormancyBusy || !state.graduated}
                          className="text-xs text-ink-faint hover:text-ink disabled:opacity-40"
                          onClick={() => applyDormancy({ dormant: true }).catch(() => {})}
                        >Make dormant now</button>
                        </>
                      )}
                    </div>
                    {dormancyMsg && (
                      <p className={`text-xs ${dormancyMsg.ok ? 'text-success' : 'text-danger'}`}>
                        {dormancyMsg.ok ? '✓ ' : '⚠ '}{dormancyMsg.text}
                      </p>
                    )}
                  </div>

                  {!state.graduated && (
                    <>
                      <StatGroup title="Pipeline progress" rows={[
                        ['Correct in step',     currentStep
                          ? `${state.correctInStep} / ${currentStep.requiredCorrect}`
                          : String(state.correctInStep)],
                        ['Step type',           currentStep?.stepType ?? '—'],
                        ['Typing streak',       String(state.typingMistakeStreak)],
                        ['Typing fail cycles',  String(state.typingFailCycles)],
                        ['Same-day window',     state.stage3EnteredDate ?? 'Not entered'],
                      ]} />
                      <div className="space-y-1.5">
                        <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                          Graduation interval
                        </div>
                        <p className="text-[10px] text-ink-faint leading-relaxed">
                          Based on total struggles (wrong typing answers + ? presses + Repeat presses) during this pipeline run.
                        </p>
                        <table className="w-full text-xs border-collapse">
                          <thead>
                            <tr className="text-ink-faint">
                              <th className="text-left font-normal py-0.5 pr-3">Struggles</th>
                              <th className="text-left font-normal py-0.5 pr-3">Range</th>
                              <th className="text-left font-normal py-0.5">Ideal</th>
                            </tr>
                          </thead>
                          <tbody className="text-ink-muted">
                            {([
                              ['0',  '4–6 days', '5 days'],
                              ['1',  '3–4 days', '3 days'],
                              ['2',  '2–3 days', '2 days'],
                              ['3',  '1–2 days', '1 day'],
                              ['4+', '1 day',    '1 day'],
                            ] as const).map(([s, r, i]) => (
                              <tr key={s}>
                                <td className="py-0.5 pr-3 font-medium text-ink">{s}</td>
                                <td className="py-0.5 pr-3">{r}</td>
                                <td className="py-0.5">{i}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {(() => {
                    const reviewWindow = (() => {
                      if (!state.graduated || !state.lastReviewedAt || !state.dueAt) return '—'
                      const rating = state.lastRating
                      if (!rating || rating === 'again') return '—'
                      const r = MULTIPLIER_RANGE[rating]
                      const sched = state.scheduledIntervalDays > 0 ? state.scheduledIntervalDays : state.intervalDays
                      if (sched <= 0) return '—'
                      const prevInterval = sched / r.ideal
                      const base = new Date(state.lastReviewedAt).getTime()
                      const minDate = new Date(base + prevInterval * r.min * 86400_000)
                      const maxDate = new Date(base + prevInterval * r.max * 86400_000)
                      return `${formatDate(minDate.toISOString())} → ${formatDate(maxDate.toISOString())}`
                    })()
                    const gradIntervalDays = state.graduated && state.intervalHistory.length > 0
                      ? state.intervalHistory[0]! : null
                    const isSmartTrack = state.graduated && state.smartDueAt != null
                    const isDualTrack = state.graduated && state.typedDueAt != null
                    const hasRecallTrack = state.graduated && (state.recallDueAt != null || state.recallIntervalDays != null)
                    const prodInterval = state.smartIntervalDays ?? state.typedIntervalDays ?? state.intervalDays
                    const prodDue = state.smartDueAt ?? state.typedDueAt ?? state.dueAt
                    const prodTitle = isSmartTrack ? 'Smart typing track (typed below threshold, else self-graded)'
                      : isDualTrack ? 'Production track (typed / self-graded)' : 'Scheduling'
                    return (<>
                      {/* Production track (typed / smart / self-graded forward reviews) */}
                      <StatGroup title={prodTitle} rows={[
                        ['Interval (ideal)',    formatIntervalDays(prodInterval)],
                        ['Scheduled interval',  formatIntervalDays(state.scheduledIntervalDays)],
                        ['Review window',       reviewWindow],
                        ['Next due',            state.graduated ? formatDate(prodDue) : '—'],
                        ['Last reviewed',       formatDate(state.lastReviewedAt, 'Never')],
                      ]} />

                      {/* Recall track (created by soft-wrong dual-track splits) */}
                      {hasRecallTrack && (
                        <StatGroup title="Recall track" rows={[
                          ['Interval',  formatIntervalDays(state.recallIntervalDays)],
                          ['Next due',  formatDate(state.recallDueAt)],
                        ]} />
                      )}

                      {/* Milestones */}
                      <StatGroup title="Milestones" rows={[
                        ['Introduced',          formatDate(state.introducedDate, 'Not yet')],
                        ['Graduated at',        formatDate(state.graduatedAt, '—')],
                        ...(gradIntervalDays != null ? [
                          ['Graduation interval', formatIntervalDays(gradIntervalDays)] as [string, string],
                          ['Difficulty score',    String(state.graduationErrorCount ?? 0)] as [string, string],
                        ] : []),
                      ]} />
                    </>)
                  })()}

                  <StatGroup title="Lapses & relearning" rows={[
                    ['Recent lapses (cluster)', String(state.lapseClusterCount)],
                    ['Last lapse',              formatDate(state.lastLapseAt, '—')],
                    ['Relearn step',            relearnLabel],
                    ['Pending interval',        state.pendingIntervalDays != null
                      ? `${formatIntervalDays(state.pendingIntervalDays)} (on recovery)`
                      : '—'],
                  ]} />

                  <StatGroup title="Typed production" rows={[
                    ['Typed reviews',           String(state.typedReviewCount)],
                    ['Typed accuracy (recent)',  typedAccuracy],
                    ['Last typed review',        formatDate(state.lastTypedReviewAt, 'Never')],
                    ['Forced typed remaining',   String(state.forcedTypedRemaining)],
                  ]} />

                  {errorTotal > 0 && (
                    <StatGroup title="Error breakdown" rows={[
                      ['Accent',       String(state.accentMistakeCount)],
                      ['Article',      String(state.articleMistakeCount)],
                      ['Gender',       String(state.genderMistakeCount)],
                      ['Typo',         String(state.typoMistakeCount)],
                      ['Semantic',     String(state.semanticMistakeCount)],
                      ['Wrong synonym',String(state.wrongSynonymCount)],
                    ]} />
                  )}

                  <div className="space-y-1">
                    <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                      Interval history
                    </div>
                    <div className="text-ink font-medium text-sm break-words">{intervalHistoryLabel}</div>
                  </div>
                </>
              )
            })()}

            {/* Sync origin — only shown for AI-synced cards */}
            {(card.syncedFromLanguages?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                  Sync origin
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-faint">Synced from</span>
                    <span className="text-xs text-ink font-medium">{card.syncedFromLanguages!.map(langName).join(', ')}</span>
                  </div>
                  {(card.originWords?.length ?? 0) > 0 && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-ink-faint">Origin word</span>
                      <span className="text-xs text-ink font-medium">{card.originWords!.join(', ')}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Fast-track — only shown for import-known cards */}
            {state && (state.acceleratedMode === 'import_known' || state.acceleratedLocked) && (
              <div className="space-y-2">
                <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                  Fast-track
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-faint">Status</span>
                    <span className="text-xs text-ink font-medium">
                      {state.acceleratedMode === 'none'
                        ? 'Turned off (2 wrong in a row)'
                        : state.acceleratedPenalty > 0
                          ? `Active (${state.acceleratedPenalty} penalt${state.acceleratedPenalty !== 1 ? 'ies' : 'y'})`
                          : 'Active'}
                    </span>
                  </div>
                  {state.acceleratedLocked && state.acceleratedMode !== 'none' && (
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs text-ink-faint">Locked</span>
                      <span className="text-xs text-ink-muted text-right">Accumulated interval won&apos;t reset if fast-track turns off</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Distractors */}
            <div className="space-y-2">
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                Distractors
              </div>
              {card.choices ? (
                <div className="space-y-3">
                  {(['back', 'front'] as const).map(side => {
                    const pool = card.choices![side]
                    const label = side === 'back'
                      ? `Prompt ${langName(sourceLanguage)} → pick ${langName(targetLanguage)}`
                      : `Prompt ${langName(targetLanguage)} → pick ${langName(sourceLanguage)}`
                    return (
                      <div key={side} className="space-y-1.5">
                        <div className="text-[10px] text-ink-faint">{label}</div>
                        <div className="flex flex-wrap gap-1">
                          {pool.map(d => {
                            const isEditing = editingDistractor?.[0] === side && editingDistractor?.[1] === d
                            return isEditing ? (
                              <input
                                key={d}
                                autoFocus
                                className="input text-xs px-2 py-0.5 h-auto w-32"
                                value={distractorEditText}
                                onChange={e => setDistractorEditText(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') void handleDistractorSaveEdit(side, d)
                                  if (e.key === 'Escape') setEditingDistractor(null)
                                }}
                                onBlur={() => void handleDistractorSaveEdit(side, d)}
                              />
                            ) : (
                              <span
                                key={d}
                                className="chip flex items-center gap-1 cursor-pointer hover:border-white/20 group"
                                onClick={() => { setEditingDistractor([side, d]); setDistractorEditText(d) }}
                                title="Click to edit"
                              >
                                {d}
                                <button
                                  onClick={e => { e.stopPropagation(); void handleDistractorDelete(side, d) }}
                                  className="text-ink-faint hover:text-danger transition-colors leading-none opacity-0 group-hover:opacity-100"
                                  title="Delete"
                                >×</button>
                              </span>
                            )
                          })}
                        </div>
                        {/* Add distractor */}
                        <div className="flex gap-1.5">
                          <input
                            className="input text-xs px-2 py-1 h-auto flex-1"
                            placeholder="Add distractor…"
                            value={distractorAddText[side]}
                            onChange={e => setDistractorAddText(prev => ({ ...prev, [side]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') void handleDistractorAdd(side) }}
                          />
                          <button
                            onClick={() => void handleDistractorAdd(side)}
                            disabled={!distractorAddText[side].trim()}
                            className="text-xs text-ink-faint hover:text-ink transition-colors disabled:opacity-30 px-1"
                          >Add</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-ink-faint text-xs italic">Not yet generated — will be created during your next study session.</p>
                  {(['back', 'front'] as const).map(side => {
                    const label = side === 'back'
                      ? `Prompt ${langName(sourceLanguage)} → pick ${langName(targetLanguage)}`
                      : `Prompt ${langName(targetLanguage)} → pick ${langName(sourceLanguage)}`
                    return (
                      <div key={side} className="space-y-1">
                        <div className="text-[10px] text-ink-faint">{label}</div>
                        <div className="flex gap-1.5">
                          <input
                            className="input text-xs px-2 py-1 h-auto flex-1"
                            placeholder="Add distractor…"
                            value={distractorAddText[side]}
                            onChange={e => setDistractorAddText(prev => ({ ...prev, [side]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') void handleDistractorAdd(side) }}
                          />
                          <button
                            onClick={() => void handleDistractorAdd(side)}
                            disabled={!distractorAddText[side].trim()}
                            className="text-xs text-ink-faint hover:text-ink transition-colors disabled:opacity-30 px-1"
                          >Add</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Typed answer overrides */}
            {overrides.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                  Answer overrides
                </div>
                <div className="space-y-2">
                  {(['front', 'back'] as const).map(side => {
                    const sideOverrides = overrides.filter(o => o.answerSide === side)
                    if (sideOverrides.length === 0) return null
                    return (
                      <div key={side}>
                        <div className="text-[10px] text-ink-faint mb-1">
                          {side === 'front' ? langName(sourceLanguage) : langName(targetLanguage)} answers (marked correct)
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {sideOverrides.map(o => <span key={o.answerText} className="chip text-warning/80">{o.answerText}</span>)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Often confused with */}
            {confusions.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                  Often confused with
                </div>
                <div className="space-y-2">
                  {confusions.map(c => {
                    const linked = c.confusedWithCardId ? deckCards.find(d => d.id === c.confusedWithCardId) : undefined
                    const sideLabel = c.answerSide === 'front' ? langName(sourceLanguage) : langName(targetLanguage)
                    return (
                      <div key={`${c.confusedText}-${c.answerSide}`} className="space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-ink font-medium break-words">{c.confusedText}</span>
                            {linked && <span className="text-ink-faint text-xs"> — {linked.back}</span>}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="chip">{c.count}×</span>
                            {linked && onJumpToCard && (
                              <button onClick={() => onJumpToCard(linked.id)} className="text-xs text-accent hover:text-accent-soft transition-colors">
                                Open
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-ink-faint">
                          <span>{sideLabel} answer</span>
                          {c.isWordMixup && <span className="text-warning/70">word-level mixup</span>}
                          <span>last: {formatDate(c.lastConfusedAt)}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* ── Confusion links ─────────────────────────────────────── */}
            <div className="space-y-2">
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                Confusion links
              </div>
              {confusionLinks.length > 0 && (
                <div className="space-y-1.5">
                  {confusionLinks.map(link => {
                    const otherId = link.cardAId === card.id ? link.cardBId : link.cardAId
                    const other   = deckCards.find(d => d.id === otherId)
                    if (!other) return null
                    return (
                      <div key={link.id} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="text-ink font-medium text-sm">{displayText(other.front)}</span>
                          <span className="text-ink-faint text-xs"> — {displayText(other.back)}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {onJumpToCard && (
                            <button onClick={() => onJumpToCard(otherId)} className="text-xs text-accent hover:text-accent-soft transition-colors">
                              Open
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              await new SupabaseCardConfusionLinkRepository().unlink(userId, card.id, otherId)
                              setConfusionLinks(prev => prev.filter(l => l.id !== link.id))
                            }}
                            className="text-ink-faint hover:text-danger transition-colors text-xs"
                          >×</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {!linkConfusionMode ? (
                <button
                  onClick={async () => { setLinkConfusionMode(true); setLinkConfusionQuery(''); setLinkConfusionError(null); await loadAllPairCards() }}
                  className="text-xs text-ink-faint hover:text-ink-muted transition-colors"
                >
                  ⇌ Link confused card…
                </button>
              ) : (
                <div className="space-y-2 rounded-card border border-white/10 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-ink-muted uppercase tracking-wider">Link confused card</p>
                    <button onClick={() => { setLinkConfusionMode(false); setLinkConfusionQuery(''); setLinkConfusionError(null) }} className="text-xs text-ink-faint hover:text-ink transition-colors">Cancel</button>
                  </div>
                  <input
                    autoFocus
                    className="input text-sm w-full"
                    placeholder="Search by front or back…"
                    value={linkConfusionQuery}
                    onChange={e => setLinkConfusionQuery(e.target.value)}
                  />
                  {mergeCardsLoading && <p className="text-xs text-ink-faint">Loading…</p>}
                  {linkConfusionError && <p className="text-xs text-danger">{linkConfusionError}</p>}
                  {allPairCards && (() => {
                    const q = linkConfusionQuery.trim()
                    const results = q
                      ? allPairCards.filter(c =>
                          !confusionLinks.some(l => l.cardAId === c.id || l.cardBId === c.id) &&
                          (c.front.toLowerCase().includes(q.toLowerCase()) || c.back.toLowerCase().includes(q.toLowerCase()))
                        )
                      : allPairCards.filter(c => !confusionLinks.some(l => l.cardAId === c.id || l.cardBId === c.id))
                    return results.length > 0 ? (
                      <div className="rounded-card border border-white/10 divide-y divide-white/5 max-h-44 overflow-y-auto">
                        {results.slice(0, 50).map(c => (
                          <button
                            key={c.id}
                            disabled={linkConfusionSaving}
                            onClick={async () => {
                              setLinkConfusionSaving(true)
                              setLinkConfusionError(null)
                              try {
                                await new SupabaseCardConfusionLinkRepository().link(userId, card.id, c.id)
                                const updated = await new SupabaseCardConfusionLinkRepository().listForCard(userId, card.id)
                                setConfusionLinks(updated)
                                setLinkConfusionMode(false)
                                setLinkConfusionQuery('')
                              } catch (err) {
                                setLinkConfusionError(err instanceof Error ? err.message : 'Failed to link card')
                              } finally {
                                setLinkConfusionSaving(false)
                              }
                            }}
                            className="w-full flex items-center gap-4 px-3 py-2.5 hover:bg-surface-raised/50 text-left transition-colors disabled:opacity-50"
                          >
                            <span className="text-sm font-medium text-ink w-32 truncate shrink-0">{displayText(c.front)}</span>
                            <span className="text-sm text-ink-muted truncate">{displayText(c.back)}</span>
                          </button>
                        ))}
                      </div>
                    ) : q ? (
                      <p className="text-xs text-ink-faint">No cards match &quot;{q}&quot;.</p>
                    ) : null
                  })()}
                </div>
              )}
            </div>

            {/* ── Review history ──────────────────────────────────────── */}
            {(() => {
              if (reviewsLoading) return (
                <div className="space-y-2">
                  <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">Review History</div>
                  <p className="text-xs text-ink-faint">Loading…</p>
                </div>
              )
              const events = reviewHistory ?? []
              if (events.length === 0 && !reviewsLoading) return (
                <div className="space-y-2">
                  <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">Review History</div>
                  <p className="text-xs text-ink-faint italic">No reviews yet.</p>
                </div>
              )

              // Classify each event into a track
              function eventTrack(e: ReviewEvent): 'typed' | 'recall' | 'recognition' {
                if (e.wasTyped === true)  return 'typed'
                if (e.wasTyped === false) return e.reviewDirection === 'reverse' ? 'recognition' : 'recall'
                if (e.mode === 'typing')  return 'typed'
                return 'recognition'
              }

              const trackCounts = events.reduce<Record<string, number>>((acc, e) => {
                const t = eventTrack(e); acc[t] = (acc[t] ?? 0) + 1; return acc
              }, {})

              const TRACKS: { key: 'typed' | 'recall' | 'recognition'; label: string }[] = [
                { key: 'typed',       label: 'Typed production'      },
                { key: 'recall',      label: 'Self-graded production' },
                { key: 'recognition', label: 'Recognition'            },
              ]
              const availableTracks = TRACKS.filter(t => (trackCounts[t.key] ?? 0) > 0)
              const activeTrack = availableTracks.find(t => t.key === historyTrack) ?? availableTracks[0]

              const filtered = activeTrack ? events.filter(e => eventTrack(e) === activeTrack.key) : []

              const RATING_STYLE: Record<string, string> = {
                again: 'bg-danger/20 text-danger border-danger/30',
                hard:  'bg-warning/20 text-warning border-warning/30',
                good:  'bg-success/20 text-success border-success/30',
                easy:  'bg-accent/20 text-accent border-accent/30',
              }

              // Per-track scheduling info
              function trackSchedule(key: 'typed' | 'recall' | 'recognition') {
                if (key === 'typed')   return state ? { interval: state.smartIntervalDays ?? state.typedIntervalDays ?? state.intervalDays, due: state.smartDueAt ?? state.typedDueAt ?? state.dueAt } : null
                if (key === 'recall')  return state ? { interval: state.recallIntervalDays, due: state.recallDueAt } : null
                const rs = reverseCardState
                return rs ? { interval: rs.recallIntervalDays, due: rs.recallDueAt } : null
              }
              function fmtInterval(d: number | null | undefined) {
                if (!d) return null
                if (d < 1) return `${Math.round(d * 24)}h`
                return `${Math.round(d)}d`
              }
              function fmtDue(iso: string | null | undefined) {
                if (!iso) return null
                const d = new Date(iso)
                const now = new Date()
                const diffMs = d.getTime() - now.getTime()
                const diffDays = Math.round(diffMs / 86_400_000)
                if (diffDays < 0)  return 'overdue'
                if (diffDays === 0) return 'today'
                if (diffDays === 1) return 'tomorrow'
                return `in ${diffDays}d`
              }
              const activeSched = activeTrack ? trackSchedule(activeTrack.key) : null

              return (
                <div className="space-y-2">
                  <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                    Review History
                  </div>
                  {/* Track tabs */}
                  {availableTracks.length > 1 && (
                    <div className="flex gap-1 flex-wrap">
                      {availableTracks.map(t => (
                        <button
                          key={t.key}
                          onClick={() => setHistoryTrack(t.key)}
                          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                            historyTrack === t.key
                              ? 'bg-accent/20 border-accent/40 text-accent'
                              : 'border-white/10 text-ink-faint hover:text-ink hover:border-white/20'
                          }`}
                        >
                          {t.label} <span className="opacity-60">({trackCounts[t.key]})</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Per-track scheduling info */}
                  {activeSched && (activeSched.interval || activeSched.due) && (
                    <div className="flex gap-3 text-[11px] text-ink-faint">
                      {activeSched.interval != null && (
                        <span>Interval: <span className="text-ink-muted">{fmtInterval(activeSched.interval)}</span></span>
                      )}
                      {activeSched.due && (
                        <span>Due: <span className="text-ink-muted">{fmtDue(activeSched.due)}</span></span>
                      )}
                    </div>
                  )}
                  {/* Event list */}
                  <div className="space-y-1">
                    {filtered.slice(0, 50).map(e => {
                      const rating    = e.rating ?? (e.wasCorrect ? 'good' : 'again')
                      const ratingLbl = rating.charAt(0).toUpperCase() + rating.slice(1)
                      const ratingCls = RATING_STYLE[rating] ?? RATING_STYLE.again
                      const dateStr   = new Date(e.reviewedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      const timeStr   = new Date(e.reviewedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                      return (
                        <div key={e.id} className="flex items-center justify-between gap-2 py-0.5">
                          <span className="text-[11px] text-ink-faint tabular-nums shrink-0">{dateStr} · {timeStr}</span>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {e.hintLevel > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded border font-medium bg-accent/15 text-accent border-accent/30"
                                title={`Used a hint (level ${e.hintLevel})`}>
                                Hint{e.hintLevel > 1 ? ` ×${e.hintLevel}` : ''}
                              </span>
                            )}
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${ratingCls}`}>{ratingLbl}</span>
                          </div>
                        </div>
                      )
                    })}
                    {filtered.length > 50 && (
                      <p className="text-[10px] text-ink-faint">Showing 50 most recent of {filtered.length}</p>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs text-ink-muted uppercase tracking-wider">Front</label>
          <textarea
            ref={frontRef}
            className="input resize-none min-h-[80px] font-medium"
            value={front}
            onChange={e => setFront(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-ink-muted uppercase tracking-wider">Back</label>
          <textarea
            className="input resize-none min-h-[80px]"
            value={back}
            onChange={e => setBack(e.target.value)}
          />
        </div>

        {validErr && <p className="text-danger text-xs">{validErr}</p>}

        <div className="flex gap-3 flex-wrap">
          <button
            className="btn-primary flex-1"
            onClick={handleSave}
            disabled={saving}
          >
            {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save'}
          </button>
          {onSyncCard && (
            <button
              className="btn-ghost text-accent border border-accent/30 hover:border-accent/60"
              onClick={onSyncCard}
              title="Sync to other language pairs"
            >
              ⟳ Sync
            </button>
          )}
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
        </div>

        {onMerge && !merging && (
          <button
            onClick={openMerge}
            className="text-xs text-ink-faint hover:text-ink-muted transition-colors w-full text-center pt-1"
          >
            ⇌ Merge with another card…
          </button>
        )}

        {/* ── Merge UI ────────────────────────────────────────── */}
        {merging && (
          <div className="border-t border-white/10 pt-4 space-y-3">
            {!mergeTarget ? (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-ink-muted uppercase tracking-wider">Merge with…</p>
                  <button onClick={() => setMerging(false)} className="text-xs text-ink-faint hover:text-ink transition-colors">Cancel</button>
                </div>
                <input
                  autoFocus
                  className="input text-sm w-full"
                  placeholder="Search by front or back…"
                  value={mergeQuery}
                  onChange={e => setMergeQuery(e.target.value)}
                />
                {mergeCardsLoading && <p className="text-xs text-ink-faint">Loading…</p>}
                {mergeError && <p className="text-xs text-danger">{mergeError}</p>}
                {allPairCards && (() => {
                  const q = mergeQuery.trim().toLowerCase()
                  const results = q
                    ? allPairCards.filter(c =>
                        c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q))
                    : allPairCards
                  return results.length === 0 ? (
                    <p className="text-xs text-ink-faint text-center py-3">No cards found.</p>
                  ) : (
                    <div className="rounded-card border border-white/10 divide-y divide-white/5 max-h-52 overflow-y-auto">
                      {results.slice(0, 50).map(c => (
                        <button
                          key={c.id}
                          onClick={() => selectMergeTarget(c)}
                          className="w-full flex items-center gap-4 px-3 py-2.5 hover:bg-surface-raised/50 text-left transition-colors"
                        >
                          <span className="text-sm font-medium text-ink w-32 truncate shrink-0">{c.front}</span>
                          <span className="text-sm text-ink-muted truncate">{c.back}</span>
                        </button>
                      ))}
                    </div>
                  )
                })()}
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => { setMergeTarget(null); setMergeTargetState(undefined); setMergeSurvivorId(null) }}
                    className="text-xs text-ink-faint hover:text-ink transition-colors flex items-center gap-1"
                  >
                    ← Back
                  </button>
                  <p className="text-xs font-medium text-ink-muted uppercase tracking-wider">Choose which card to keep</p>
                  <button onClick={() => setMerging(false)} className="text-xs text-ink-faint hover:text-ink transition-colors">Cancel</button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { c: card,        s: state,           label: 'This card' },
                    { c: mergeTarget, s: mergeTargetState, label: mergeTargetDecks.length ? mergeTargetDecks.join(', ') : 'Other card' },
                  ] as const).map(({ c, s, label }) => {
                    const chosen = mergeSurvivorId === c.id
                    const recommended = isAMoreAdvanced(
                      c.id === card.id ? state : mergeTargetState ?? undefined,
                      c.id === card.id ? mergeTargetState ?? undefined : state,
                    )
                    return (
                      <button
                        key={c.id}
                        onClick={() => setMergeSurvivorId(c.id)}
                        className={`rounded-card border p-3 text-left space-y-1.5 transition-colors ${chosen ? 'border-accent/60 bg-accent/5' : 'border-white/10 hover:border-white/20'}`}
                      >
                        <div className="flex items-start justify-between gap-1">
                          <p className="text-xs text-ink-faint truncate">{label}</p>
                          {recommended && <span className="text-[10px] text-accent shrink-0">recommended</span>}
                        </div>
                        <p className="text-sm font-medium text-ink leading-snug">{c.front}</p>
                        <p className="text-xs text-ink-muted leading-snug">{c.back}</p>
                        <p className="text-[11px] text-ink-faint mt-1">{stateProgress(s)}</p>
                      </button>
                    )
                  })}
                </div>
                {mergeError && <p className="text-xs text-danger">{mergeError}</p>}
                <p className="text-xs text-ink-faint">
                  The chosen card will be added to both decks.
                  {isAMoreAdvanced(state, mergeTargetState ?? undefined) !== (mergeSurvivorId === card.id)
                    ? ' The further-along progress will be kept.'
                    : ''}
                </p>
                <button
                  onClick={executeMerge}
                  disabled={!mergeSurvivorId || mergeExecuting}
                  className="btn-primary w-full disabled:opacity-50"
                >
                  {mergeExecuting ? 'Merging…' : 'Merge cards'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
