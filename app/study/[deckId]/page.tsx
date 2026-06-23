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
import type { Deck, Card, CardState, CardConfusion, DeckPreferences, Folder, LanguagePair, LanguageSyncRule, SyncedCardLink } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'
import { prefetchChoices, type PrefetchItem } from '@/lib/distractors'
import { langName } from '@/lib/languages'
import { classifyReviewMode } from '@/engine/scheduler'
import { initialCardState } from '@/engine/pipeline'

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

function CardEditModal({ card, state, userId, deckId, deckCards, sourceLanguage, targetLanguage, onSave, onCardChange, onStateChange, onClose, onJumpToCard, onSyncCard }: {
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
}) {
  const [front,   setFront]   = useState(card.front)
  const [back,    setBack]    = useState(card.back)
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [validErr, setValidErr] = useState<string | null>(null)
  const [showStats, setShowStats] = useState(false)
  const [showResetMenu, setShowResetMenu] = useState(false)
  const [resetAction, setResetAction] = useState<'distractors' | 'progress' | 'all' | null>(null)
  const [resetting,   setResetting]   = useState(false)
  const [resetError,  setResetError]  = useState<string | null>(null)
  const [resetDone,   setResetDone]   = useState<string | null>(null)
  const [confusions,  setConfusions]  = useState<CardConfusion[]>([])
  const frontRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { frontRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    new SupabaseCardConfusionRepository().listForCard(userId, card.id)
      .then(rows => { if (!cancelled) setConfusions(rows) })
      .catch(err => console.error('Failed to load card confusions:', err))
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
      setResetDone(
        resetAction === 'distractors' ? 'Distractors reset — new ones are being generated.'
        : resetAction === 'progress'  ? 'Progress reset.'
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="panel w-full max-w-lg space-y-4 mx-4">
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
                  <button
                    onClick={() => { setShowResetMenu(false); setResetAction('all') }}
                    className="w-full text-left px-3 py-2 hover:bg-white/5 text-danger"
                  >
                    Reset entirely
                    <span className="block text-xs text-ink-faint">Resets both progress and distractors.</span>
                  </button>
                </div>
              )}
            </div>
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
                  : 'Reset this card entirely — clears study progress AND cached distractors? This can\'t be undone.'
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

        {showStats && (
          <div className="rounded-card border border-white/5 bg-surface-raised/50 p-4 space-y-4 text-sm max-h-80 overflow-y-auto">
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

              return (
                <>
                  <StatGroup title="Status" rows={[
                    ['Status',        status],
                    ['Review mode',   reviewModeLabel],
                    ['Reps',          String(state.reps)],
                    ['Lapses',        String(state.lapses)],
                    ['Ease',          state.ease.toFixed(2)],
                    ['Last rating',   rating ? rating.charAt(0).toUpperCase() + rating.slice(1) : '—'],
                  ]} />

                  <StatGroup title="Scheduling" rows={[
                    ['Interval (ideal)',    formatIntervalDays(state.intervalDays)],
                    ['Scheduled interval',  formatIntervalDays(state.scheduledIntervalDays)],
                    ['Next due',            state.graduated ? formatDate(state.dueAt) : '—'],
                    ['Last reviewed',       formatDate(state.lastReviewedAt, 'Never')],
                    ['Introduced',          formatDate(state.introducedDate, 'Not yet')],
                    ['Graduated at',        formatDate(state.graduatedAt, '—')],
                  ]} />

                  <StatGroup title="Lapses & relearning" rows={[
                    ['Recent lapses (cluster)', String(state.lapseClusterCount)],
                    ['Last lapse',              formatDate(state.lastLapseAt, '—')],
                    ['Relearn step',            relearnLabel],
                    ['Pending interval',        state.pendingIntervalDays != null
                      ? `${formatIntervalDays(state.pendingIntervalDays)} (on recovery)`
                      : '—'],
                  ]} />

                  <StatGroup title="Typed production" rows={[
                    ['Typed reviews',          String(state.typedReviewCount)],
                    ['Typed accuracy (recent)', typedAccuracy],
                    ['Last typed review',      formatDate(state.lastTypedReviewAt, 'Never')],
                    ['Forced typed remaining', String(state.forcedTypedRemaining)],
                  ]} />

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
            {card.syncedFromLanguage && (
              <div className="space-y-2">
                <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                  Sync origin
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-faint">Synced from</span>
                    <span className="text-xs text-ink font-medium">{langName(card.syncedFromLanguage)}</span>
                  </div>
                  {card.originWord && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-ink-faint">Origin word</span>
                      <span className="text-xs text-ink font-medium">{card.originWord}</span>
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
                <div className="space-y-2.5">
                  {card.choices.back.length > 0 && (
                    <div>
                      <div className="text-[10px] text-ink-faint mb-1">
                        Prompt {langName(sourceLanguage)} → pick {langName(targetLanguage)}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {card.choices.back.map(d => <span key={d} className="chip">{d}</span>)}
                      </div>
                    </div>
                  )}
                  {card.choices.front.length > 0 && (
                    <div>
                      <div className="text-[10px] text-ink-faint mb-1">
                        Prompt {langName(targetLanguage)} → pick {langName(sourceLanguage)}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {card.choices.front.map(d => <span key={d} className="chip">{d}</span>)}
                      </div>
                    </div>
                  )}
                  {(card.choices.backSynonyms?.length ?? 0) > 0 && (
                    <div>
                      <div className="text-[10px] text-ink-faint mb-1">
                        {langName(targetLanguage)} synonyms (accepted as correct)
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {card.choices.backSynonyms!.map(s => <span key={s} className="chip text-success/80">{s}</span>)}
                      </div>
                    </div>
                  )}
                  {(card.choices.frontSynonyms?.length ?? 0) > 0 && (
                    <div>
                      <div className="text-[10px] text-ink-faint mb-1">
                        {langName(sourceLanguage)} synonyms (accepted as correct)
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {card.choices.frontSynonyms!.map(s => <span key={s} className="chip text-success/80">{s}</span>)}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-ink-faint text-xs italic">Not yet generated — will be created during your next study session.</p>
              )}
            </div>

            {confusions.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold border-b border-white/5 pb-1">
                  Often confused with
                </div>
                <div className="space-y-1.5">
                  {confusions.map(c => {
                    const linked = c.confusedWithCardId ? deckCards.find(d => d.id === c.confusedWithCardId) : undefined
                    return (
                      <div key={c.confusedText} className="flex items-center justify-between gap-2">
                        <div className="min-w-0 text-sm">
                          <span className="text-ink font-medium break-words">{c.confusedText}</span>
                          {linked && <span className="text-ink-faint"> — {linked.back}</span>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="chip">{c.count}×</span>
                          {linked && onJumpToCard && (
                            <button onClick={() => onJumpToCard(linked.id)} className="text-xs text-accent hover:text-accent-soft transition-colors">
                              Open
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
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
            confirmExisting: false, deckId: '',
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
              confirmExisting: false, deckId: '',
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
          confirmExisting: false, deckId: '',
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

  const pendingRows = rows.filter(r => r.uiStatus === 'pending' || r.uiStatus === 'already_active')
  const allDone     = rows.length > 0 && rows.every(r => ['approved', 'dismissed', 'already_active', 'error'].includes(r.uiStatus))

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
            row.uiStatus === 'approved'      ? 'border-success/30 bg-success/5' :
            row.uiStatus === 'dismissed'     ? 'border-white/5 opacity-50' :
            row.uiStatus === 'already_active' ? 'border-accent/20 bg-accent/5' :
            row.uiStatus === 'error'         ? 'border-danger/30 bg-danger/5' :
            'border-white/10'
          }`}>
            {/* Row header — dest pair + status badge */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted uppercase tracking-wider">
                {langName(row.destPair.sourceLanguage)} → {langName(row.destPair.targetLanguage)}
              </span>
              {row.uiStatus === 'already_active' && (
                <span className="text-xs text-accent bg-accent/10 px-2 py-0.5 rounded-full">Already synced</span>
              )}
              {row.uiStatus === 'approved' && (
                <span className="text-xs text-success bg-success/10 px-2 py-0.5 rounded-full">✓ Approved</span>
              )}
              {row.uiStatus === 'dismissed' && (
                <span className="text-xs text-ink-faint px-2 py-0.5">Dismissed</span>
              )}
            </div>

            {/* Generated card preview */}
            {row.uiStatus !== 'dismissed' && (
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
                      <p className="font-medium text-ink">{row.generatedFront}</p>
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-xs text-ink-faint">{langName(row.destPair.targetLanguage)}</p>
                      <p className="text-ink-muted">{row.generatedBack}</p>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Confidence / warning */}
            {row.warning && row.uiStatus !== 'dismissed' && (
              <p className="text-xs text-warning/80">⚠ {row.warning}</p>
            )}

            {/* Existing card notice */}
            {row.existingCard && row.uiStatus === 'pending' && !row.editMode && (
              <p className="text-xs text-accent/80 bg-accent/5 border border-accent/20 rounded px-2 py-1.5">
                Existing card found: <span className="font-mono">{row.existingCard.front}</span>
                {' = '}<span className="font-mono">{row.existingCard.back}</span>
                {' — approving will link to this card.'}
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

            {/* Action buttons */}
            {(row.uiStatus === 'pending' || row.uiStatus === 'approving') && (
              <div className="flex gap-2">
                <button
                  className="btn-primary text-sm py-1.5 px-4"
                  disabled={row.uiStatus === 'approving' || (row.editMode && row.existingCard !== null && !row.confirmExisting)}
                  onClick={() => handleApprove(idx)}
                >
                  {row.uiStatus === 'approving' ? 'Saving…' : row.existingCard && !row.editMode ? 'Approve (link existing)' : 'Approve'}
                </button>
                {!row.editMode && (
                  <button
                    className="btn-ghost text-sm py-1.5 px-3"
                    disabled={row.uiStatus === 'approving'}
                    onClick={() => updateRow(idx, { editMode: true })}
                  >
                    Edit
                  </button>
                )}
                {row.editMode && (
                  <button
                    className="btn-ghost text-sm py-1.5 px-3"
                    disabled={row.uiStatus === 'approving'}
                    onClick={() => updateRow(idx, { editMode: false, editFront: row.generatedFront, editBack: row.generatedBack, confirmExisting: false })}
                  >
                    Cancel edit
                  </button>
                )}
                <button
                  className="btn-ghost text-sm py-1.5 px-3 text-ink-faint"
                  disabled={row.uiStatus === 'approving'}
                  onClick={() => handleDismiss(idx)}
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        ))}

        {/* Footer */}
        <div className="flex justify-end pt-1">
          <button className="btn-ghost" onClick={onClose}>
            {allDone ? 'Close' : 'Cancel'}
          </button>
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
  const [aiInstructions,       setAiInstructions]       = useState(gs.aiGradingInstructions ?? '')

  const [dailyLimit,        setDailyLimit]        = useState(Math.min(initialPrefs?.dailyNewCards ?? defaultLimit, maxCards))
  const [onlyToday,         setOnlyToday]         = useState(false)
  const [todayOverride,     setTodayOverride]     = useState(initialPrefs?.dailyOverride ?? defaultLimit)
  const [spillover,         setSpillover]         = useState(initialPrefs?.spilloverDue  ?? defaultSpillover)
  const [cardsPerSessionOn, setCardsPerSessionOn] = useState((initialPrefs?.cardsPerSession ?? 0) > 0)
  const [cardsPerSession,   setCardsPerSession]   = useState(initialPrefs?.cardsPerSession || 20)
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

            {/* Cards per session (batch mode) — also controls elective/study-ahead cap */}
            <div className="space-y-2 border-t border-white/10 pt-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={cardsPerSessionOn} onChange={e => setCardsPerSessionOn(e.target.checked)} className="accent-accent w-4 h-4" />
                <span className="text-sm text-ink">Study in fixed-size batches</span>
              </label>
              {cardsPerSessionOn && (
                <div className="space-y-1.5 pl-6">
                  <label className="text-sm text-ink-muted">Cards per session</label>
                  <input type="number" min={1} max={500} className="input"
                    value={cardsPerSession}
                    onChange={e => setCardsPerSession(Math.min(maxCards, Math.max(1, parseInt(e.target.value) || 1)))} />
                  <p className="text-xs text-ink-faint">
                    Keeps {cardsPerSession} new card{cardsPerSession !== 1 ? 's' : ''} in the learning pipeline at a time.
                    Once a card graduates, the next session introduces another to take its place.
                    Also caps study-ahead and elective sessions to {cardsPerSession} cards per batch.
                    Overrides the daily limit above.
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
                  <div className="space-y-1">
                    <p className="text-xs text-ink-faint">Slash alternatives (e.g. "a / b")</p>
                    <select value={slashMode} onChange={e => setSlashMode(e.target.value as 'accept_any' | 'require_all')} className="input text-sm">
                      <option value="accept_any">Accept any</option>
                      <option value="require_all">Require all</option>
                    </select>
                  </div>
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
  const [showGear,         setShowGear]         = useState(false)
  const [editingCard,      setEditingCard]      = useState<Card | null>(null)
  const [syncingCard,      setSyncingCard]      = useState<Card | null>(null)
  const [addingCard,       setAddingCard]       = useState(false)
  const [showSynonymScan,  setShowSynonymScan]  = useState(false)
  const [synonymScanIgnored, setSynonymScanIgnored] = useState(() =>
    typeof window !== 'undefined' && !!localStorage.getItem(`syn_scan_ignored_${deckId}`)
  )
  const searchParams = useSearchParams()
  const activeFilter = searchParams.get('filter') as 'new' | 'learning' | 'graduated' | 'due' | null

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

  async function handleNewCardSave(front: string, back: string) {
    if (!deck) return
    const cardRepo = new SupabaseCardRepository()
    const created  = await cardRepo.bulkCreate(deckId, userId, deck.sourceLanguage, deck.targetLanguage, [{ front, back, position: cards.length }])
    if (created[0]) setCards(prev => [...prev, created[0]!])
  }

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>
  if (!deck)   return null

  const stateMap  = new Map(states.map(s => [s.cardId, s]))
  const now       = new Date()

  const synonymCandidates: SynonymCandidate[] = cards
    .filter(c => !c.synonymGroupId)
    .flatMap(c => {
      const segs = detectSynonymSplit(c.front)
      return segs ? [{ card: c, segments: segs, split: true }] : []
    })
  const unlearned = cards.filter(c => !stateMap.has(c.id)).length
  const learning  = states.filter(s => !s.graduated).length
  const graduated = states.filter(s => s.graduated).length
  const dueNow    = states.filter(s => s.graduated && s.dueAt && new Date(s.dueAt) <= now).length

  const prefRepo    = new SupabaseDeckPreferencesRepository()
  const rawLimit    = prefs ? prefRepo.effectiveDailyLimit(prefs) : defaultLimit
  const activeLimit = Math.min(rawLimit, cards.length)

  return (
    <div className="space-y-8">
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
          onJumpToCard={cardId => {
            const target = cards.find(c => c.id === cardId)
            if (target) setEditingCard(target)
          }}
          onSyncCard={() => setSyncingCard(editingCard)}
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

      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href={parentFolder
              ? `/library/${parentFolder.id}?source=${deck.sourceLanguage}&target=${deck.targetLanguage}`
              : '/library'}
            className="text-xs text-ink-muted hover:text-ink mb-2 inline-block"
          >
            ← {parentFolder ? parentFolder.name : 'Library'}
          </Link>
          <h1 className="text-2xl font-semibold text-ink">{deck.name}</h1>
          <p className="text-ink-muted text-sm mt-1">
            {cards.length} cards · {deck.targetLanguage.toUpperCase()} · {activeLimit} new/day
            {(prefs?.spilloverDue ?? defaultSpillover) && <span className="text-warning ml-1">· spillover on</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setShowGear(true)}
            className="p-2.5 rounded-lg border border-white/10 hover:border-white/20 text-ink-muted hover:text-ink transition-colors"
            title="Study settings">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <Link href={`/study/${deckId}/add`}     className="btn-ghost">Add cards</Link>
          <Link href={`/study/${deckId}/edit`}    className="btn-ghost">Edit</Link>
          <Link href={`/study/${deckId}/session`} className="btn-primary">Study</Link>
        </div>
      </div>

      {synonymCandidates.length > 0 && !synonymScanIgnored && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
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

        <div className="panel divide-y divide-white/5 p-0 overflow-hidden">
          {cards.filter(card => {
            if (!activeFilter) return true
            const s = stateMap.get(card.id)
            if (activeFilter === 'new')       return !s
            if (activeFilter === 'learning')  return s && !s.graduated
            if (activeFilter === 'graduated') return s?.graduated
            if (activeFilter === 'due')       return s?.graduated && s.dueAt && new Date(s.dueAt) <= now
            return true
          }).map(card => {
            const s = stateMap.get(card.id)
            const status = !s ? 'New' : s.graduated ? 'Graduated' : `Step ${s.currentStepOrder + 1}`
            return (
              <div
                key={card.id}
                onClick={() => setEditingCard(card)}
                className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-surface-raised/50 transition-colors group"
              >
                <div className="flex gap-6 text-sm min-w-0">
                  <span className="text-ink font-medium w-40 truncate shrink-0">{card.front}</span>
                  <span className="text-ink-muted truncate">{card.back}</span>
                </div>
                <span className="chip shrink-0 ml-2">{status}</span>
              </div>
            )
          })}
          {cards.filter(card => {
            if (!activeFilter) return false
            const s = stateMap.get(card.id)
            if (activeFilter === 'new')       return !s
            if (activeFilter === 'learning')  return s && !s.graduated
            if (activeFilter === 'graduated') return s?.graduated
            if (activeFilter === 'due')       return s?.graduated && s.dueAt && new Date(s.dueAt) <= now
            return false
          }).length === 0 && activeFilter && (
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
