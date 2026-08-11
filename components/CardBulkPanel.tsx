'use client'

/**
 * components/CardBulkPanel.tsx — the "N cards selected" action bar, shared by every card list.
 *
 * One implementation of the bulk operations (reset / star / move to learning / dormant / delete /
 * graduate) so the deck page and the stat-box filter lists on the Library, folder, and Study pages
 * all offer the same panel. The panel OWNS the writes; it does not own any page's local state —
 * after an operation it reports what happened through `onApplied`, and the page either patches its
 * copy (deck page) or just refetches (the cross-deck lists).
 *
 * Graduation semantics are the deck page's, unchanged: due dates spread across 14 days either way
 * ([[project_fast_track_spreading]] — never the old dynamic formula); the accelerated checkbox picks
 * the import_known track, default is bulk_known ("I already knew these", excluded from daily goals).
 *
 * "Make dormant" pauses BOTH directions in one write (`setDormancy(..., 'all')`), matching the
 * card editor's "Make dormant now". A card with no state row yet can't be paused — dormancy lives
 * on card_states — so those are skipped and the button reports how many it could touch.
 */

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { invalidateReads } from '@/lib/readCache'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabasePipelineRepository } from '@/lib/data/pipelines'
import { initialCardState, fastTrackCardState } from '@/engine/pipeline'
import { batchFastTrackDueDates } from '@/engine/density'
import type { Card, CardState } from '@/domain'

export type BulkResetAction = 'distractors' | 'progress' | 'audio' | 'all'

/** What a completed operation did — enough for a page to patch its local state without refetching. */
export type BulkChange =
  | { type: 'starred';   ids: string[]; value: boolean }
  | { type: 'learning';  states: CardState[] }
  | { type: 'graduated'; states: CardState[] }
  | { type: 'dormant';   ids: string[]; value: boolean }
  | { type: 'deleted';   ids: string[] }
  | { type: 'reset';     ids: string[]; action: BulkResetAction }

export function CardBulkPanel({ userId, cards, states, selectedIds, onClear, onApplied }: {
  userId:      string
  /** Every card the surrounding list can currently show — used to drop ghost selections. */
  cards:       Card[]
  /** State rows covering those cards (any direction). */
  states:      CardState[]
  selectedIds: Set<string>
  /** Clear the selection (the panel never mutates the page's selection state directly). */
  onClear:     () => void
  onApplied:   (change: BulkChange) => void
}) {
  const [busy,          setBusy]          = useState<string | null>(null)
  const [showResetMenu, setShowResetMenu] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [accelerated,   setAccelerated]   = useState(false)
  const [error,         setError]         = useState<string | null>(null)

  if (selectedIds.size === 0) return null

  const supabase = createClient()
  // Ghost IDs (selected, then deleted elsewhere) would violate FKs or error RPCs — always work on
  // the intersection with the cards the list still has.
  const existing = new Set(cards.map(c => c.id))
  const ids = [...selectedIds].filter(id => existing.has(id))
  const forwardOf = new Map(states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]))

  async function run(label: string, fn: () => Promise<BulkChange | null>) {
    if (busy) return
    setBusy(label); setError(null)
    try {
      const change = await fn()
      if (change) onApplied(change)
      onClear()
    } catch (err) {
      console.error(`Bulk ${label} failed:`, err)
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(null) }
  }

  const handleStar = () => {
    const next = cards.some(c => selectedIds.has(c.id) && !c.starred)
    void run('star', async () => {
      const repo = new SupabaseCardRepository()
      for (const id of ids) await repo.setStarred(id, next)
      return { type: 'starred', ids, value: next }
    })
  }

  const handleMoveToLearning = () => void run('learning', async () => {
    const stateRepo = new SupabaseCardStateRepository()
    const defaultPipeline = await new SupabasePipelineRepository().getDefault()
    const updates = await Promise.all(ids.map(cardId => {
      const base = forwardOf.get(cardId) ?? initialCardState(userId, cardId, defaultPipeline.id)
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
    }))
    return { type: 'learning', states: updates }
  })

  const handleGraduate = () => void run('graduate', async () => {
    if (ids.length === 0) throw new Error('No valid cards to graduate.')
    const stateRepo = new SupabaseCardStateRepository()
    const defaultPipeline = await new SupabasePipelineRepository().getDefault()
    const now = new Date()
    // Both paths spread due dates across a 14-day window so a large batch doesn't pile up on one
    // day. Accelerated = import_known multiplier track; default = bulk_known (normal scheduling,
    // never counts toward daily goals).
    const dueDates = await batchFastTrackDueDates(userId, ids.length, now, stateRepo)
    const updates: CardState[] = ids.map((cardId, i) => {
      const base = fastTrackCardState(userId, cardId, defaultPipeline.id, dueDates[i] ?? now.toISOString(), now)
      if (accelerated) return base
      return {
        ...base,
        acceleratedMode:        'bulk_known',
        acceleratedLocked:      false,
        acceleratedWrongStreak: 0,
        acceleratedPenalty:     0,
      }
    })
    await stateRepo.upsertBatch(updates)
    return { type: 'graduated', states: updates }
  })

  // Dormancy lives on card_states, so only cards that HAVE a row can be paused; the rest (not yet
  // started) are skipped. Adaptive like the star button: any selected non-dormant card → pause all,
  // otherwise wake all.
  const withState = ids.filter(id => forwardOf.has(id))
  const makingDormant = ids.some(id => forwardOf.get(id) && !forwardOf.get(id)!.dormant)
  const handleDormant = () => void run('dormant', async () => {
    if (withState.length === 0) throw new Error('None of the selected cards have been started — only started cards can go dormant.')
    const stateRepo = new SupabaseCardStateRepository()
    for (const id of withState) await stateRepo.setDormancy(userId, id, { dormant: makingDormant }, 'all')
    return { type: 'dormant', ids: withState, value: makingDormant }
  })

  const handleDelete = () => {
    setDeleteConfirm(false)
    void run('delete', async () => {
      const repo = new SupabaseCardRepository()
      await Promise.all(ids.map(id => repo.softDelete(id)))
      return { type: 'deleted', ids }
    })
  }

  const handleReset = (action: BulkResetAction) => {
    setShowResetMenu(false)
    void run('reset', async () => {
      if (action === 'distractors' || action === 'all') {
        await supabase.from('cards').update({ choices: null }).in('id', ids)
        invalidateReads('cards:')
      }
      if (action === 'progress' || action === 'all') {
        await supabase.from('card_states').delete().in('card_id', ids).eq('user_id', userId)
        // Also clear climb progress so the cards return to Unlearned. DIRECT writes — the repo-layer
        // 60s read cache must be busted or the next page resumes the cards mid-pipeline.
        await supabase.from('ladder_climb').delete().in('card_id', ids).eq('user_id', userId)
        invalidateReads('states:')
        invalidateReads('climb:')
      }
      if (action === 'audio' || action === 'all') {
        await supabase.from('cards').update({ audio_generated: false, audio_data: null }).in('id', ids)
        invalidateReads('cards:')
      }
      return { type: 'reset', ids, action }
    })
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-2 rounded-card border border-accent/30 bg-accent/5 text-sm">
      {deleteConfirm ? (
        <div className="flex items-center justify-between">
          <span className="text-ink-muted text-xs">Delete {selectedIds.size} card{selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setDeleteConfirm(false)} className="text-xs text-ink-faint hover:text-ink transition-colors">Cancel</button>
            <button onClick={handleDelete} disabled={busy === 'delete'} className="text-xs px-3 py-1 rounded bg-danger/80 hover:bg-danger text-white transition-colors">
              {busy === 'delete' ? 'Deleting…' : 'Yes, delete'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-ink-muted">{selectedIds.size} card{selectedIds.size !== 1 ? 's' : ''} selected</span>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={onClear} className="text-xs text-ink-faint hover:text-ink transition-colors">
              Clear
            </button>
            {/* Reset dropdown */}
            {showResetMenu && (
              <div className="fixed inset-0 z-40" onClick={() => setShowResetMenu(false)} />
            )}
            <div className="relative">
              <button
                onClick={() => setShowResetMenu(v => !v)}
                disabled={busy === 'reset'}
                className="text-xs px-3 py-1 rounded border border-line/10 hover:border-line/20 text-ink-muted hover:text-ink transition-colors"
              >
                {busy === 'reset' ? 'Resetting…' : 'Reset ▾'}
              </button>
              {showResetMenu && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-surface-raised border border-line/10 rounded-card shadow-lg py-1 min-w-[200px]">
                  {([
                    ['distractors', 'Reset distractors',  'Clears cached multiple-choice options.'],
                    ['progress',    'Reset progress',     'Erases reps, lapses, schedule.'],
                    ['audio',       'Reset audio',        'Clears cached audio.'],
                    ['all',         'Reset entirely',     'Resets progress, distractors, and audio.'],
                  ] as const).map(([action, label, desc]) => (
                    <button
                      key={action}
                      onClick={() => handleReset(action)}
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
              onClick={handleStar}
              disabled={busy === 'star'}
              className="text-xs px-3 py-1 rounded border border-warning/30 text-warning hover:bg-warning/10 transition-colors disabled:opacity-40"
            >
              {busy === 'star'
                ? 'Starring…'
                : cards.some(c => selectedIds.has(c.id) && !c.starred) ? '★ Star' : '★ Unstar'}
            </button>
            <button
              onClick={handleMoveToLearning}
              disabled={busy === 'learning'}
              className="text-xs px-3 py-1 rounded border border-line/10 hover:border-line/20 text-ink-muted hover:text-ink transition-colors disabled:opacity-40"
            >
              {busy === 'learning' ? 'Moving…' : 'Move to learning'}
            </button>
            <button
              onClick={handleDormant}
              disabled={busy === 'dormant'}
              title={withState.length < ids.length
                ? `${ids.length - withState.length} of the selected cards haven't been started and will be skipped — dormancy pauses existing progress.`
                : 'Pauses both directions; resume from the card editor or here.'}
              className="text-xs px-3 py-1 rounded border border-line/10 hover:border-line/20 text-ink-muted hover:text-ink transition-colors disabled:opacity-40"
            >
              {busy === 'dormant' ? 'Updating…' : makingDormant ? 'Make dormant' : 'Wake from dormant'}
            </button>
            <button
              onClick={() => setDeleteConfirm(true)}
              className="text-xs px-3 py-1 rounded border border-danger/30 text-danger hover:bg-danger/10 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={handleGraduate}
              disabled={busy === 'graduate'}
              className="btn-primary text-xs px-3 py-1"
            >
              {busy === 'graduate' ? 'Graduating…' : 'Graduate selected'}
            </button>
          </div>
        </div>
      )}
      {!deleteConfirm && (
        <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
          <input
            type="checkbox"
            checked={accelerated}
            onChange={e => setAccelerated(e.target.checked)}
            className="accent-accent w-3.5 h-3.5"
          />
          <span className="text-xs text-ink-muted">Accelerated track — spread due dates across 14 days</span>
        </label>
      )}
      {error && (
        <p className="text-xs text-danger break-words">{error}</p>
      )}
    </div>
  )
}
