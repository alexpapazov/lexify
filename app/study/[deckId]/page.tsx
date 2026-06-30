'use client'

import { useEffect, useState, useRef } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }            from '@/lib/data/decks'
import { SupabaseCardRepository }            from '@/lib/data/cards'
import { SupabaseCardStateRepository }       from '@/lib/data/cardStates'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { SupabaseFolderRepository }          from '@/lib/data/folders'
import { SupabasePipelineRepository }        from '@/lib/data/pipelines'
import { SupabaseCardConfusionRepository }   from '@/lib/data/cardConfusions'
import { SupabaseSynonymGroupRepository }    from '@/lib/data/synonymGroups'
import { SupabaseLanguageSyncRuleRepository } from '@/lib/data/languageSyncRules'
import { SupabaseSyncedCardLinkRepository }  from '@/lib/data/syncedCardLinks'
import { SupabaseLanguagePairRepository }    from '@/lib/data/languagePairs'
import { ensureSyncInfra }                   from '@/lib/syncFolderInfra'
import { triggerSyncFill }                   from '@/lib/triggerSyncFill'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import { SupabasePendingSynonymLinkRepository } from '@/lib/data/pendingSynonymLinks'
import { SupabaseCardConfusionLinkRepository } from '@/lib/data/cardConfusionLinks'
import type { Deck, Card, CardState, CardChoices, CardConfusion, CardConfusionLink, DeckPreferences, Folder, LanguagePair, LanguageSyncRule, SyncedCardLink, Pipeline, TypedAnswerOverride } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'
import { prefetchChoices, needsChoices, ensureChoicesGenerated, regenerateChoicesExcluding, type PrefetchItem } from '@/lib/distractors'
import { langName, TTS_SUPPORTED_LANGUAGES } from '@/lib/languages'
import { displayText } from '@/lib/cardText'
import { speak } from '@/lib/speak'
import { classifyReviewMode, MULTIPLIER_RANGE } from '@/engine/scheduler'
import { initialCardState, fastTrackCardState } from '@/engine/pipeline'
import { batchFastTrackDueDates } from '@/engine/density'

// ─── Card edit modal ─────────────────────────────────────────────────────────

/** Format an ISO date/datetime string as a short, readable date — or a fallback. */
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

function CardEditModal({ card, state, userId, deckId, deckCards, sourceLanguage, targetLanguage, onSave, onCardChange, onStateChange, onClose, onJumpToCard, onSyncCard, initialShowStats, onDelete, onMerge }: {
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
  const [generatingAudio,  setGeneratingAudio]  = useState(false)
  const [audioError,       setAudioError]       = useState<string | null>(null)
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

  async function handleSave() {
    if (!front.trim()) { setValidErr('Front cannot be empty.'); return }
    if (!back.trim())  { setValidErr('Back cannot be empty.');  return }
    setValidErr(null)
    setSaving(true)
    try {
      await onSave(card.id, front.trim(), back.trim())
      setSaved(true)
      setTimeout(() => { setSaved(false); onClose() }, 600)
    } catch (err: unknown) {
      setValidErr(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  /** Clears audio so it will be regenerated on the next session. */
  async function resetAudio() {
    const cardRepo = new SupabaseCardRepository()
    const updated  = await cardRepo.update(card.id, { audioGenerated: false, audioData: null })
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

  /** Fetches AI TTS audio for the card's front (source language) and saves it. */
  async function generateAudio() {
    setGeneratingAudio(true)
    setAudioError(null)
    try {
      const res  = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: card.front, language: sourceLanguage }),
      })
      const data = await res.json()
      if (!data.ok || !data.audioData) {
        console.error('[TTS] generation failed:', data.reason)
        setAudioError('Audio generation failed. Try again.')
        return
      }
      const cardRepo = new SupabaseCardRepository()
      const updated  = await cardRepo.update(card.id, { audioGenerated: true, audioData: data.audioData })
      onCardChange(updated)
    } catch {
      setAudioError('Audio generation failed. Try again.')
    } finally {
      setGeneratingAudio(false)
    }
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

        {/* Audio generation — only for supported source languages */}
        {TTS_SUPPORTED_LANGUAGES.has(sourceLanguage) && (
          <div className="space-y-1.5">
            {!card.audioGenerated ? (
              <button
                onClick={generateAudio}
                disabled={generatingAudio}
                className="w-full text-left px-3 py-2 rounded-lg border border-white/10 hover:bg-surface-raised/50 text-ink-muted text-xs transition-colors disabled:opacity-40"
              >
                {generatingAudio ? 'Generating audio…' : '🔊 Generate Audio'}
                <span className="block text-ink-faint font-normal mt-0.5">
                  Fetch AI-generated pronunciation for &ldquo;{card.front}&rdquo;
                </span>
              </button>
            ) : (
              <button
                onClick={() => speak(card.front, sourceLanguage, card.audioData)}
                className="w-full text-left px-3 py-2 rounded-lg border border-white/10 hover:bg-surface-raised/50 text-ink-muted text-xs transition-colors"
              >
                🔊 Play audio
                <span className="block text-ink-faint font-normal mt-0.5">
                  &ldquo;{card.front}&rdquo;
                </span>
              </button>
            )}
            {audioError && (
              <p className="text-danger text-xs">{audioError}</p>
            )}
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
              const status = state.graduated
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
                    const gradStruggleLabel = gradIntervalDays != null
                      ? gradIntervalDays >= 5 ? '0' : gradIntervalDays >= 3 ? '1' : gradIntervalDays >= 2 ? '2' : '3+'
                      : null
                    const isDualTrack = state.graduated && state.typedDueAt != null
                    const hasRecallTrack = state.graduated && (state.recallDueAt != null || state.recallIntervalDays != null)
                    const prodInterval = state.typedIntervalDays ?? state.intervalDays
                    const prodDue = state.typedDueAt ?? state.dueAt
                    return (<>
                      {/* Production track (typed + self-graded forward reviews) */}
                      <StatGroup title={isDualTrack ? 'Production track (typed / self-graded)' : 'Scheduling'} rows={[
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
                          ['Pipeline struggles',  gradStruggleLabel!] as [string, string],
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

// ─── New card modal ───────────────────────────────────────────────────────────

function NewCardModal({ existingFronts, onSave, onClose }: {
  existingFronts: string[]
  onSave:  (front: string, back: string) => Promise<void>
  onClose: () => void
}) {
  const [front,    setFront]    = useState('')
  const [back,     setBack]     = useState('')
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [validErr, setValidErr] = useState<string | null>(null)
  const frontRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { frontRef.current?.focus() }, [])

  async function handleSave() {
    const f = front.trim()
    const b = back.trim()
    if (!f) { setValidErr('Front cannot be empty.'); return }
    if (!b) { setValidErr('Back cannot be empty.'); return }
    const isDuplicate = existingFronts.some(ef => ef.toLowerCase() === f.toLowerCase())
    if (isDuplicate) { setValidErr('A card with this front already exists in the deck.'); return }
    setValidErr(null)
    setSaving(true)
    try {
      await onSave(f, b)
      setSaved(true)
      setTimeout(() => { setSaved(false); onClose() }, 600)
    } catch (err: unknown) {
      setValidErr(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="panel w-full max-w-lg space-y-4 mx-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">New card</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink text-lg leading-none">✕</button>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-ink-muted uppercase tracking-wider">Front</label>
          <textarea ref={frontRef} className={`input resize-none min-h-[80px] font-medium ${validErr && !front.trim() ? 'border-danger/60 bg-danger/5' : ''}`}
            placeholder="Target language term…" value={front} onChange={e => { setFront(e.target.value); setValidErr(null) }} />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-ink-muted uppercase tracking-wider">Back</label>
          <textarea className={`input resize-none min-h-[80px] ${validErr && !back.trim() ? 'border-danger/60 bg-danger/5' : ''}`}
            placeholder="Translation / definition…" value={back} onChange={e => { setBack(e.target.value); setValidErr(null) }} />
        </div>

        {validErr && <p className="text-danger text-xs">{validErr}</p>}

        <div className="flex gap-3">
          <button className="btn-primary flex-1" onClick={handleSave} disabled={saving}>
            {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Add card'}
          </button>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────

function ConfirmDialog({ message, onConfirm, onCancel }: {
  message:   string
  onConfirm: () => void
  onCancel:  () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="panel w-full max-w-sm space-y-4 mx-4">
        <p className="text-ink text-sm leading-relaxed">{message}</p>
        <div className="flex gap-3">
          <button onClick={onConfirm} className="btn-primary flex-1 bg-danger hover:bg-danger/80">Yes, reset</button>
          <button onClick={onCancel}  className="btn-ghost flex-1">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ─── Sync review modal ────────────────────────────────────────────────────────

interface SyncReviewRow {
  rule:           LanguageSyncRule
  destPair:       LanguagePair
  generatedFront: string
  generatedBack:  string
  confidence:     number | null
  warning:        string | null
  existingCard:   Card | null
  existingLink:   SyncedCardLink | null
  uiStatus:       'pending' | 'approving' | 'approved' | 'dismissing' | 'dismissed' | 'already_active' | 'error'
  uiError:        string | null
  editMode:       boolean
  editFront:      string
  editBack:       string
  confirmExisting: boolean  // user must confirm before editing an existing card
  deckId:         string    // synced deck for this direction (from infra)
  checked:        boolean   // selected for bulk sync
}

function SyncReviewModal({ card, userId, sourceLanguage, targetLanguage, onClose }: {
  card:           Card
  userId:         string
  sourceLanguage: string
  targetLanguage: string
  onClose:        () => void
}) {
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rows, setRows] = useState<SyncReviewRow[]>([])

  useEffect(() => { void load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    try {
      const pairRepo      = new SupabaseLanguagePairRepository()
      const ruleRepo      = new SupabaseLanguageSyncRuleRepository()
      const linkRepo      = new SupabaseSyncedCardLinkRepository()
      const cardRepo      = new SupabaseCardRepository()

      // Find the source pair for this deck's language direction
      const allPairs  = await pairRepo.list(userId)
      const sourcePair = allPairs.find(
        p => p.sourceLanguage === sourceLanguage && p.targetLanguage === targetLanguage
      )
      if (!sourcePair) { setLoadError('No language pair found for this deck.'); setLoadStatus('error'); return }

      // Load all sync rules where this pair is the source
      const allRules = await ruleRepo.listForUser(userId)
      const rules    = allRules.filter(r => r.sourcePairId === sourcePair.id && r.enabled)
      if (rules.length === 0) { setLoadStatus('ready'); return }

      // Load existing links for this card
      const existingLinks = await linkRepo.listForCard(card.id)

      // Build rows in parallel
      const built = await Promise.all(rules.map(async (rule): Promise<SyncReviewRow | null> => {
        const destPair = allPairs.find(p => p.id === rule.destinationPairId)
        if (!destPair) return null

        const existingLink = existingLinks.find(l => l.destinationPairId === rule.destinationPairId) ?? null

        // Already active — show summary row, no action needed
        if (existingLink?.status === 'active') {
          return {
            rule, destPair,
            generatedFront: existingLink.generatedFront,
            generatedBack:  existingLink.generatedBack,
            confidence: existingLink.confidence,
            warning:    existingLink.warning,
            existingCard: null, existingLink,
            uiStatus: 'already_active' as const,
            uiError: null, editMode: false,
            editFront: existingLink.generatedFront,
            editBack:  existingLink.generatedBack,
            confirmExisting: false, deckId: '', checked: false,
          }
        }

        // Dismissed — skip
        if (existingLink?.status === 'dismissed') return null

        // Translate
        let generatedFront = existingLink?.generatedFront ?? ''
        let generatedBack  = existingLink?.generatedBack  ?? ''
        let confidence: number | null = existingLink?.confidence ?? null
        let warning:    string | null = existingLink?.warning    ?? null

        if (!generatedFront) {
          const res = await fetch('/api/sync-translate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sourceFront:       card.front,
              sourceBack:        card.back,
              fromLanguage:      sourceLanguage,
              toLearnedLanguage: destPair.sourceLanguage,
              toBasisLanguage:   destPair.targetLanguage,
              ...(destPair.instructions ? { instructions: destPair.instructions } : {}),
            }),
          })
          const data = await res.json()
          if (!data.ok) {
            return {
              rule, destPair,
              generatedFront: '', generatedBack: '', confidence: null, warning: null,
              existingCard: null, existingLink,
              uiStatus: 'error' as const,
              uiError: `Translation failed: ${data.reason ?? 'unknown error'}`,
              editMode: false, editFront: '', editBack: '',
              confirmExisting: false, deckId: '', checked: false,
            }
          }
          generatedFront = data.front
          generatedBack  = data.back
          confidence     = data.confidence
          warning        = data.warning
        }

        // Duplicate detection — find existing card in dest pair with matching front
        const destCards    = await cardRepo.listOwned(userId, destPair.sourceLanguage, destPair.targetLanguage)
        const norm         = (s: string) => s.trim().toLowerCase()
        const existingCard = destCards.find(c => norm(c.front) === norm(generatedFront)) ?? null

        return {
          rule, destPair,
          generatedFront, generatedBack, confidence, warning,
          existingCard, existingLink,
          uiStatus: 'pending' as const, uiError: null,
          editMode: false, editFront: generatedFront, editBack: generatedBack,
          confirmExisting: false, deckId: '', checked: true,
        }
      }))

      setRows(built.filter((r): r is SyncReviewRow => r !== null))
      setLoadStatus('ready')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load sync data')
      setLoadStatus('error')
    }
  }

  function updateRow(idx: number, patch: Partial<SyncReviewRow>) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r))
  }

  async function handleApprove(idx: number) {
    const row = rows[idx]
    if (!row) return
    updateRow(idx, { uiStatus: 'approving', uiError: null })
    try {
      const cardRepo   = new SupabaseCardRepository()
      const pairRepo   = new SupabaseLanguagePairRepository()
      const linkRepo   = new SupabaseSyncedCardLinkRepository()

      const allPairs  = await pairRepo.list(userId)
      const sourcePair = allPairs.find(p => p.sourceLanguage === sourceLanguage && p.targetLanguage === targetLanguage)!
      const infra = await ensureSyncInfra(userId, sourcePair, row.destPair)

      const front = row.editMode ? row.editFront : row.generatedFront
      const back  = row.editMode ? row.editBack  : row.generatedBack

      let syncedCardId: string
      if (row.existingCard && !row.editMode) {
        // Link to existing card; add it to synced deck
        syncedCardId = row.existingCard.id
        await cardRepo.addToDeck(infra.deckId, row.existingCard.id, 0)
      } else if (row.existingCard && row.editMode && row.confirmExisting) {
        // Update existing card
        await cardRepo.update(row.existingCard.id, { front, back })
        syncedCardId = row.existingCard.id
        await cardRepo.addToDeck(infra.deckId, row.existingCard.id, 0)
      } else {
        // Create new card
        const [created] = await cardRepo.bulkCreate(
          infra.deckId, userId,
          row.destPair.sourceLanguage, row.destPair.targetLanguage,
          [{ front, back, position: 0 }],
        )
        syncedCardId = created!.id
      }

      await linkRepo.upsert({
        userId,
        sourceCardId:      card.id,
        syncedCardId,
        sourcePairId:      row.rule.sourcePairId,
        destinationPairId: row.rule.destinationPairId,
        syncRuleId:        row.rule.id,
        sourceFrontAtSync: card.front,
        sourceBackAtSync:  card.back,
        generatedFront:    front,
        generatedBack:     back,
        confidence:        row.confidence,
        warning:           row.warning,
        status:            row.editMode ? 'manually_edited' : 'active',
      })

      updateRow(idx, { uiStatus: 'approved', deckId: infra.deckId })
    } catch (err) {
      updateRow(idx, { uiStatus: 'error', uiError: err instanceof Error ? err.message : 'Approval failed' })
    }
  }

  async function handleDismiss(idx: number) {
    const row = rows[idx]
    if (!row) return
    updateRow(idx, { uiStatus: 'dismissing' })
    try {
      const linkRepo = new SupabaseSyncedCardLinkRepository()
      // If pending link already exists, update it; otherwise create a dismissed record
      if (row.existingLink) {
        await linkRepo.dismiss(card.id, row.rule.destinationPairId)
      } else {
        const pairRepo   = new SupabaseLanguagePairRepository()
        const allPairs  = await pairRepo.list(userId)
        const sourcePair = allPairs.find(p => p.sourceLanguage === sourceLanguage && p.targetLanguage === targetLanguage)!
        await linkRepo.upsert({
          userId,
          sourceCardId:      card.id,
          syncedCardId:      null,
          sourcePairId:      sourcePair.id,
          destinationPairId: row.rule.destinationPairId,
          syncRuleId:        row.rule.id,
          sourceFrontAtSync: card.front,
          sourceBackAtSync:  card.back,
          generatedFront:    row.generatedFront,
          generatedBack:     row.generatedBack,
          confidence:        row.confidence,
          warning:           row.warning,
          status:            'dismissed',
        })
      }
      updateRow(idx, { uiStatus: 'dismissed' })
    } catch (err) {
      updateRow(idx, { uiStatus: 'error', uiError: err instanceof Error ? err.message : 'Dismiss failed' })
    }
  }

  async function handleSyncSelected() {
    const toSync = rows.map((r, i) => ({ row: r, idx: i })).filter(({ row }) => row.checked && row.uiStatus === 'pending')
    for (const { idx } of toSync) {
      await handleApprove(idx)
    }
  }

  const checkedCount = rows.filter(r => r.checked && r.uiStatus === 'pending').length
  const allDone      = rows.length > 0 && rows.every(r => ['approved', 'dismissed', 'already_active', 'error'].includes(r.uiStatus))
  const anySyncing   = rows.some(r => r.uiStatus === 'approving')

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="panel w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink">Sync to other languages</h2>
            <p className="text-xs text-ink-faint mt-0.5">
              Source: <span className="font-mono text-ink-muted">{card.front}</span>
              <span className="mx-1 text-ink-faint/50">=</span>
              <span className="font-mono text-ink-muted">{card.back}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink transition-colors text-xl leading-none">✕</button>
        </div>

        {/* Loading */}
        {loadStatus === 'loading' && (
          <p className="text-ink-faint text-sm text-center py-6">Translating…</p>
        )}

        {/* Error */}
        {loadStatus === 'error' && (
          <p className="text-danger text-sm text-center py-6">{loadError}</p>
        )}

        {/* No rules */}
        {loadStatus === 'ready' && rows.length === 0 && (
          <div className="text-center py-8 space-y-2">
            <p className="text-ink-muted text-sm">No sync rules configured for this language pair.</p>
            <p className="text-ink-faint text-xs">
              Set up a sync rule in Settings → Language Sync to link pairs together.
            </p>
          </div>
        )}

        {/* Review rows */}
        {loadStatus === 'ready' && rows.map((row, idx) => (
          <div key={row.rule.id} className={`rounded-card border p-4 space-y-3 ${
            row.uiStatus === 'approved'       ? 'border-success/30 bg-success/5' :
            row.uiStatus === 'already_active' ? 'border-accent/20 bg-accent/5 opacity-60' :
            row.uiStatus === 'error'          ? 'border-danger/30 bg-danger/5' :
            !row.checked                      ? 'border-white/5 opacity-40' :
            'border-white/10'
          }`}>
            {/* Row header — checkbox + dest pair + status badge */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                {row.uiStatus === 'pending' && (
                  <input
                    type="checkbox"
                    checked={row.checked}
                    onChange={e => updateRow(idx, { checked: e.target.checked })}
                    className="shrink-0 accent-accent w-4 h-4"
                    disabled={anySyncing}
                  />
                )}
                <span className="text-xs font-medium text-ink-muted uppercase tracking-wider truncate">
                  {langName(row.destPair.sourceLanguage)} → {langName(row.destPair.targetLanguage)}
                </span>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                {row.uiStatus === 'already_active' && (
                  <span className="text-xs text-accent bg-accent/10 px-2 py-0.5 rounded-full">Already synced</span>
                )}
                {row.uiStatus === 'approved' && (
                  <span className="text-xs text-success bg-success/10 px-2 py-0.5 rounded-full">✓ Synced</span>
                )}
                {row.uiStatus === 'approving' && (
                  <span className="text-xs text-ink-faint px-2 py-0.5">Syncing…</span>
                )}
              </div>
            </div>

            {/* Generated card preview */}
            <div className="grid grid-cols-2 gap-3">
              {row.editMode ? (
                <>
                  <div className="space-y-1">
                    <label className="text-xs text-ink-faint">{langName(row.destPair.sourceLanguage)}</label>
                    <input
                      className="input text-sm"
                      value={row.editFront}
                      onChange={e => updateRow(idx, { editFront: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-ink-faint">{langName(row.destPair.targetLanguage)}</label>
                    <input
                      className="input text-sm"
                      value={row.editBack}
                      onChange={e => updateRow(idx, { editBack: e.target.value })}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-0.5">
                    <p className="text-xs text-ink-faint">{langName(row.destPair.sourceLanguage)}</p>
                    <p className="font-medium text-ink">{row.generatedFront || '—'}</p>
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-xs text-ink-faint">{langName(row.destPair.targetLanguage)}</p>
                    <p className="text-ink-muted">{row.generatedBack || '—'}</p>
                  </div>
                </>
              )}
            </div>

            {/* Confidence / warning */}
            {row.warning && (
              <p className="text-xs text-warning/80">⚠ {row.warning}</p>
            )}

            {/* Existing card notice */}
            {row.existingCard && row.uiStatus === 'pending' && !row.editMode && (
              <p className="text-xs text-accent/80 bg-accent/5 border border-accent/20 rounded px-2 py-1.5">
                Existing card found: <span className="font-mono">{row.existingCard.front}</span>
                {' = '}<span className="font-mono">{row.existingCard.back}</span>
                {' — syncing will link to this card.'}
              </p>
            )}

            {/* Confirm edit-existing dialog */}
            {row.existingCard && row.editMode && !row.confirmExisting && (
              <div className="rounded border border-warning/30 bg-warning/5 p-3 space-y-2">
                <p className="text-xs text-warning">
                  An existing card matches this word. Do you want to update it, or create a new card?
                </p>
                <div className="flex gap-2">
                  <button
                    className="btn-ghost text-xs py-1 px-3 text-warning border-warning/30"
                    onClick={() => updateRow(idx, { confirmExisting: true })}
                  >
                    Update existing card
                  </button>
                  <button
                    className="btn-ghost text-xs py-1 px-3"
                    onClick={() => updateRow(idx, { existingCard: null })}
                  >
                    Create new card
                  </button>
                </div>
              </div>
            )}

            {/* Error */}
            {row.uiStatus === 'error' && row.uiError && (
              <p className="text-xs text-danger">{row.uiError}</p>
            )}

            {/* Edit translation button (only for pending rows, not yet syncing) */}
            {row.uiStatus === 'pending' && row.checked && !anySyncing && (
              <div className="flex gap-2">
                {!row.editMode ? (
                  <button
                    className="btn-ghost text-xs py-1 px-3"
                    onClick={() => updateRow(idx, { editMode: true })}
                  >
                    Edit translation
                  </button>
                ) : (
                  <button
                    className="btn-ghost text-xs py-1 px-3"
                    onClick={() => updateRow(idx, { editMode: false, editFront: row.generatedFront, editBack: row.generatedBack, confirmExisting: false })}
                  >
                    Cancel edit
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Footer */}
        <div className="flex items-center justify-between pt-1">
          <button className="btn-ghost text-sm" onClick={onClose}>
            {allDone ? 'Close' : 'Cancel'}
          </button>
          {loadStatus === 'ready' && !allDone && (
            <button
              className="btn-primary text-sm px-5 py-2 disabled:opacity-50"
              disabled={checkedCount === 0 || anySyncing}
              onClick={handleSyncSelected}
            >
              {anySyncing ? 'Syncing…' : `Sync selected (${checkedCount})`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Synonym scan ─────────────────────────────────────────────────────────────

/** Detects comma, slash, or semicolon as synonym separators. Returns null if not a multi-synonym string. */
function detectSynonymSplit(text: string): string[] | null {
  // Find the first separator character present
  const sepMatch = text.match(/[,/;]/)
  if (!sepMatch) return null
  const sep = sepMatch[0]
  const segments = text.split(sep).map(s => s.trim()).filter(Boolean)
  if (segments.length < 2) return null
  // Each segment must be short (≤ 5 words) — filters out sentences with commas
  if (!segments.every(s => s.split(/\s+/).filter(Boolean).length <= 5)) return null
  return segments
}

interface SynonymCandidate {
  card:     Card
  segments: string[]
  split:    boolean
}

function SynonymScanModal({ deckId, userId, candidates, deckCards, sourceLanguage, targetLanguage, onDone, onClose }: {
  deckId:         string
  userId:         string
  candidates:     SynonymCandidate[]
  deckCards:      Card[]
  sourceLanguage: string
  targetLanguage: string
  onDone:         (removedIds: string[], addedCards: Card[]) => void
  onClose:        () => void
}) {
  const [items,   setItems]   = useState<SynonymCandidate[]>(candidates)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  // Build a lookup of existing front values → card (case-insensitive) for duplicate detection.
  const existingByFront = new Map(
    deckCards.map(c => [c.front.trim().toLowerCase(), c])
  )

  const splitCount = items.filter(it => it.split).length

  function toggle(cardId: string) {
    setItems(prev => prev.map(it => it.card.id === cardId ? { ...it, split: !it.split } : it))
  }

  async function handleConfirm() {
    const toSplit = items.filter(it => it.split)
    if (toSplit.length === 0) { onClose(); return }
    setSaving(true)
    setError(null)
    try {
      const cardRepo    = new SupabaseCardRepository()
      const stateRepo   = new SupabaseCardStateRepository()
      const synonymRepo = new SupabaseSynonymGroupRepository()

      const removedIds: string[] = []
      const addedCards: Card[]   = []

      for (const item of toSplit) {
        // Separate segments into: already-existing cards vs. new ones to create.
        const reusedCards:  Card[]   = []
        const newSegments:  string[] = []
        for (const seg of item.segments) {
          const existing = existingByFront.get(seg.trim().toLowerCase())
          if (existing && existing.id !== item.card.id) {
            reusedCards.push(existing)
          } else {
            newSegments.push(seg)
          }
        }

        // Create only the truly new cards.
        const created: Card[] = newSegments.length > 0
          ? await cardRepo.bulkCreate(
              deckId, userId, sourceLanguage, targetLanguage,
              newSegments.map((seg, idx) => ({ front: seg, back: item.card.back, position: idx })),
            )
          : []

        // Copy learning state from the original to each new card.
        for (const c of created) {
          await stateRepo.copy(userId, item.card.id, c.id)
        }

        // Remove the original comma-grouped card and soft-delete it FIRST so
        // the split always completes even if synonym group linking fails below.
        await cardRepo.removeFromDeck(deckId, item.card.id)
        await cardRepo.softDelete(item.card.id)
        removedIds.push(item.card.id)
        addedCards.push(...created)

        // Link all cards (reused + new) to a SynonymGroup — best-effort only,
        // failure here must not roll back or block the split.
        const allGroupCards = [...reusedCards, ...created]
        if (allGroupCards.length >= 2) {
          try {
            const group = await synonymRepo.create({
              gloss:         item.card.back,
              glossLanguage: targetLanguage,
              itemLanguage:  sourceLanguage,
            }, userId)
            for (const c of allGroupCards) {
              await synonymRepo.addMember(group.id, c.id)
            }
          } catch (groupErr) {
            console.error('Synonym group linking failed (non-fatal):', groupErr)
          }
        }
      }

      onDone(removedIds, addedCards)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-surface rounded-xl border border-white/10 w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
          <h2 className="text-base font-semibold text-ink">Split multi-translation cards</h2>
          <button onClick={onClose} className="text-ink-muted hover:text-ink text-lg leading-none">✕</button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3">
          <p className="text-sm text-ink-muted">
            These cards look like they contain multiple translations. Select the ones to split into separate synonym-linked cards.
          </p>
          {items.map(item => {
            const dupeSegs = item.segments.filter(seg => {
              const ex = existingByFront.get(seg.trim().toLowerCase())
              return ex && ex.id !== item.card.id
            })
            return (
              <label key={item.card.id} className="flex items-start gap-3 cursor-pointer panel hover:border-white/20 transition-colors">
                <input
                  type="checkbox"
                  checked={item.split}
                  onChange={() => toggle(item.card.id)}
                  className="accent-accent w-4 h-4 mt-1 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink">{item.card.front}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {item.segments.map((seg, si) => {
                      const isDupe = existingByFront.has(seg.trim().toLowerCase()) &&
                        existingByFront.get(seg.trim().toLowerCase())!.id !== item.card.id
                      return (
                        <span key={si} className={`rounded px-2 py-0.5 text-xs font-mono ${isDupe ? 'bg-warning/15 text-warning' : 'bg-surface-raised text-ink'}`}>
                          {seg}{isDupe ? ' (exists)' : ''}
                        </span>
                      )
                    })}
                  </div>
                  {item.split && (
                    <p className="text-xs text-ink-faint mt-1">
                      → {item.segments.length} cards
                      {dupeSegs.length > 0 && ` · ${dupeSegs.length} existing card${dupeSegs.length !== 1 ? 's' : ''} will be reused`}
                      {item.segments.length - dupeSegs.length > 0 && ` · ${item.segments.length - dupeSegs.length} new`}
                    </p>
                  )}
                </div>
              </label>
            )
          })}
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        <div className="flex gap-3 px-5 py-4 border-t border-white/10 shrink-0">
          <button
            className="btn-primary"
            disabled={saving || splitCount === 0}
            onClick={handleConfirm}
          >
            {saving ? 'Splitting…' : `Split ${splitCount} card${splitCount !== 1 ? 's' : ''}`}
          </button>
          <button className="btn-ghost" disabled={saving} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ─── Gear settings panel ──────────────────────────────────────────────────────

function DeckSettingsPanel({ deckId, userId, deck, initialPrefs, defaultLimit, defaultSpillover, maxCards, cards, sourceLanguage, targetLanguage, onClose }: {
  deckId:           string
  userId:           string
  deck:             Deck
  initialPrefs:     DeckPreferences | null
  defaultLimit:     number
  defaultSpillover: boolean
  maxCards:         number
  cards:            Card[]
  sourceLanguage:   string
  targetLanguage:   string
  onClose:          () => void
}) {
  const today    = new Date().toISOString().slice(0, 10)
  const prefRepo = new SupabaseDeckPreferencesRepository()

  // ── Grading settings state ──────────────────────────────────────────────────
  const gs = deck.gradingSettings
  const [gradingMode,          setGradingMode]          = useState(gs.gradingMode)
  const [ignoreAccents,        setIgnoreAccents]        = useState(gs.ignoreAccents)
  const [ignoreCapitalization, setIgnoreCapitalization] = useState(gs.ignoreCapitalization)
  const [ignoreMinorTypos,     setIgnoreMinorTypos]     = useState(gs.ignoreMinorTypos)
  const [ignoreDefiniteArticles, setIgnoreDefiniteArticles] = useState(gs.ignoreDefiniteArticles)
  const [requireParenContent,  setRequireParenContent]  = useState(gs.requireParentheticalContent)
  const [slashMode,            setSlashMode]            = useState(gs.slashAlternativesMode)
  const [autoPlayAudio,        setAutoPlayAudio]        = useState(gs.autoPlayAudio ?? true)
  const [aiInstructions,       setAiInstructions]       = useState(gs.aiGradingInstructions ?? '')

  const [dailyLimit,        setDailyLimit]        = useState(Math.min(initialPrefs?.dailyNewCards ?? defaultLimit, maxCards))
  const [onlyToday,         setOnlyToday]         = useState(false)
  const [todayOverride,     setTodayOverride]     = useState(initialPrefs?.dailyOverride ?? defaultLimit)
  const [spillover,         setSpillover]         = useState(initialPrefs?.spilloverDue  ?? defaultSpillover)
  const [cardsPerSessionOn,  setCardsPerSessionOn]  = useState((initialPrefs?.cardsPerSession ?? 0) > 0)
  const [cardsPerSession,    setCardsPerSession]    = useState(initialPrefs?.cardsPerSession || 12)
  const [learningBatchMode,  setLearningBatchMode]  = useState(initialPrefs?.learningBatchMode ?? false)
  const [saving,            setSaving]            = useState(false)
  const [saved,             setSaved]             = useState(false)
  const [saveError,         setSaveError]         = useState<string | null>(null)

  // Reset menu + confirm states
  const [showResetMenu,        setShowResetMenu]        = useState(false)
  const [confirmReset,         setConfirmReset]         = useState(false)
  const [confirmResetChoices,  setConfirmResetChoices]  = useState(false)
  const [confirmFullReset,     setConfirmFullReset]     = useState(false)
  const [resetting,            setResetting]            = useState(false)
  const [resetError,           setResetError]           = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const newGradingSettings = {
        ...deck.gradingSettings,
        gradingMode,
        ignoreAccents,
        ignoreCapitalization,
        ignoreMinorTypos,
        ignoreDefiniteArticles,
        requireParentheticalContent: requireParenContent,
        slashAlternativesMode: slashMode,
        autoPlayAudio,
        aiGradingInstructions: aiInstructions.trim() || undefined,
      }
      await Promise.all([
        prefRepo.upsert({
          userId, deckId,
          dailyNewCards:     dailyLimit,
          dailyOverride:     onlyToday ? todayOverride : null,
          dailyOverrideDate: onlyToday ? today         : null,
          spilloverDue:      spillover,
          cardsPerSession:      cardsPerSessionOn ? cardsPerSession : null,
          electiveSessionLimit: cardsPerSessionOn ? cardsPerSession : 0,
          learningBatchMode:    cardsPerSessionOn ? learningBatchMode : false,
        }),
        new SupabaseDeckRepository().update(deckId, { gradingSettings: newGradingSettings }),
      ])
      setSaving(false)
      setSaved(true)
      setTimeout(() => { setSaved(false); onClose() }, 800)
    } catch (err: unknown) {
      setSaving(false)
      setSaveError(err instanceof Error ? err.message : 'Save failed — did you run the SQL migrations?')
    }
  }

  async function handleResetBacklog() {
    setResetting(true)
    setResetError(null)
    try {
      await prefRepo.resetDeckBacklog(userId, deckId)
      setConfirmReset(false)
      onClose()
    } catch (err: unknown) {
      setResetError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setResetting(false)
    }
  }

  async function handleResetChoices() {
    setResetting(true)
    setResetError(null)
    try {
      const supabase = createClient()
      const cardIds = cards.map(c => c.id)
      if (cardIds.length > 0) {
        const { error } = await supabase.from('cards').update({ choices: null }).in('id', cardIds)
        if (error) throw new Error(error.message)
      }
      setConfirmResetChoices(false)
      onClose()
      const resetCards = cards.map(c => ({ ...c, choices: null }))
      const prefetchItems: PrefetchItem[] = resetCards.map(card => ({
        card, side: 'front' as const, deckCards: resetCards, sourceLanguage, targetLanguage,
      }))
      void prefetchChoices(prefetchItems, () => {})
    } catch (err: unknown) {
      setResetError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setResetting(false)
    }
  }

  async function handleFullReset() {
    setResetting(true)
    setResetError(null)
    try {
      const deckRepo = new SupabaseDeckRepository()
      await deckRepo.resetProgress(deckId)
      setConfirmFullReset(false)
      onClose()
      const resetCards = cards.map(c => ({ ...c, choices: null }))
      const prefetchItems: PrefetchItem[] = resetCards.map(card => ({
        card, side: 'front' as const, deckCards: resetCards, sourceLanguage, targetLanguage,
      }))
      void prefetchChoices(prefetchItems, () => {})
    } catch (err: unknown) {
      setResetError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      {confirmReset && (
        <ConfirmDialog
          message="This will clear the backlog for this deck — only today's cards will be due. Study progress is kept."
          onConfirm={handleResetBacklog}
          onCancel={() => setConfirmReset(false)}
        />
      )}
      {confirmResetChoices && (
        <ConfirmDialog
          message="This will clear all cached distractor choices for every card in this deck. New distractors will be generated in the background. Study progress is kept."
          onConfirm={handleResetChoices}
          onCancel={() => setConfirmResetChoices(false)}
        />
      )}
      {confirmFullReset && (
        <ConfirmDialog
          message="This will erase ALL study progress for this deck — every card goes back to never studied, and cached answer choices are cleared and regenerated. Cards and settings are kept. This can't be undone."
          onConfirm={handleFullReset}
          onCancel={() => setConfirmFullReset(false)}
        />
      )}

      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) { onClose(); setShowResetMenu(false) } }}
      >
        <div className="panel w-full max-w-sm mx-4 flex flex-col max-h-[85vh]">

          {/* ── Header (non-scrolling) ── */}
          <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-white/10 shrink-0">
            <h2 className="text-base font-semibold text-ink">Deck study settings</h2>
            <div className="flex items-center gap-2 relative">
              {/* Reset menu trigger */}
              <button
                onClick={() => setShowResetMenu(v => !v)}
                className="text-danger/70 hover:text-danger transition-colors text-lg leading-none"
                title="Reset options"
              >↺</button>
              {showResetMenu && (
                <div className="absolute right-0 top-full mt-1 z-10 bg-surface-raised border border-white/10 rounded-lg py-1 w-52 shadow-xl">
                  <button
                    onClick={() => { setShowResetMenu(false); setConfirmReset(true) }}
                    className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-white/5 transition-colors"
                  >Reset backlog</button>
                  <button
                    onClick={() => { setShowResetMenu(false); setConfirmResetChoices(true) }}
                    className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-white/5 transition-colors"
                  >Reset distractors</button>
                  <button
                    onClick={() => { setShowResetMenu(false); setConfirmFullReset(true) }}
                    className="w-full text-left px-4 py-2 text-sm text-danger/80 hover:bg-white/5 transition-colors"
                  >Reset all progress</button>
                </div>
              )}
              <button onClick={onClose} className="text-ink-faint hover:text-ink text-lg leading-none">✕</button>
            </div>
          </div>

          {/* ── Scrollable body ── */}
          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">

            {/* Persistent daily limit */}
            <div className="space-y-1.5">
              <label className="text-sm text-ink-muted">New cards per day (persistent)</label>
              <input type="number" min={1} max={500} className="input"
                value={dailyLimit}
                onChange={e => setDailyLimit(Math.min(maxCards, Math.max(1, parseInt(e.target.value) || 1)))} />
              <p className="text-xs text-ink-faint">Stays until you change it. Max: {maxCards} (deck size).</p>
            </div>

            {/* Today-only override */}
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={onlyToday} onChange={e => setOnlyToday(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Override for today only</span>
              </label>
              {onlyToday && (
                <div className="space-y-1.5 pl-6">
                  <label className="text-sm text-ink-muted">New cards just for today</label>
                  <input type="number" min={0} max={500} className="input"
                    value={todayOverride}
                    onChange={e => setTodayOverride(Math.min(maxCards, Math.max(0, parseInt(e.target.value) || 0)))} />
                  <p className="text-xs text-ink-faint">Tomorrow reverts to {dailyLimit} cards/day.</p>
                </div>
              )}
            </div>

            {/* Spillover toggle */}
            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={spillover} onChange={e => setSpillover(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Due cards spill over</span>
              </label>
              <p className="text-xs text-ink-faint pl-6">
                {spillover
                  ? 'Cards you miss accumulate — tomorrow you may see more than your daily limit.'
                  : 'Missed cards count toward tomorrow\'s limit — total stays at ' + dailyLimit + '/day.'}
              </p>
            </div>

            {/* Learning pipeline cap — also controls elective/study-ahead cap */}
            <div className="space-y-2 border-t border-white/10 pt-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={cardsPerSessionOn} onChange={e => setCardsPerSessionOn(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Limit cards in learning</span>
              </label>
              {cardsPerSessionOn && (
                <div className="space-y-2 pl-6">
                  <div className="space-y-1">
                    <label className="text-sm text-ink-muted">Max cards in pipeline</label>
                    <input type="number" min={1} max={500} className="input"
                      value={cardsPerSession}
                      onChange={e => setCardsPerSession(Math.min(maxCards, Math.max(1, parseInt(e.target.value) || 1)))} />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={learningBatchMode} onChange={e => setLearningBatchMode(e.target.checked)} className="accent-accent w-4 h-4" />
                    <span className="text-sm text-ink">Wait for full batch to graduate</span>
                  </label>
                  <p className="text-xs text-ink-faint">
                    {learningBatchMode
                      ? `Cards are learned in groups of ${cardsPerSession}. All ${cardsPerSession} must graduate before the next group unlocks.`
                      : `Keeps at most ${cardsPerSession} card${cardsPerSession !== 1 ? 's' : ''} in the learning pipeline. New cards enter as others graduate.`
                    }
                    {' '}Also caps study-ahead sessions to {cardsPerSession} cards per batch. Overrides the daily limit above.
                  </p>
                </div>
              )}
            </div>

            {/* ── Grading mode ──────────────────────────────────────────────── */}
            <div className="space-y-3 border-t border-white/10 pt-3">
              <p className="text-sm text-ink-muted">Grading mode</p>
              <div className="space-y-1.5">
                {(['strict', 'flexible', 'smart_ai'] as const).map(mode => (
                  <label key={mode} className="flex items-start gap-2 cursor-pointer select-none">
                    <input type="radio" name="gradingMode" value={mode}
                      checked={gradingMode === mode}
                      onChange={() => setGradingMode(mode)}
                      className="accent-accent mt-0.5" />
                    <span className="text-sm text-ink">
                      {mode === 'strict'   ? 'Strict — exact match (case-insensitive)' :
                       mode === 'flexible' ? 'Flexible — configurable leniency'        :
                                            'Smart AI — semantic evaluation (requires internet)'}
                    </span>
                  </label>
                ))}
              </div>

              {/* Slash/comma splitting — applies to all grading modes */}
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={slashMode === 'accept_any'}
                  onChange={e => setSlashMode(e.target.checked ? 'accept_any' : 'require_all')}
                  className="accent-accent w-4 h-4 mt-0.5"
                />
                <span className="text-sm text-ink">
                  Split slash / comma / semicolon alternatives
                  <span className="block text-xs text-ink-faint mt-0.5">
                    When on: "word / other" accepts either part. When off: the full text must be typed as-is.
                  </span>
                </span>
              </label>

              {gradingMode === 'flexible' && (
                <div className="pl-4 space-y-2 border-l border-white/10">
                  {([
                    ['ignoreAccents',          'Ignore accents',               ignoreAccents,          setIgnoreAccents]          as const,
                    ['ignoreCapitalization',   'Ignore capitalization',        ignoreCapitalization,   setIgnoreCapitalization]   as const,
                    ['ignoreMinorTypos',       'Ignore minor typos',           ignoreMinorTypos,       setIgnoreMinorTypos]       as const,
                    ['ignoreDefiniteArticles', 'Ignore definite articles',     ignoreDefiniteArticles, setIgnoreDefiniteArticles] as const,
                  ] as [string, string, boolean, (v: boolean) => void][]).map(([key, label, value, setter]) => (
                    <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="checkbox" checked={value} onChange={e => setter(e.target.checked)} className="accent-accent w-4 h-4" />
                      <span className="text-sm text-ink">{label}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={requireParenContent} onChange={e => setRequireParenContent(e.target.checked)} className="accent-accent w-4 h-4" />
                    <span className="text-sm text-ink">Require parenthetical content</span>
                  </label>
                </div>
              )}

              {gradingMode === 'smart_ai' && (
                <div className="pl-4 space-y-1.5 border-l border-white/10">
                  <label className="text-sm text-ink-muted">AI grading instructions (optional, ≤250 chars)</label>
                  <textarea
                    className="input text-sm resize-none"
                    rows={3}
                    maxLength={250}
                    value={aiInstructions}
                    onChange={e => setAiInstructions(e.target.value)}
                    placeholder="e.g. Accept regional synonyms, but require correct gender and article."
                  />
                  <p className="text-xs text-ink-faint">{aiInstructions.length}/250</p>
                </div>
              )}
            </div>

            {/* ── Audio ── */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Audio</p>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={autoPlayAudio} onChange={e => setAutoPlayAudio(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Auto-play target language audio</span>
              </label>
            </div>

            {resetError && (
              <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
                ⚠ {resetError}
              </p>
            )}
          </div>

          {/* ── Footer (non-scrolling) ── */}
          <div className="px-5 pb-5 pt-4 border-t border-white/10 shrink-0 space-y-3">
            {saveError && (
              <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
                ⚠ {saveError}
              </p>
            )}
            <div className="flex gap-3">
              <button className="btn-primary flex-1" onClick={handleSave} disabled={saving || resetting}>
                {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save'}
              </button>
              <button className="btn-ghost" onClick={onClose} disabled={saving || resetting}>Cancel</button>
            </div>
          </div>

        </div>
      </div>
    </>
  )
}

// ─── Deck detail page ─────────────────────────────────────────────────────────

export default function DeckDetailPage() {
  const { deckId } = useParams<{ deckId: string }>()
  const router     = useRouter()
  const supabase   = createClient()

  const [deck,             setDeck]             = useState<Deck | null>(null)
  const [parentFolder,     setParentFolder]     = useState<Folder | null>(null)
  const [cards,            setCards]            = useState<Card[]>([])
  const [states,           setStates]           = useState<CardState[]>([])
  const [prefs,            setPrefs]            = useState<DeckPreferences | null>(null)
  const [userId,           setUserId]           = useState('')
  const [defaultLimit,     setDefaultLimit]     = useState(DEFAULT_DAILY_NEW_CARDS)
  const [defaultSpillover, setDefaultSpillover] = useState(false)
  const [loading,          setLoading]          = useState(true)
  const [selectedCardIds,  setSelectedCardIds]  = useState<Set<string>>(new Set())
  const [bulkGraduating,      setBulkGraduating]      = useState(false)
  const [bulkAccelerated,     setBulkAccelerated]     = useState(false)
  const [bulkMovingToLearning,setBulkMovingToLearning]= useState(false)
  const [bulkDeleting,        setBulkDeleting]        = useState(false)
  const [bulkDeleteConfirm,setBulkDeleteConfirm]= useState(false)
  const [bulkResetting,    setBulkResetting]    = useState<string | null>(null)
  const [showBulkResetMenu,setShowBulkResetMenu]= useState(false)
  const [showGear,         setShowGear]         = useState(false)
  const [renamingDeck,     setRenamingDeck]     = useState(false)
  const [deckNameValue,    setDeckNameValue]    = useState('')
  const [editingCard,      setEditingCard]      = useState<Card | null>(null)
  const [deletedCardUndo,  setDeletedCardUndo]  = useState<{ card: Card; state: CardState | null } | null>(null)
  const [syncingCard,      setSyncingCard]      = useState<Card | null>(null)
  const [addingCard,       setAddingCard]       = useState(false)
  const [showSynonymScan,  setShowSynonymScan]  = useState(false)
  const [synonymScanIgnored, setSynonymScanIgnored] = useState(() =>
    typeof window !== 'undefined' && !!localStorage.getItem(`syn_scan_ignored_${deckId}`)
  )
  const searchParams = useSearchParams()
  const activeFilter = searchParams.get('filter') as 'new' | 'learning' | 'graduated' | 'due' | null
  const cardParam    = searchParams.get('card')

  async function loadAll(uid: string) {
    const deckRepo  = new SupabaseDeckRepository()
    const cardRepo  = new SupabaseCardRepository()
    const stateRepo = new SupabaseCardStateRepository()
    const prefRepo  = new SupabaseDeckPreferencesRepository()

    const [d, c, s, p] = await Promise.all([
      deckRepo.get(deckId),
      cardRepo.listByDeck(deckId),
      stateRepo.listByDeck(uid, deckId),
      prefRepo.get(uid, deckId),
    ])

    const { data: profile } = await supabase.from('profiles')
      .select('default_daily_new_cards, spillover_due')
      .eq('user_id', uid).single()

    if (profile?.default_daily_new_cards) setDefaultLimit(profile.default_daily_new_cards)
    if (profile?.spillover_due !== undefined) setDefaultSpillover(profile.spillover_due)

    if (!d) { router.push('/study'); return }
    setDeck(d); setCards(c); setStates(s); setPrefs(p)
    if (!d.syncingComplete) triggerSyncFill()

    if (d.folderId) {
      const folderRepo = new SupabaseFolderRepository()
      setParentFolder(await folderRepo.get(d.folderId))
    } else {
      setParentFolder(null)
    }

    setLoading(false)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user.id
      if (!uid) { router.push('/auth'); return }
      setUserId(uid)
      loadAll(uid)
    })
  }, [deckId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open card detail when ?card=<id> param is present
  useEffect(() => {
    if (!cardParam || cards.length === 0 || editingCard) return
    const target = cards.find(c => c.id === cardParam)
    if (target) setEditingCard(target)
  }, [cardParam, cards]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dismiss the undo toast after 8 seconds
  useEffect(() => {
    if (!deletedCardUndo) return
    const t = setTimeout(() => setDeletedCardUndo(null), 8000)
    return () => clearTimeout(t)
  }, [deletedCardUndo])

  // Cmd+Z restores the most recently deleted card
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!deletedCardUndo) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        const { card, state } = deletedCardUndo
        setDeletedCardUndo(null)
        const cardRepo  = new SupabaseCardRepository()
        const stateRepo = new SupabaseCardStateRepository()
        cardRepo.undelete(card.id)
          .then(() => {
            setCards(prev => prev.some(c => c.id === card.id) ? prev : [...prev, card])
            if (state) {
              stateRepo.upsert(state).catch(console.error)
              setStates(prev => prev.some(s => s.cardId === state.cardId) ? prev : [...prev, state])
            }
          })
          .catch(console.error)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deletedCardUndo])

  async function handleCardSave(cardId: string, front: string, back: string) {
    const cardRepo  = new SupabaseCardRepository()
    const stateRepo = new SupabaseCardStateRepository()
    const { card: updated, forked } = await cardRepo.forkInDeck(deckId, cardId, userId, { front, back })
    if (forked) {
      await stateRepo.copy(userId, cardId, updated.id)
      setStates(prev => {
        const oldState = prev.find(s => s.cardId === cardId)
        const withoutOld = prev.filter(s => s.cardId !== cardId)
        return oldState ? [...withoutOld, { ...oldState, cardId: updated.id }] : withoutOld
      })
    }
    setCards(prev => prev.map(c => c.id === cardId ? updated : c))
    if (deck && !deck.syncingComplete) triggerSyncFill()
  }

  function handleCardUpdate(updated: Card) {
    setCards(prev => prev.map(c => c.id === updated.id ? updated : c))
    setEditingCard(updated)
  }

  function handleStateUpdate(updated: CardState) {
    setStates(prev => {
      const exists = prev.some(s => s.cardId === updated.cardId)
      return exists ? prev.map(s => s.cardId === updated.cardId ? updated : s) : [...prev, updated]
    })
  }

  function handleCardDelete(cardId: string) {
    const card  = cards.find(c => c.id === cardId) ?? null
    const state = states.find(s => s.cardId === cardId) ?? null
    if (card) setDeletedCardUndo({ card, state })
    setCards(prev => prev.filter(c => c.id !== cardId))
    setStates(prev => prev.filter(s => s.cardId !== cardId))
    setSelectedCardIds(prev => { const next = new Set(prev); next.delete(cardId); return next })
    setEditingCard(null)
  }

  function handleCardMerge(deletedCardId: string, survivorCard: Card, survivorState: CardState | undefined) {
    setCards(prev => {
      const without = prev.filter(c => c.id !== deletedCardId)
      return without.some(c => c.id === survivorCard.id) ? without : [...without, survivorCard]
    })
    setStates(prev => {
      const without = prev.filter(s => s.cardId !== deletedCardId)
      if (!survivorState) return without
      return without.some(s => s.cardId === survivorState.cardId)
        ? without.map(s => s.cardId === survivorState.cardId ? survivorState : s)
        : [...without, survivorState]
    })
    setEditingCard(null)
  }

  async function handleNewCardSave(front: string, back: string) {
    if (!deck) return
    const supabase  = createClient()
    const cardRepo  = new SupabaseCardRepository()
    const created   = await cardRepo.bulkCreate(deckId, userId, deck.sourceLanguage, deck.targetLanguage, [{ front, back, position: cards.length }])
    const newCard   = created[0]
    if (!newCard) return
    setCards(prev => [...prev, newCard])

    // Resolve any pending synonym links for this word (case-insensitive match on front)
    try {
      const pendingRepo = new SupabasePendingSynonymLinkRepository()
      const pending = await pendingRepo.findByWord(userId, front, deck.sourceLanguage, deck.targetLanguage)
      if (pending.length === 0) return

      // Bidirectionally apply backSynonyms for each pending link
      let updatedNewCard = newCard
      for (const link of pending) {
        const linkedCard = cards.find(c => c.id === link.linkedCardId)
        if (!linkedCard) { await pendingRepo.deleteById(link.id); continue }

        const newCardBack    = displayText(newCard.back)
        const newCardFront   = displayText(newCard.front)
        const linkedCardBack = displayText(linkedCard.back)
        const linkedCardFront = displayText(linkedCard.front)

        // Update new card: add linked card's back → backSynonyms, linked card's front → frontSynonyms
        const newBase: CardChoices = updatedNewCard.choices ?? { front: [], back: [] }
        const newBackSyns  = newBase.backSynonyms  ?? []
        const newFrontSyns = newBase.frontSynonyms ?? []
        const newChoices: CardChoices = {
          ...newBase,
          backSynonyms:  newBackSyns.some(s  => s.toLowerCase() === linkedCardBack.toLowerCase())  ? newBackSyns  : [...newBackSyns,  linkedCardBack],
          frontSynonyms: newFrontSyns.some(s => s.toLowerCase() === linkedCardFront.toLowerCase()) ? newFrontSyns : [...newFrontSyns, linkedCardFront],
        }
        await supabase.from('cards').update({ choices: newChoices }).eq('id', newCard.id)
        updatedNewCard = { ...updatedNewCard, choices: newChoices }

        // Update linked card: strip placeholder from frontSynonyms, add new card's front/back
        const linkedBase: CardChoices = linkedCard.choices ?? { front: [], back: [] }
        const linkedBackSyns  = linkedBase.backSynonyms  ?? []
        const linkedFrontSyns = (linkedBase.frontSynonyms ?? [])
          .filter(s => s.toLowerCase() !== link.sourceWord.toLowerCase())
        const linkedChoices: CardChoices = {
          ...linkedBase,
          backSynonyms:  linkedBackSyns.some(s  => s.toLowerCase() === newCardBack.toLowerCase())  ? linkedBackSyns  : [...linkedBackSyns,  newCardBack],
          frontSynonyms: linkedFrontSyns.some(s => s.toLowerCase() === newCardFront.toLowerCase()) ? linkedFrontSyns : [...linkedFrontSyns, newCardFront],
        }
        await supabase.from('cards').update({ choices: linkedChoices }).eq('id', linkedCard.id)
        setCards(prev => prev.map(c => c.id === linkedCard.id ? { ...c, choices: linkedChoices } : c))

        await pendingRepo.deleteById(link.id)
      }

      // Update the new card in state with resolved synonyms
      setCards(prev => prev.map(c => c.id === newCard.id ? updatedNewCard : c))
    } catch {
      // Non-fatal — the card was created, pending links just weren't auto-resolved
    }
  }

  async function handleRenameDeck() {
    const name = deckNameValue.trim()
    if (!name || !deck) return
    const deckRepo = new SupabaseDeckRepository()
    await deckRepo.update(deckId, { name })
    setDeck(prev => prev ? { ...prev, name } : prev)
    setRenamingDeck(false)
  }

  async function handleBulkMoveToLearning() {
    if (selectedCardIds.size === 0 || bulkMovingToLearning) return
    setBulkMovingToLearning(true)
    try {
      const stateRepo      = new SupabaseCardStateRepository()
      const pipelineRepo   = new SupabasePipelineRepository()
      const defaultPipeline = await pipelineRepo.getDefault()
      const updates = await Promise.all(
        [...selectedCardIds].map(cardId => {
          const existing = states.find(s => s.cardId === cardId)
          const base     = existing ?? initialCardState(userId, cardId, defaultPipeline.id)
          const learning: CardState = {
            ...base,
            graduated:              false,
            currentStepOrder:       0,
            correctInStep:          0,
            dueAt:                  null,
            intervalDays:           0,
            scheduledIntervalDays:  0,
            lastRating:             null,
            relearningStep:         0,
            pendingIntervalDays:    null,
            typingMistakeStreak:    0,
            typingFailCycles:       0,
            stage3EnteredDate:      null,
          }
          return stateRepo.upsert(learning)
        })
      )
      setStates(prev => {
        const map = new Map(prev.map(s => [s.cardId, s]))
        for (const s of updates) map.set(s.cardId, s)
        return [...map.values()]
      })
      setSelectedCardIds(new Set())
    } catch (err) {
      console.error('Bulk move to learning failed:', err)
    } finally {
      setBulkMovingToLearning(false)
    }
  }

  async function handleBulkGraduate() {
    if (selectedCardIds.size === 0 || bulkGraduating) return
    setBulkGraduating(true)
    try {
      const stateRepo    = new SupabaseCardStateRepository()
      const pipelineRepo = new SupabasePipelineRepository()
      const defaultPipeline = await pipelineRepo.getDefault()
      const now    = new Date()
      const nowIso = now.toISOString()
      const cardIds = [...selectedCardIds]

      let updates: CardState[]
      if (bulkAccelerated) {
        // Spread due dates across a 14-day window, using the existing schedule as a guide
        const dueDates = await batchFastTrackDueDates(userId, cardIds.length, now, stateRepo)
        updates = await Promise.all(
          cardIds.map(async (cardId, i) => {
            const dueAt = dueDates[i] ?? (nowIso)
            return stateRepo.upsert(fastTrackCardState(userId, cardId, defaultPipeline.id, dueAt, now))
          })
        )
      } else {
        const dueAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
        updates = await Promise.all(
          cardIds.map(async cardId => {
            const existing = states.find(s => s.cardId === cardId)
            const base     = existing ?? initialCardState(userId, cardId, defaultPipeline.id)
            const graduated: CardState = {
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
              acceleratedMode:       'bulk_known',
            }
            return stateRepo.upsert(graduated)
          })
        )
      }
      setStates(prev => {
        const map = new Map(prev.map(s => [s.cardId, s]))
        for (const s of updates) map.set(s.cardId, s)
        return [...map.values()]
      })
      setSelectedCardIds(new Set())
    } catch (err) {
      console.error('Bulk graduate failed:', err)
    } finally {
      setBulkGraduating(false)
    }
  }

  async function handleBulkDelete() {
    if (selectedCardIds.size === 0 || bulkDeleting) return
    setBulkDeleting(true)
    setBulkDeleteConfirm(false)
    try {
      const cardRepo = new SupabaseCardRepository()
      // Filter to IDs still present in the card list — ghost IDs (already-deleted
      // cards whose ID stayed in selectedCardIds) would cause the RPC to error.
      const existingCardIds = new Set(cards.map(c => c.id))
      const ids = [...selectedCardIds].filter(id => existingCardIds.has(id))
      await Promise.all(ids.map(id => cardRepo.softDelete(id)))
      setCards(prev => prev.filter(c => !selectedCardIds.has(c.id)))
      setStates(prev => prev.filter(s => !selectedCardIds.has(s.cardId)))
      setSelectedCardIds(new Set())
    } catch (err) {
      console.error('Bulk delete failed:', err)
    } finally {
      setBulkDeleting(false)
    }
  }

  async function handleBulkReset(action: 'distractors' | 'progress' | 'audio' | 'all') {
    if (selectedCardIds.size === 0 || bulkResetting) return
    setBulkResetting(action)
    setShowBulkResetMenu(false)
    const ids = [...selectedCardIds]
    try {
      if (action === 'distractors' || action === 'all') {
        await supabase.from('cards').update({ choices: null }).in('id', ids)
        setCards(prev => prev.map(c => selectedCardIds.has(c.id) ? { ...c, choices: null } : c))
      }
      if (action === 'progress' || action === 'all') {
        await supabase.from('card_states').delete().in('card_id', ids).eq('user_id', userId)
        setStates(prev => prev.filter(s => !selectedCardIds.has(s.cardId)))
      }
      if (action === 'audio' || action === 'all') {
        await supabase.from('cards').update({ audio_generated: false, audio_data: null }).in('id', ids)
        setCards(prev => prev.map(c => selectedCardIds.has(c.id) ? { ...c, audioGenerated: false, audioData: null } : c))
      }
      setSelectedCardIds(new Set())
    } catch (err) {
      console.error('Bulk reset failed:', err)
    } finally {
      setBulkResetting(null)
    }
  }

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>
  if (!deck)   return null

  // Forward states are authoritative for card-level status and filtering.
  // Reverse states only count toward dueNow when their forward counterpart is also graduated.
  const forwardStates  = states.filter(s => s.reviewDirection !== 'reverse')
  const stateMap       = new Map(forwardStates.map(s => [s.cardId, s]))
  const now            = new Date()

  const synonymCandidates: SynonymCandidate[] = cards
    .filter(c => !c.synonymGroupId)
    .flatMap(c => {
      const segs = detectSynonymSplit(c.front)
      return segs ? [{ card: c, segments: segs, split: true }] : []
    })
  const activeCardIds       = new Set(cards.map(c => c.id))
  const activeForwardStates = forwardStates.filter(s => activeCardIds.has(s.cardId))
  const unlearned = cards.filter(c => !stateMap.has(c.id)).length
  const learning  = activeForwardStates.filter(s => !s.graduated).length
  const graduated = activeForwardStates.filter(s => s.graduated).length
  const dueNow    = states.filter(s =>
    activeCardIds.has(s.cardId) &&
    s.graduated && s.dueAt && new Date(s.dueAt) <= now &&
    (s.reviewDirection !== 'reverse' || stateMap.get(s.cardId)?.graduated === true)
  ).length

  const visibleCards = cards.filter(card => {
    if (!activeFilter) return true
    const s = stateMap.get(card.id)
    if (activeFilter === 'new')       return !s
    if (activeFilter === 'learning')  return s && !s.graduated
    if (activeFilter === 'graduated') return s?.graduated
    if (activeFilter === 'due')       return s?.graduated && s.dueAt && new Date(s.dueAt) <= now
    return true
  })
  const allVisibleSelected = visibleCards.length > 0 && visibleCards.every(c => selectedCardIds.has(c.id))

  const prefRepo    = new SupabaseDeckPreferencesRepository()
  const rawLimit    = prefs ? prefRepo.effectiveDailyLimit(prefs) : defaultLimit
  const activeLimit = Math.min(rawLimit, cards.length)

  return (
    <div className="space-y-8">
      {deletedCardUndo && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-surface-raised border border-white/10 rounded-card shadow-lg px-4 py-3 text-sm">
          <span className="text-ink-muted">Card deleted.</span>
          <button
            onClick={() => {
              const { card, state } = deletedCardUndo
              setDeletedCardUndo(null)
              const cardRepo  = new SupabaseCardRepository()
              const stateRepo = new SupabaseCardStateRepository()
              cardRepo.undelete(card.id)
                .then(() => {
                  setCards(prev => prev.some(c => c.id === card.id) ? prev : [...prev, card])
                  if (state) {
                    stateRepo.upsert(state).catch(console.error)
                    setStates(prev => prev.some(s => s.cardId === state.cardId) ? prev : [...prev, state])
                  }
                })
                .catch(console.error)
            }}
            className="text-accent font-medium hover:text-accent/80 transition-colors"
          >
            Undo
          </button>
          <span className="text-ink-faint text-xs">(⌘Z)</span>
          <button onClick={() => setDeletedCardUndo(null)} className="text-ink-faint hover:text-ink transition-colors ml-1">✕</button>
        </div>
      )}

      {addingCard && (
        <NewCardModal
          existingFronts={cards.map(c => c.front)}
          onSave={handleNewCardSave}
          onClose={() => setAddingCard(false)}
        />
      )}

      {editingCard && (
        <CardEditModal
          card={editingCard}
          state={stateMap.get(editingCard.id)}
          userId={userId}
          deckId={deckId}
          deckCards={cards}
          sourceLanguage={deck.sourceLanguage}
          targetLanguage={deck.targetLanguage}
          onSave={handleCardSave}
          onCardChange={handleCardUpdate}
          onStateChange={handleStateUpdate}
          onClose={() => setEditingCard(null)}
          onDelete={handleCardDelete}
          onMerge={handleCardMerge}
          onJumpToCard={cardId => {
            const target = cards.find(c => c.id === cardId)
            if (target) setEditingCard(target)
          }}
          onSyncCard={() => setSyncingCard(editingCard)}
          initialShowStats={editingCard.id === cardParam}
        />
      )}

      {syncingCard && deck && (
        <SyncReviewModal
          card={syncingCard}
          userId={userId}
          sourceLanguage={deck.sourceLanguage}
          targetLanguage={deck.targetLanguage}
          onClose={() => setSyncingCard(null)}
        />
      )}

      {showSynonymScan && synonymCandidates.length > 0 && (
        <SynonymScanModal
          deckId={deckId}
          userId={userId}
          candidates={synonymCandidates}
          deckCards={cards}
          sourceLanguage={deck.sourceLanguage}
          targetLanguage={deck.targetLanguage}
          onDone={(removedIds, addedCards) => {
            setCards(prev => [
              ...prev.filter(c => !removedIds.includes(c.id)),
              ...addedCards,
            ])
            setShowSynonymScan(false)
          }}
          onClose={() => setShowSynonymScan(false)}
        />
      )}

      {showGear && (
        <DeckSettingsPanel
          deckId={deckId} userId={userId} deck={deck} initialPrefs={prefs}
          defaultLimit={defaultLimit} defaultSpillover={defaultSpillover}
          maxCards={cards.length}
          cards={cards} sourceLanguage={deck.sourceLanguage} targetLanguage={deck.targetLanguage}
          onClose={() => { setShowGear(false); loadAll(userId) }}
        />
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <Link
            href={parentFolder
              ? `/library/${parentFolder.id}?source=${deck.sourceLanguage}&target=${deck.targetLanguage}`
              : '/library'}
            className="text-xs text-ink-muted hover:text-ink mb-2 inline-block"
          >
            ← {parentFolder ? parentFolder.name : 'Library'}
          </Link>
          {renamingDeck ? (
            <input
              autoFocus
              className="text-2xl font-semibold bg-transparent outline-none border-b border-accent text-ink w-full max-w-sm"
              value={deckNameValue}
              onChange={e => setDeckNameValue(e.target.value)}
              onBlur={handleRenameDeck}
              onKeyDown={e => {
                if (e.key === 'Enter') handleRenameDeck()
                if (e.key === 'Escape') setRenamingDeck(false)
              }}
            />
          ) : (
            <h1
              className="text-2xl font-semibold text-ink cursor-text select-none"
              title="Double-click to rename"
              onDoubleClick={() => { setDeckNameValue(deck.name); setRenamingDeck(true) }}
            >
              {deck.name}
            </h1>
          )}
          <p className="text-ink-muted text-sm mt-1">
            {cards.length} cards · {deck.targetLanguage.toUpperCase()} · {activeLimit} new/day
            {(prefs?.spilloverDue ?? defaultSpillover) && <span className="text-warning ml-1">· spillover on</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button onClick={() => setShowGear(true)}
            className="p-2.5 rounded-lg border border-white/10 hover:border-white/20 text-ink-muted hover:text-ink transition-colors"
            title="Study settings">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <Link href={`/study/${deckId}/add`}     className="btn-ghost text-sm">Add cards</Link>
          <Link href={`/study/${deckId}/edit`}    className="btn-ghost text-sm">Edit</Link>
          <Link href={`/study/${deckId}/session`} className="btn-primary text-sm">Study</Link>
        </div>
      </div>

      {synonymCandidates.length > 0 && !synonymScanIgnored && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
          <span className="text-ink">
            <span className="font-medium">{synonymCandidates.length} card{synonymCandidates.length !== 1 ? 's' : ''}</span>
            {' '}may contain multiple translations — split into separate synonym cards?
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="btn-ghost text-xs"
              onClick={() => setShowSynonymScan(true)}
            >
              Review
            </button>
            <button
              className="btn-ghost text-xs text-ink-faint"
              onClick={() => {
                localStorage.setItem(`syn_scan_ignored_${deckId}`, '1')
                setSynonymScanIgnored(true)
              }}
            >
              Ignore
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Unlearned', value: unlearned, color: 'text-ink-muted',   border: 'border-ink-faint', filter: 'new',       desc: 'Not yet started'  },
          { label: 'Learning',  value: learning,  color: 'text-warning',     border: 'border-warning',   filter: 'learning',  desc: 'In pipeline'      },
          { label: 'Graduated', value: graduated, color: 'text-success',     border: 'border-success',   filter: 'graduated', desc: 'Long-term review' },
          { label: 'Due Now',   value: dueNow,    color: 'text-accent-soft', border: 'border-accent',    filter: 'due',       desc: 'Ready to review'  },
        ].map(({ label, value, color, border, filter, desc }) => {
          const isActive = activeFilter === filter
          return (
            <Link
              key={label}
              href={isActive ? `/study/${deckId}` : `/study/${deckId}?filter=${filter}`}
              className={`panel border-t-2 ${border} text-center transition-colors w-full block space-y-1
                ${isActive ? 'bg-surface-raised ring-1 ring-white/10' : 'hover:bg-surface-raised/50'}`}
            >
              <div className={`text-2xl font-semibold ${color}`}>{value}</div>
              <div className="text-xs font-medium text-ink">{label}</div>
              <div className="text-xs text-ink-faint">{desc}</div>
            </Link>
          )
        })}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Cards</h2>
          {activeFilter && (
            <Link href={`/study/${deckId}`} className="text-xs text-accent hover:text-accent-soft transition-colors">
              Show all ✕
            </Link>
          )}
        </div>

        {activeFilter && (() => {
          const filterCount = activeFilter === 'new' ? unlearned : activeFilter === 'learning' ? learning : activeFilter === 'graduated' ? graduated : dueNow
          const filterLabel = activeFilter === 'new' ? 'Unlearned' : activeFilter === 'learning' ? 'Learning' : activeFilter === 'graduated' ? 'Graduated' : 'Due Now'
          return filterCount > 0 ? (
            <Link
              href={`/study/${deckId}/session?category=${activeFilter}`}
              className="btn-primary block w-full text-center"
            >
              Study {filterLabel}
            </Link>
          ) : (
            <span className="block w-full text-center text-sm py-2 text-ink-faint/40 select-none">
              Study {filterLabel}
            </span>
          )
        })()}

        {selectedCardIds.size > 0 && (
          <div className="flex flex-col gap-2 px-3 py-2 rounded-card border border-accent/30 bg-accent/5 text-sm">
            {bulkDeleteConfirm ? (
              <div className="flex items-center justify-between">
                <span className="text-ink-muted text-xs">Delete {selectedCardIds.size} card{selectedCardIds.size !== 1 ? 's' : ''}? This cannot be undone.</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setBulkDeleteConfirm(false)} className="text-xs text-ink-faint hover:text-ink transition-colors">Cancel</button>
                  <button onClick={handleBulkDelete} disabled={bulkDeleting} className="text-xs px-3 py-1 rounded bg-danger/80 hover:bg-danger text-white transition-colors">
                    {bulkDeleting ? 'Deleting…' : 'Yes, delete'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-ink-muted">{selectedCardIds.size} card{selectedCardIds.size !== 1 ? 's' : ''} selected</span>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => setSelectedCardIds(new Set())} className="text-xs text-ink-faint hover:text-ink transition-colors">
                    Clear
                  </button>
                  {/* Reset dropdown */}
                  {showBulkResetMenu && (
                    <div className="fixed inset-0 z-40" onClick={() => setShowBulkResetMenu(false)} />
                  )}
                  <div className="relative">
                    <button
                      onClick={() => setShowBulkResetMenu(v => !v)}
                      disabled={!!bulkResetting}
                      className="text-xs px-3 py-1 rounded border border-white/10 hover:border-white/20 text-ink-muted hover:text-ink transition-colors"
                    >
                      {bulkResetting ? 'Resetting…' : 'Reset ▾'}
                    </button>
                    {showBulkResetMenu && (
                      <div className="absolute right-0 top-full mt-1 z-50 bg-surface-raised border border-white/10 rounded-card shadow-lg py-1 min-w-[200px]">
                        {([
                          ['distractors', 'Reset distractors',  'Clears cached multiple-choice options.'],
                          ['progress',    'Reset progress',     'Erases reps, lapses, schedule.'],
                          ['audio',       'Reset audio',        'Clears cached audio.'],
                          ['all',         'Reset entirely',     'Resets progress, distractors, and audio.'],
                        ] as const).map(([action, label, desc]) => (
                          <button
                            key={action}
                            onClick={() => handleBulkReset(action)}
                            className={`w-full text-left px-3 py-2 hover:bg-white/5 transition-colors ${action === 'all' ? 'text-danger' : 'text-ink'}`}
                          >
                            <span className="block text-sm">{label}</span>
                            <span className="block text-xs text-ink-faint">{desc}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={handleBulkMoveToLearning}
                    disabled={bulkMovingToLearning}
                    className="text-xs px-3 py-1 rounded border border-white/10 hover:border-white/20 text-ink-muted hover:text-ink transition-colors disabled:opacity-40"
                  >
                    {bulkMovingToLearning ? 'Moving…' : 'Move to learning'}
                  </button>
                  <button
                    onClick={() => setBulkDeleteConfirm(true)}
                    className="text-xs px-3 py-1 rounded border border-danger/30 text-danger hover:bg-danger/10 transition-colors"
                  >
                    Delete
                  </button>
                  <button
                    onClick={handleBulkGraduate}
                    disabled={bulkGraduating}
                    className="btn-primary text-xs px-3 py-1"
                  >
                    {bulkGraduating ? 'Graduating…' : 'Graduate selected'}
                  </button>
                </div>
              </div>
            )}
            {!bulkDeleteConfirm && (
              <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
                <input
                  type="checkbox"
                  checked={bulkAccelerated}
                  onChange={e => setBulkAccelerated(e.target.checked)}
                  className="accent-accent w-3.5 h-3.5"
                />
                <span className="text-xs text-ink-muted">Accelerated track — spread due dates across 14 days</span>
              </label>
            )}
          </div>
        )}

        <div className="flex items-center justify-between px-1 mb-1">
          <span className="text-xs text-ink-faint">{visibleCards.length} card{visibleCards.length !== 1 ? 's' : ''}</span>
          {visibleCards.length > 0 && (
            <button
              onClick={() => {
                if (allVisibleSelected) {
                  setSelectedCardIds(prev => {
                    const next = new Set(prev)
                    visibleCards.forEach(c => next.delete(c.id))
                    return next
                  })
                } else {
                  setSelectedCardIds(prev => {
                    const next = new Set(prev)
                    visibleCards.forEach(c => next.add(c.id))
                    return next
                  })
                }
              }}
              className="text-xs text-ink-faint hover:text-ink transition-colors"
            >
              {allVisibleSelected ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </div>

        <div className="panel divide-y divide-white/5 p-0 overflow-hidden">
          {visibleCards.map(card => {
            const s = stateMap.get(card.id)
            const status = !s ? 'New' : s.graduated ? 'Graduated' : `Step ${s.currentStepOrder + 1}`
            const isSelected = selectedCardIds.has(card.id)
            return (
              <div
                key={card.id}
                onClick={() => setEditingCard(card)}
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-surface-raised/50 transition-colors group"
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {
                    setSelectedCardIds(prev => {
                      const next = new Set(prev)
                      if (next.has(card.id)) next.delete(card.id)
                      else next.add(card.id)
                      return next
                    })
                  }}
                  className="accent-accent w-4 h-4 shrink-0"
                  onClick={e => e.stopPropagation()}
                />
                <div className="flex gap-3 sm:gap-6 text-sm min-w-0 flex-1">
                  <span className="text-ink font-medium w-28 sm:w-40 truncate shrink-0">{displayText(card.front)}</span>
                  <span className="text-ink-muted truncate">{displayText(card.back)}</span>
                </div>
                <span className="chip shrink-0 ml-1">{status}</span>
              </div>
            )
          })}
          {visibleCards.length === 0 && activeFilter && (
            <div className="px-4 py-6 text-center text-ink-muted text-sm">
              No cards in this category.
            </div>
          )}
        </div>

        <button
          onClick={() => setAddingCard(true)}
          className="w-full border border-dashed border-white/15 hover:border-accent/40 hover:bg-surface/30
                     rounded-card text-ink-faint hover:text-ink transition-colors text-sm py-4 text-center"
        >
          + New card
        </button>
      </div>
    </div>
  )
}
