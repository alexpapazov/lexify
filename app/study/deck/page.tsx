'use client'

import { useEffect, useState, useRef } from 'react'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { apiUrl } from '@/lib/apiBase'
import { routes } from '@/lib/routes'
import { StarFilterButton } from '@/components/StarFilterButton'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }            from '@/lib/data/decks'
import { SupabaseCardRepository }            from '@/lib/data/cards'
import { SupabaseCardStateRepository }       from '@/lib/data/cardStates'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { setAudioPlaybackRate, setAudioVolume } from '@/lib/speak'
import { SupabaseFolderRepository }          from '@/lib/data/folders'
import { SupabasePipelineRepository }        from '@/lib/data/pipelines'
import { SupabaseSynonymGroupRepository }    from '@/lib/data/synonymGroups'
import { SupabaseLanguageSyncRuleRepository } from '@/lib/data/languageSyncRules'
import { SupabaseSyncedCardLinkRepository }  from '@/lib/data/syncedCardLinks'
import { SupabaseLanguagePairRepository }    from '@/lib/data/languagePairs'
import { ensureSyncInfra }                   from '@/lib/syncFolderInfra'
import { triggerSyncFill }                   from '@/lib/triggerSyncFill'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import { SupabasePendingSynonymLinkRepository } from '@/lib/data/pendingSynonymLinks'
import type { Deck, Card, CardState, CardChoices, DeckPreferences, Folder, LanguagePair, LanguageSyncRule, SyncedCardLink } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'
import { getToday } from '@/lib/dates'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildEnabledTracksMap, type EnabledTracks } from '@/lib/sessionLimits'
import { isCardStateDueNow } from '@/lib/dueStatus'
import { forwardStateMap } from '@/lib/cardStateMap'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { SupabaseCardOnboardingRepository } from '@/lib/data/cardOnboarding'
import type { ClimbState } from '@/engine/ladderEngine'
import { prefetchChoices, type PrefetchItem } from '@/lib/distractors'
import { langName } from '@/lib/languages'
import { displayText } from '@/lib/cardText'
import { initialCardState, fastTrackCardState } from '@/engine/pipeline'
import { batchFastTrackDueDates } from '@/engine/density'
import { CardEditModal } from '@/components/CardEditModal'
import { ConfirmDialog } from '@/components/ConfirmDialog'


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
          const res = await fetch(apiUrl('/api/sync-translate'), {
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
            !row.checked                      ? 'border-line/5 opacity-40' :
            'border-line/10'
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
            // Chain them pairwise through linkAsSynonyms so a card that ALREADY has synonyms brings
            // its whole group along, instead of being pulled out of it and stranding its partners.
            for (let i = 1; i < allGroupCards.length; i++) {
              await synonymRepo.linkAsSynonyms(
                userId, allGroupCards[0]!, allGroupCards[i]!, sourceLanguage, targetLanguage)
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
      <div className="bg-surface rounded-xl border border-line/10 w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line/10 shrink-0">
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
              <label key={item.card.id} className="flex items-start gap-3 cursor-pointer panel hover:border-line/20 transition-colors">
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

        <div className="flex gap-3 px-5 py-4 border-t border-line/10 shrink-0">
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

function DeckSettingsPanel({ deckId, userId, deck, initialPrefs, defaultLimit, defaultSpillover, maxCards, cards, sourceLanguage, targetLanguage, onboardableIds, pendingOnboarding, onClose }: {
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
  /** Cards eligible for confidence rating — never-studied ones only (see the call site). */
  onboardableIds:   string[]
  /** Cards already queued by a previous onboarding run and not yet rated. */
  pendingOnboarding: number
  onClose:          () => void
}) {
  const today    = new Date().toISOString().slice(0, 10)
  const prefRepo = new SupabaseDeckPreferencesRepository()
  const router   = useRouter()

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
  // Free-typed draft for "Max cards in pipeline" — clamp only on commit (Enter/blur), not while typing.
  const [cardsDraft,         setCardsDraft]         = useState(String(initialPrefs?.cardsPerSession || 12))
  const clampCards = (raw: string): number => {
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? Math.min(maxCards, Math.max(1, n)) : 1   // ≤0 → 1, > deck size → deck size
  }
  const commitCards = () => { const c = clampCards(cardsDraft); setCardsPerSession(c); setCardsDraft(String(c)) }
  const [learningBatchMode,  setLearningBatchMode]  = useState(initialPrefs?.learningBatchMode ?? false)
  const [capNewToGoal,       setCapNewToGoal]       = useState(initialPrefs?.capNewToGoal ?? false)
  const [audioSpeed,         setAudioSpeed]         = useState(initialPrefs?.audioSpeed ?? 1)
  const [audioVolume,        setAudioVolumeState]   = useState(initialPrefs?.audioVolume ?? 1)
  // Apply speed/volume immediately so the "Play audio" preview reflects the controls live.
  useEffect(() => { setAudioPlaybackRate(audioSpeed) }, [audioSpeed])
  useEffect(() => { setAudioVolume(audioVolume) }, [audioVolume])
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

  // Vocabulary onboarding for an already-saved deck
  const [queueing,   setQueueing]   = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)

  /**
   * Queues this deck's never-studied cards for confidence rating, then opens the rating screen.
   *
   * Cards that already carry an onboarding row are left alone, so re-opening this doesn't reset
   * ratings you already gave — it just tops the queue up with anything added since.
   */
  async function startOnboarding() {
    if (queueing) return
    setQueueing(true)
    setQueueError(null)
    try {
      const repo = new SupabaseCardOnboardingRepository()
      const already = new Set((await repo.listForDeck(userId, deckId)).map(r => r.cardId))
      const fresh = onboardableIds.filter(id => !already.has(id))
      if (fresh.length > 0) await repo.createPending(userId, deckId, fresh)
      router.push(routes.deckOnboard(deckId))
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : 'Could not start onboarding.')
      setQueueing(false)
    }
  }

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
          cardsPerSession:      cardsPerSessionOn ? clampCards(cardsDraft) : null,
          electiveSessionLimit: cardsPerSessionOn ? clampCards(cardsDraft) : 0,
          learningBatchMode:    cardsPerSessionOn ? learningBatchMode : false,
          capNewToGoal,
          audioSpeed,
          audioVolume,
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
      // Also clear ladder climb progress for the deck's cards (returns them to Unlearned).
      await createClient().from('ladder_climb').delete().in('card_id', cards.map(c => c.id)).eq('user_id', userId)
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
          <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-line/10 shrink-0">
            <h2 className="text-base font-semibold text-ink">Deck study settings</h2>
            <div className="flex items-center gap-2 relative">
              {/* Reset menu trigger */}
              <button
                onClick={() => setShowResetMenu(v => !v)}
                className="text-danger/70 hover:text-danger transition-colors text-lg leading-none"
                title="Reset options"
              >↺</button>
              {showResetMenu && (
                <div className="absolute right-0 top-full mt-1 z-10 bg-surface-raised border border-line/10 rounded-lg py-1 w-52 shadow-xl">
                  <button
                    onClick={() => { setShowResetMenu(false); setConfirmReset(true) }}
                    className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-line/5 transition-colors"
                  >Reset backlog</button>
                  <button
                    onClick={() => { setShowResetMenu(false); setConfirmResetChoices(true) }}
                    className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-line/5 transition-colors"
                  >Reset distractors</button>
                  <button
                    onClick={() => { setShowResetMenu(false); setConfirmFullReset(true) }}
                    className="w-full text-left px-4 py-2 text-sm text-danger/80 hover:bg-line/5 transition-colors"
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
            <div className="space-y-2 border-t border-line/10 pt-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={cardsPerSessionOn} onChange={e => setCardsPerSessionOn(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Limit cards in learning</span>
              </label>
              {cardsPerSessionOn && (
                <div className="space-y-2 pl-6">
                  <div className="space-y-1">
                    <label className="text-sm text-ink-muted">Max cards in pipeline</label>
                    <input type="number" min={1} max={maxCards} className="input"
                      value={cardsDraft}
                      onChange={e => setCardsDraft(e.target.value)}
                      onBlur={commitCards}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitCards() } }} />
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

            {/* Stop intake at the daily goal — an extra ceiling on top of the limits above */}
            <div className="space-y-1 border-t border-line/10 pt-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={capNewToGoal} onChange={e => setCapNewToGoal(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Stop at daily goal</span>
              </label>
              <p className="text-xs text-ink-faint pl-6">
                {capNewToGoal
                  ? 'Keeps topping the pipeline up toward this language\'s daily goal, but never enough to graduate past it. E.g. goal 20 with 5 done + 5 in the pipeline adds 10 more; goal 10 with 10 in the pipeline adds none. Still respects the limits above.'
                  : 'New cards keep entering up to the limits above, regardless of your daily goal.'}
              </p>
            </div>

            {/* ── Grading mode ──────────────────────────────────────────────── */}
            <div className="space-y-3 border-t border-line/10 pt-3">
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
                <div className="pl-4 space-y-2 border-l border-line/10">
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
                <div className="pl-4 space-y-1.5 border-l border-line/10">
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

            {/* ── Vocabulary onboarding ── */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Vocabulary onboarding</p>
              <p className="text-xs text-ink-faint">
                Rate how well you already know each word instead of learning it from scratch. Cards you
                know are scheduled straight into Due Now.
              </p>
              <button
                type="button"
                className="btn-ghost text-sm w-full"
                disabled={queueing || (pendingOnboarding === 0 && onboardableIds.length === 0)}
                onClick={() => void startOnboarding()}
              >
                {queueing
                  ? 'Opening…'
                  : pendingOnboarding > 0
                    ? `Continue onboarding (${pendingOnboarding} left)`
                    : onboardableIds.length > 0
                      ? `Rate ${onboardableIds.length} unlearned card${onboardableIds.length !== 1 ? 's' : ''}`
                      : 'Nothing left to rate'}
              </button>
              {pendingOnboarding === 0 && onboardableIds.length === 0 && (
                <p className="text-xs text-ink-faint">
                  Every card here has been studied already. Onboarding only covers cards with no review
                  history, so rating one can&apos;t overwrite real progress.
                </p>
              )}
              {queueError && <p className="text-danger text-xs">{queueError}</p>}
            </div>

            {/* ── Audio ── */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Audio</p>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={autoPlayAudio} onChange={e => setAutoPlayAudio(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Auto-play target language audio</span>
              </label>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink">Playback speed</span>
                <select
                  value={audioSpeed}
                  onChange={e => setAudioSpeed(Number(e.target.value))}
                  className="input text-sm w-28"
                >
                  {[0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25].map(v => (
                    <option key={v} value={v}>{v === 1 ? 'Normal' : `${v}×`}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink">Volume</span>
                <div className="flex items-center gap-2 w-44">
                  <input
                    type="range" min={0} max={200} step={10}
                    value={Math.round(audioVolume * 100)}
                    onChange={e => setAudioVolumeState(Number(e.target.value) / 100)}
                    className="accent-accent flex-1 cursor-pointer"
                  />
                  <span className="text-xs text-ink-muted tabular-nums w-10 text-right">{Math.round(audioVolume * 100)}%</span>
                </div>
              </div>
              <p className="text-xs text-ink-faint">100% is normal; up to 200% plays real clips louder (the robotic voice can&apos;t exceed 100%).</p>
            </div>

            {resetError && (
              <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
                ⚠ {resetError}
              </p>
            )}
          </div>

          {/* ── Footer (non-scrolling) ── */}
          <div className="px-5 pb-5 pt-4 border-t border-line/10 shrink-0 space-y-3">
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
  const deckId = useSearchParams().get('deck') ?? ''
  const router     = useRouter()
  const supabase   = createClient()

  const [deck,             setDeck]             = useState<Deck | null>(null)
  const [parentFolder,     setParentFolder]     = useState<Folder | null>(null)
  const [cards,            setCards]            = useState<Card[]>([])
  const [states,           setStates]           = useState<CardState[]>([])
  const [climb,            setClimb]            = useState<Map<string, ClimbState>>(new Map())
  const [prefs,            setPrefs]            = useState<DeckPreferences | null>(null)
  const [userId,           setUserId]           = useState('')
  const [defaultLimit,     setDefaultLimit]     = useState(DEFAULT_DAILY_NEW_CARDS)
  const [defaultSpillover, setDefaultSpillover] = useState(false)
  const [tz,               setTz]               = useState('UTC')
  const [turnoverHour,     setTurnoverHour]     = useState(0)
  const [enabledTracks,    setEnabledTracks]    = useState<EnabledTracks | undefined>(undefined)
  /** Words queued by vocabulary onboarding that were never rated (migration 107). */
  const [pendingOnboarding, setPendingOnboarding] = useState(0)
  /** Every card with an onboarding row, rated or not — band 1 ("don't know") writes no card state,
   *  so without this set an idk-rated card would look onboardable again. */
  const [onboardedIds, setOnboardedIds] = useState<Set<string>>(new Set())
  const [loading,          setLoading]          = useState(true)
  const [selectedCardIds,  setSelectedCardIds]  = useState<Set<string>>(new Set())
  const [bulkGraduating,      setBulkGraduating]      = useState(false)
  const [bulkGraduateError,   setBulkGraduateError]   = useState<string | null>(null)
  const [bulkAccelerated,     setBulkAccelerated]     = useState(false)
  const [bulkMovingToLearning,setBulkMovingToLearning]= useState(false)
  const [bulkStarring,      setBulkStarring]      = useState(false)
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
  const activeFilter = searchParams.get('filter') as 'new' | 'learning' | 'graduated' | 'due' | 'dormant' | 'starred' | null
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
      .select('default_daily_new_cards, spillover_due, timezone, day_turnover_hour')
      .eq('user_id', uid).single()

    if (profile?.default_daily_new_cards) setDefaultLimit(profile.default_daily_new_cards)
    if (profile?.spillover_due !== undefined) setDefaultSpillover(profile.spillover_due)
    setTz((profile?.timezone as string | null) ?? deviceTimeZone())
    setTurnoverHour((profile?.day_turnover_hour as number | null) ?? 0)

    if (!d) { router.push('/study'); return }
    setDeck(d); setCards(c); setStates(s); setPrefs(p)
    // Enabled review tracks for this pair — so the Due Now count matches the dashboard/session
    // (a ghosted/disabled track doesn't count). Best-effort; undefined falls back to defaults.
    new SupabaseUserSchedulerParamsRepository().listForUser(uid)
      .then(rows => setEnabledTracks(buildEnabledTracksMap(rows).get(`${d.sourceLanguage}|${d.targetLanguage}`)))
      .catch(() => {})
    // Ladder climb progress (drives the Learning status for cards on the ladder).
    new SupabaseLadderClimbRepository().listForCards(uid, c.map(x => x.id)).then(setClimb).catch(() => {})
    // Any words left un-rated from a vocabulary-onboarding session — surfaced as "Finish onboarding".
    // The full row list (not just pending counts) also identifies already-onboarded cards.
    new SupabaseCardOnboardingRepository().listForDeck(uid, deckId)
      .then(rows => {
        setPendingOnboarding(rows.filter(r => r.band === null).length)
        setOnboardedIds(new Set(rows.map(r => r.cardId)))
      }).catch(() => {})
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
      // Match on (cardId, reviewDirection) so updating a card's forward state
      // doesn't overwrite its reverse-direction row (and vice versa).
      const dir = updated.reviewDirection ?? 'forward'
      const matches = (s: CardState) => s.cardId === updated.cardId && (s.reviewDirection ?? 'forward') === dir
      return prev.some(matches) ? prev.map(s => matches(s) ? updated : s) : [...prev, updated]
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

  /**
   * Star or unstar every selected card. Chunked writes rather than one call per card, and the flag
   * is chosen from the selection: if any selected card is unstarred, the action stars them all —
   * otherwise it clears them. That makes one button do both without a mode toggle.
   */
  async function handleBulkStar() {
    if (selectedCardIds.size === 0 || bulkStarring) return
    const ids = [...selectedCardIds]
    const next = cards.some(c => selectedCardIds.has(c.id) && !c.starred)
    setBulkStarring(true)
    try {
      const repo = new SupabaseCardRepository()
      for (const id of ids) await repo.setStarred(id, next)
      setCards(prev => prev.map(c => selectedCardIds.has(c.id) ? { ...c, starred: next } : c))
      setSelectedCardIds(new Set())
    } catch (err) {
      console.error('Bulk star failed:', err)
    } finally {
      setBulkStarring(false)
    }
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
            typingMistakeStreak:    0,
            typingFailCycles:       0,
            stage3EnteredDate:      null,
          }
          return stateRepo.upsert(learning)
        })
      )
      setStates(prev => {
        const keyOf = (s: CardState) => `${s.cardId}:${s.reviewDirection ?? 'forward'}`
        const map = new Map(prev.map(s => [keyOf(s), s]))
        for (const s of updates) map.set(keyOf(s), s)
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
    setBulkGraduateError(null)
    try {
      const stateRepo    = new SupabaseCardStateRepository()
      const pipelineRepo = new SupabasePipelineRepository()
      const defaultPipeline = await pipelineRepo.getDefault()
      const now    = new Date()
      const nowIso = now.toISOString()
      // Filter to card IDs still present in the deck — ghost IDs (selected
      // then deleted) would violate the card_states → cards FK and fail the
      // whole batch.
      const existingCardIds = new Set(cards.map(c => c.id))
      const cardIds = [...selectedCardIds].filter(id => existingCardIds.has(id))
      if (cardIds.length === 0) { setBulkGraduateError('No valid cards to graduate.'); return }

      // Both paths spread due dates across a 14-day window so a large batch
      // doesn't pile up on one day. The accelerated path puts cards on the
      // accelerated-multiplier track (import_known); the default path marks
      // them bulk_known — "I already knew these" — so they use normal
      // scheduling and never count toward daily goals.
      const dueDates = await batchFastTrackDueDates(userId, cardIds.length, now, stateRepo)
      const updates: CardState[] = cardIds.map((cardId, i) => {
        const dueAt = dueDates[i] ?? nowIso
        const base  = fastTrackCardState(userId, cardId, defaultPipeline.id, dueAt, now)
        if (bulkAccelerated) return base
        return {
          ...base,
          acceleratedMode:        'bulk_known',
          acceleratedLocked:      false,
          acceleratedWrongStreak: 0,
          acceleratedPenalty:     0,
        }
      })
      await stateRepo.upsertBatch(updates)
      setStates(prev => {
        // Key by (cardId, reviewDirection) so a card's reverse-direction row
        // isn't collapsed into its forward row (which would drop the forward
        // state and make the card look unlearned until refresh).
        const keyOf = (s: CardState) => `${s.cardId}:${s.reviewDirection ?? 'forward'}`
        const map = new Map(prev.map(s => [keyOf(s), s]))
        for (const s of updates) map.set(keyOf(s), s)
        return [...map.values()]
      })
      setSelectedCardIds(new Set())
    } catch (err) {
      console.error('Bulk graduate failed:', err)
      setBulkGraduateError(err instanceof Error ? err.message : String(err))
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
        // Also clear ladder climb progress so the cards return to Unlearned.
        await supabase.from('ladder_climb').delete().in('card_id', ids).eq('user_id', userId)
        setStates(prev => prev.filter(s => !selectedCardIds.has(s.cardId)))
        setClimb(prev => { const m = new Map(prev); ids.forEach(id => m.delete(id)); return m })
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
  const stateMap       = forwardStateMap(forwardStates)
  // Turnover-aware "today": a card due on today's calendar date (in the user's timezone, adjusted for
  // the day-turnover hour) is due; nothing later counts. Fed to the shared due-now helper below.
  const todayStr = getToday(tz, turnoverHour)

  const synonymCandidates: SynonymCandidate[] = cards
    .filter(c => !c.synonymGroupId)
    .flatMap(c => {
      const segs = detectSynonymSplit(c.front)
      return segs ? [{ card: c, segments: segs, split: true }] : []
    })
  const activeCardIds       = new Set(cards.map(c => c.id))
  // A card's phase, combining long-term review state with LADDER climb progress:
  // past the first rung (rungIndex ≥ 1) and not graduated → Learning.
  const statusOf = (cardId: string): 'graduated' | 'dormant' | 'learning' | 'new' => {
    const s = stateMap.get(cardId)
    if (s?.dormant) return 'dormant'
    if (s?.graduated) return 'graduated'
    const cl = climb.get(cardId)
    if ((cl && cl.rungIndex >= 1 && !cl.graduated) || (s && !s.graduated)) return 'learning'
    return 'new'
  }
  const unlearned = cards.filter(c => statusOf(c.id) === 'new').length
  const learning  = cards.filter(c => statusOf(c.id) === 'learning').length
  const graduated = cards.filter(c => statusOf(c.id) === 'graduated').length
  const dormant   = cards.filter(c => statusOf(c.id) === 'dormant').length
  // Due Now via the shared helper (same definition as the dashboard/session): date-level, real
  // per-track columns (smart→typed→due_at, recall_due_at), track-filtered, dormancy + reverse aware.
  // Previously this read only `s.dueAt` with no track filter, so it over-counted vs everywhere else.
  const dueStates = states.filter(s =>
    activeCardIds.has(s.cardId) &&
    isCardStateDueNow(s, { tracks: enabledTracks, tz, today: todayStr, forwardState: stateMap.get(s.cardId) })
  )
  const dueNow      = dueStates.length
  const dueCardIds  = new Set(dueStates.map(s => s.cardId))   // cards with ANY due review (incl. reverse)

  const visibleCards = cards.filter(card => {
    if (!activeFilter) return true
    if (activeFilter === 'new')       return statusOf(card.id) === 'new'
    if (activeFilter === 'learning')  return statusOf(card.id) === 'learning'
    if (activeFilter === 'graduated') return statusOf(card.id) === 'graduated'
    if (activeFilter === 'dormant')   return statusOf(card.id) === 'dormant'
    if (activeFilter === 'starred')   return !!card.starred
    if (activeFilter === 'due')       return dueCardIds.has(card.id)   // forward OR reverse due — matches the count
    return true
  })
  const allVisibleSelected = visibleCards.length > 0 && visibleCards.every(c => selectedCardIds.has(c.id))

  const prefRepo    = new SupabaseDeckPreferencesRepository()
  const rawLimit    = prefs ? prefRepo.effectiveDailyLimit(prefs) : defaultLimit
  const activeLimit = Math.min(rawLimit, cards.length)

  return (
    <div className="space-y-8">
      {deletedCardUndo && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-surface-raised border border-line/10 rounded-card shadow-lg px-4 py-3 text-sm">
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
          // Only never-studied cards may be onboarded: rating one writes a fresh graduated state, which
          // would wipe the real review history (reps, lapses, tuned difficulty/stability) of a card
          // that has actually been studied.
          onboardableIds={cards.filter(c => !stateMap.get(c.id) && !onboardedIds.has(c.id)).map(c => c.id)}
          pendingOnboarding={pendingOnboarding}
          onClose={() => { setShowGear(false); loadAll(userId) }}
        />
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <Link
            href={parentFolder
              ? routes.library(parentFolder.id, { source: deck.sourceLanguage, target: deck.targetLanguage })
              // No folder → back to THIS language's library (the pair view), not the all-languages root.
              : `/library?source=${encodeURIComponent(deck.sourceLanguage)}&target=${encodeURIComponent(deck.targetLanguage)}`}
            className="text-xs text-ink-muted hover:text-ink mb-2 inline-block"
          >
            ← {parentFolder ? parentFolder.name : langName(deck.sourceLanguage)}
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
            className="p-2.5 rounded-lg border border-line/10 hover:border-line/20 text-ink-muted hover:text-ink transition-colors"
            title="Study settings">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <Link href={routes.deckAdd(deckId)}     className="btn-ghost text-sm">Add cards</Link>
          <Link href={routes.deckEdit(deckId)}    className="btn-ghost text-sm">Edit</Link>
          <Link href={routes.ladderDeck(deckId)}  className="btn-primary text-sm">Study</Link>
        </div>
      </div>

      {pendingOnboarding > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
          <span className="text-ink">
            <span className="font-medium">{`${pendingOnboarding} word${pendingOnboarding !== 1 ? 's' : ''}`}</span>
            {pendingOnboarding !== 1
              ? ' in this deck haven’t been rated yet — they won’t be scheduled until you do.'
              : ' in this deck hasn’t been rated yet — it won’t be scheduled until you do.'}
          </span>
          <Link href={routes.deckOnboard(deckId)} className="btn-primary text-xs px-3 py-1.5">
            Finish onboarding
          </Link>
        </div>
      )}

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

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Unlearned', value: unlearned, color: 'text-ink-muted',   border: 'border-ink-faint', filter: 'new',       desc: 'Not yet started'  },
          { label: 'Learning',  value: learning,  color: 'text-warning',     border: 'border-warning',   filter: 'learning',  desc: 'In pipeline'      },
          { label: 'Graduated', value: graduated, color: 'text-success',     border: 'border-success',   filter: 'graduated', desc: 'Long-term review' },
          { label: 'Due Now',   value: dueNow,    color: 'text-accent-soft', border: 'border-accent',    filter: 'due',       desc: 'Ready to review'  },
          { label: 'Dormant',   value: dormant,   color: 'text-ink',         border: 'border-line/70',  filter: 'dormant',   desc: 'Paused — manual'  },
        ].map(({ label, value, color, border, filter, desc }) => {
          const isActive = activeFilter === filter
          return (
            <Link
              key={label}
              href={isActive ? routes.deck(deckId) : routes.deck(deckId, { filter })}
              className={`panel border-t-2 ${border} text-center transition-colors w-full block space-y-1
                ${isActive ? 'bg-surface-raised ring-1 ring-ink/10' : 'hover:bg-surface-raised/50'}`}
            >
              <div className={`text-2xl font-semibold ${color}`}>{value}</div>
              <div className="text-xs font-medium text-ink">{label}</div>
              <div className="text-xs text-ink-faint">{desc}</div>
            </Link>
          )
        })}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Cards</h2>
          <div className="flex items-center gap-2">
            {activeFilter && (
              <Link href={routes.deck(deckId)} className="text-xs text-accent hover:text-accent-soft transition-colors">
                Show all ✕
              </Link>
            )}
            {/* Starred is a card flag, not a graduation state, so it filters from here rather than
                sitting in the stat-box row alongside the states that partition the deck. */}
            <StarFilterButton active={activeFilter === 'starred'}
              onToggle={() => router.push(activeFilter === 'starred'
                ? routes.deck(deckId)
                : routes.deck(deckId, { filter: 'starred' }))} />
          </div>
        </div>

        {activeFilter && (() => {
          const filterCount = activeFilter === 'new' ? unlearned : activeFilter === 'learning' ? learning : activeFilter === 'graduated' ? graduated : activeFilter === 'dormant' ? dormant : dueNow
          const filterLabel = activeFilter === 'new' ? 'Unlearned' : activeFilter === 'learning' ? 'Learning' : activeFilter === 'graduated' ? 'Graduated' : activeFilter === 'dormant' ? 'Dormant' : 'Due Now'
          // Learning-phase categories climb the ladder; post-graduation ones
          // (graduated / due / dormant) stay on the long-term review flow.
          const isLearningPhase = activeFilter === 'new' || activeFilter === 'learning'
          const studyHref = isLearningPhase
            ? routes.ladderDeck(deckId, { category: activeFilter })
            : routes.deckSession(deckId, { category: activeFilter })
          return filterCount > 0 ? (
            <Link
              href={studyHref}
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
                      className="text-xs px-3 py-1 rounded border border-line/10 hover:border-line/20 text-ink-muted hover:text-ink transition-colors"
                    >
                      {bulkResetting ? 'Resetting…' : 'Reset ▾'}
                    </button>
                    {showBulkResetMenu && (
                      <div className="absolute right-0 top-full mt-1 z-50 bg-surface-raised border border-line/10 rounded-card shadow-lg py-1 min-w-[200px]">
                        {([
                          ['distractors', 'Reset distractors',  'Clears cached multiple-choice options.'],
                          ['progress',    'Reset progress',     'Erases reps, lapses, schedule.'],
                          ['audio',       'Reset audio',        'Clears cached audio.'],
                          ['all',         'Reset entirely',     'Resets progress, distractors, and audio.'],
                        ] as const).map(([action, label, desc]) => (
                          <button
                            key={action}
                            onClick={() => handleBulkReset(action)}
                            className={`w-full text-left px-3 py-2 hover:bg-line/5 transition-colors ${action === 'all' ? 'text-danger' : 'text-ink'}`}
                          >
                            <span className="block text-sm">{label}</span>
                            <span className="block text-xs text-ink-faint">{desc}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={handleBulkStar}
                    disabled={bulkStarring}
                    className="text-xs px-3 py-1 rounded border border-warning/30 text-warning hover:bg-warning/10 transition-colors disabled:opacity-40"
                  >
                    {bulkStarring
                      ? 'Starring…'
                      : cards.some(c => selectedCardIds.has(c.id) && !c.starred) ? '★ Star' : '★ Unstar'}
                  </button>
                  <button
                    onClick={handleBulkMoveToLearning}
                    disabled={bulkMovingToLearning}
                    className="text-xs px-3 py-1 rounded border border-line/10 hover:border-line/20 text-ink-muted hover:text-ink transition-colors disabled:opacity-40"
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
            {bulkGraduateError && (
              <p className="text-xs text-danger break-words">Graduation failed: {bulkGraduateError}</p>
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

        <div className="panel divide-y divide-line/5 p-0 overflow-hidden">
          {visibleCards.map(card => {
            const s = stateMap.get(card.id)
            const phase = statusOf(card.id)
            const cl = climb.get(card.id)
            // Every learning card is on a rung — a card is never labeled a bare "Learning" (that caused
            // inconsistent behavior between the two labels). No climb row yet ⇒ it's at the start (Rung 1).
            const status = phase === 'graduated' ? 'Graduated' : phase === 'dormant' ? 'Dormant'
              : phase === 'learning' ? `Rung ${(cl && !cl.graduated ? cl.rungIndex : 0) + 1}` : 'New'
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
          className="w-full border border-dashed border-line/15 hover:border-accent/40 hover:bg-surface/30
                     rounded-card text-ink-faint hover:text-ink transition-colors text-sm py-4 text-center"
        >
          + New card
        </button>
      </div>
    </div>
  )
}
