'use client'

/**
 * components/create/OnboardSetup.tsx — everything that happens between "Onboard vocabulary" and the
 * first confidence rating.
 *
 * Three phases:
 *   1. checking — the AI accuracy pass (lib/onboardVerify.ts), batched with a progress readout.
 *   2. review   — every flagged card must be explicitly resolved (accept the fix / keep as is /
 *                 remove) before continuing. Onboarding schedules a card months out on the strength
 *                 of one self-rating, so a wrong gloss would go unnoticed for a long time.
 *   3. ready    — duplicates dropped, destination chosen, ready to rate.
 *
 * The duplicate drop is deliberately silent and non-negotiable: a word already in this pair's library
 * is never offered for rating, because rating it would create a second card for the same word with a
 * competing schedule. It matches on the FRONT alone — see lib/duplicates.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { partitionExistingFronts } from '@/lib/duplicates'
import { verifyOnboardingCards, type FlaggedCard } from '@/lib/onboardVerify'
import { buildFolderOptions, NEW_FOLDER_VALUE, ROOT_FOLDER_VALUE } from '@/lib/folderOptions'
import { langName } from '@/lib/languages'
import type { Card, Deck, Folder } from '@/domain'

export interface OnboardCard { front: string; back: string }

/** What the learner decided about a flagged card. `null` = still unresolved. */
type Resolution = 'accepted' | 'kept' | 'removed' | null

export interface OnboardDestination {
  folderId:      string | null
  newFolderName: string
  syncEnabled:   boolean
}

const ISSUE_LABEL: Record<FlaggedCard['issue'], string> = {
  mistranslation: 'Looks like a mistranslation',
  ambiguous:      'Gloss is ambiguous',
  language:       'Wrong language on one side',
}

export function OnboardSetup({
  cards, deckName, sourceLanguage, targetLanguage,
  folders, decks, hasSyncRules, saving, saveError, onCancel, onStart,
}: {
  cards:          OnboardCard[]
  deckName:       string
  sourceLanguage: string
  targetLanguage: string
  folders:        Folder[]
  decks:          Deck[]
  hasSyncRules:   boolean
  saving:         boolean
  saveError:      string | null
  onCancel:       () => void
  onStart:        (cards: OnboardCard[], destination: OnboardDestination) => void
}) {
  const [phase,     setPhase]     = useState<'checking' | 'review' | 'ready'>('checking')
  const [progress,  setProgress]  = useState<{ done: number; total: number }>({ done: 0, total: cards.length })
  const [checkError, setCheckError] = useState<string | null>(null)
  const [unchecked, setUnchecked] = useState(0)

  /** Working copy — accepted suggestions and manual edits are applied here. */
  const [items,       setItems]       = useState<OnboardCard[]>(cards)
  const [flagged,     setFlagged]     = useState<FlaggedCard[]>([])
  const [resolutions, setResolutions] = useState<Record<number, Resolution>>({})

  const [existingCards, setExistingCards] = useState<Card[] | null>(null)

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [creatingFolder,   setCreatingFolder]   = useState(false)
  const [newFolderName,    setNewFolderName]    = useState('')
  const [syncEnabled,      setSyncEnabled]      = useState(hasSyncRules)
  const [showSkipped,      setShowSkipped]      = useState(false)

  // React 18 StrictMode double-mounts in dev; without this the whole verification runs twice.
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    void (async () => {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()

      // The library read and the AI pass have no dependency on each other — run both at once so a
      // long verification isn't followed by a cold fetch.
      const libraryP = session
        ? new SupabaseCardRepository().listOwned(session.user.id, sourceLanguage, targetLanguage).catch(() => [] as Card[])
        : Promise.resolve([] as Card[])

      try {
        const run = await verifyOnboardingCards(cards, sourceLanguage, targetLanguage,
          (done, total) => setProgress({ done, total }))
        setFlagged(run.flagged)
        setUnchecked(run.uncheckedCount)
        setExistingCards(await libraryP)
        setPhase(run.flagged.length > 0 ? 'review' : 'ready')
      } catch {
        // A total failure shouldn't strand the learner — let them proceed unverified, knowingly.
        setCheckError('Could not check these cards for accuracy. You can continue and fix any bad cards later.')
        setExistingCards(await libraryP)
        setPhase('ready')
      }
    })()
  }, [cards, sourceLanguage, targetLanguage])

  const setResolution = useCallback((index: number, resolution: Resolution, patch?: Partial<OnboardCard>) => {
    setResolutions(prev => ({ ...prev, [index]: resolution }))
    if (patch) setItems(prev => prev.map((it, i) => i === index ? { ...it, ...patch } : it))
  }, [])

  function acceptAll() {
    const patched = [...items]
    const next: Record<number, Resolution> = { ...resolutions }
    for (const f of flagged) {
      if (resolutions[f.index]) continue           // don't override an explicit decision
      if (!f.suggestedFront && !f.suggestedBack) continue
      patched[f.index] = {
        front: f.suggestedFront ?? patched[f.index]!.front,
        back:  f.suggestedBack  ?? patched[f.index]!.back,
      }
      next[f.index] = 'accepted'
    }
    setItems(patched)
    setResolutions(next)
  }

  const unresolved = flagged.filter(f => !resolutions[f.index]).length
  const suggestable = flagged.filter(f => !resolutions[f.index] && (f.suggestedFront || f.suggestedBack)).length

  /** Everything not removed during review, in list order. */
  const kept = useMemo(
    () => items.filter((_, i) => resolutions[i] !== 'removed'),
    [items, resolutions],
  )

  const partition = useMemo(
    () => existingCards ? partitionExistingFronts(kept, existingCards, sourceLanguage) : null,
    [kept, existingCards, sourceLanguage],
  )

  const folderOptions = useMemo(
    () => buildFolderOptions(folders, decks, sourceLanguage, targetLanguage),
    [folders, decks, sourceLanguage, targetLanguage],
  )

  // ── Phase 1: checking ──────────────────────────────────────────────────────

  if (phase === 'checking') {
    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
    return (
      <div className="space-y-6 max-w-3xl mx-auto">
        <Header deckName={deckName} count={cards.length} />
        <div className="panel space-y-3">
          <p className="text-sm text-ink">Checking your cards for mistranslations…</p>
          <div className="h-2 rounded-full bg-surface overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-ink-faint">{progress.done} / {progress.total} checked</p>
        </div>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    )
  }

  // ── Phase 2: review the flagged cards ──────────────────────────────────────

  if (phase === 'review') {
    return (
      <div className="space-y-6 max-w-3xl mx-auto pb-12">
        <Header deckName={deckName} count={cards.length} />

        <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted">
          {flagged.length} card{flagged.length !== 1 ? 's' : ''} may be wrong. Fix or remove
          {flagged.length !== 1 ? ' them' : ' it'} before rating — an onboarded card can be scheduled
          months out, so a bad translation would go unnoticed for a long time.
        </div>

        {suggestable > 0 && (
          <button className="btn-ghost text-sm self-start" onClick={acceptAll}>
            Accept all {suggestable} suggested fix{suggestable !== 1 ? 'es' : ''}
          </button>
        )}

        <div className="space-y-3">
          {flagged.map(f => {
            const item = items[f.index]
            if (!item) return null
            const state = resolutions[f.index] ?? null
            return (
              <div key={f.index} className={`panel space-y-3 ${state === 'removed' ? 'opacity-50' : ''}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-warning">{ISSUE_LABEL[f.issue]}</span>
                  {state && (
                    <button className="text-xs text-ink-faint hover:text-ink transition-colors"
                      onClick={() => setResolution(f.index, null)}>
                      Undo
                    </button>
                  )}
                </div>
                {f.note && <p className="text-xs text-ink-muted">{f.note}</p>}

                <div className="grid grid-cols-2 gap-3">
                  <textarea
                    className="input resize-none min-h-[52px] text-sm font-medium"
                    value={item.front}
                    onChange={e => setResolution(f.index, 'accepted', { front: e.target.value })}
                  />
                  <textarea
                    className="input resize-none min-h-[52px] text-sm"
                    value={item.back}
                    onChange={e => setResolution(f.index, 'accepted', { back: e.target.value })}
                  />
                </div>

                {(f.suggestedFront || f.suggestedBack) && state !== 'accepted' && (
                  <p className="text-xs text-ink-muted">
                    Suggested: <span className="text-ink">{f.suggestedFront ?? item.front}</span>
                    {' / '}<span className="text-ink">{f.suggestedBack ?? item.back}</span>
                  </p>
                )}

                {!state && (
                  <div className="flex flex-wrap gap-3 text-sm">
                    {(f.suggestedFront || f.suggestedBack) && (
                      <button className="btn-ghost text-xs px-3 py-1"
                        onClick={() => setResolution(f.index, 'accepted', {
                          front: f.suggestedFront ?? item.front,
                          back:  f.suggestedBack  ?? item.back,
                        })}>
                        Use suggestion
                      </button>
                    )}
                    <button className="btn-ghost text-xs px-3 py-1" onClick={() => setResolution(f.index, 'kept')}>
                      Keep as is
                    </button>
                    <button className="btn-ghost text-xs px-3 py-1 text-danger/80 hover:text-danger"
                      onClick={() => setResolution(f.index, 'removed')}>
                      Remove card
                    </button>
                  </div>
                )}
                {state && (
                  <p className="text-xs text-ink-faint">
                    {state === 'accepted' ? 'Fixed' : state === 'kept' ? 'Kept as is' : 'Will not be onboarded'}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex gap-3">
          <button className="btn-primary" disabled={unresolved > 0} onClick={() => setPhase('ready')}>
            {unresolved > 0 ? `${unresolved} left to resolve` : 'Continue'}
          </button>
          <button className="btn-ghost" onClick={onCancel}>Back</button>
        </div>
      </div>
    )
  }

  // ── Phase 3: destination + start ───────────────────────────────────────────

  const fresh   = partition?.fresh   ?? []
  const skipped = partition?.skipped ?? []

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      <Header deckName={deckName} count={cards.length} />

      {checkError && (
        <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted">{checkError}</div>
      )}
      {unchecked > 0 && (
        <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted">
          {unchecked} card{unchecked !== 1 ? 's' : ''} couldn&apos;t be checked for accuracy — they&apos;ll be onboarded as written.
        </div>
      )}

      <div className="panel space-y-2">
        <p className="text-sm text-ink">
          <span className="font-medium">{fresh.length}</span> word{fresh.length !== 1 ? 's' : ''} to rate.
        </p>
        {skipped.length > 0 && (
          <>
            <p className="text-sm text-ink-muted">
              {skipped.length} skipped — already in your {langName(sourceLanguage)} library, so they keep the
              schedule they already have.
            </p>
            <button className="text-xs text-accent hover:text-accent-soft transition-colors"
              onClick={() => setShowSkipped(v => !v)}>
              {showSkipped ? 'Hide' : 'Show'} skipped words
            </button>
            {showSkipped && (
              <div className="max-h-56 overflow-y-auto space-y-1 pt-1">
                {skipped.map(({ candidate, existing }, i) => (
                  <div key={i} className="flex gap-4 text-xs">
                    <span className="text-ink w-1/2 truncate">{candidate.front}</span>
                    <span className="text-ink-faint w-1/2 truncate">already have &quot;{existing.front}&quot;</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="space-y-1.5 max-w-sm">
        <label className="text-sm text-ink-muted">Save to folder</label>
        <select
          className="input text-sm"
          value={creatingFolder ? NEW_FOLDER_VALUE : (selectedFolderId ?? ROOT_FOLDER_VALUE)}
          onChange={e => {
            const v = e.target.value
            if (v === NEW_FOLDER_VALUE) { setCreatingFolder(true); setNewFolderName('') }
            else { setCreatingFolder(false); setSelectedFolderId(v === ROOT_FOLDER_VALUE ? null : v) }
          }}
        >
          <option value={ROOT_FOLDER_VALUE}>{langName(sourceLanguage)} / {langName(targetLanguage)} — root</option>
          {folderOptions.map(({ folder, depth }) => (
            <option key={folder.id} value={folder.id}>{'  '.repeat(depth)}{folder.name}</option>
          ))}
          <option value={NEW_FOLDER_VALUE}>+ New folder…</option>
        </select>
        {creatingFolder && (
          <input autoFocus className="input text-sm" placeholder="New folder name…"
            value={newFolderName} onChange={e => setNewFolderName(e.target.value)} />
        )}
      </div>

      {hasSyncRules && (
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-ink-muted">
          <input type="checkbox" checked={syncEnabled} onChange={e => setSyncEnabled(e.target.checked)}
            className="accent-accent w-4 h-4" />
          Sync to other languages
        </label>
      )}

      {saveError && <p className="text-danger text-sm">{saveError}</p>}

      <div className="flex gap-3">
        <button
          className="btn-primary"
          disabled={fresh.length === 0 || saving || partition === null}
          onClick={() => onStart(fresh, {
            folderId: creatingFolder ? null : selectedFolderId,
            newFolderName: creatingFolder ? newFolderName.trim() : '',
            syncEnabled,
          })}
        >
          {saving ? 'Preparing…' : `Start rating (${fresh.length})`}
        </button>
        <button className="btn-ghost" disabled={saving} onClick={onCancel}>Back</button>
      </div>

      {fresh.length === 0 && partition !== null && (
        <p className="text-sm text-ink-muted">
          Every word on this list is already in your library — there&apos;s nothing to onboard.
        </p>
      )}
    </div>
  )
}

function Header({ deckName, count }: { deckName: string; count: number }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink">Onboard vocabulary</h1>
      <p className="text-ink-muted mt-1">
        {deckName || 'Untitled deck'} — {count} word{count !== 1 ? 's' : ''} submitted
      </p>
    </div>
  )
}
