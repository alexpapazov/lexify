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
import type { Deck, Card, CardState, DeckPreferences, Folder } from '@/domain'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'
import { prefetchChoices, type PrefetchItem } from '@/lib/distractors'
import { classifyReviewMode } from '@/engine/scheduler'

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

function CardEditModal({ card, state, onSave, onClose }: {
  card:    Card
  state:   CardState | undefined
  onSave:  (id: string, front: string, back: string) => Promise<void>
  onClose: () => void
}) {
  const [front,   setFront]   = useState(card.front)
  const [back,    setBack]    = useState(card.back)
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [validErr, setValidErr] = useState<string | null>(null)
  const [showStats, setShowStats] = useState(false)
  const frontRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { frontRef.current?.focus() }, [])

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="panel w-full max-w-lg space-y-4 mx-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Edit card</h2>
          <div className="flex items-center gap-2">
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

        <div className="flex gap-3">
          <button
            className="btn-primary flex-1"
            onClick={handleSave}
            disabled={saving}
          >
            {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save'}
          </button>
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

// ─── Gear settings panel ──────────────────────────────────────────────────────

function DeckSettingsPanel({ deckId, userId, initialPrefs, defaultLimit, defaultSpillover, maxCards, cards, sourceLanguage, targetLanguage, onClose }: {
  deckId:           string
  userId:           string
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

  const [dailyLimit,    setDailyLimit]    = useState(Math.min(initialPrefs?.dailyNewCards ?? defaultLimit, maxCards))
  const [onlyToday,     setOnlyToday]     = useState(false)
  const [todayOverride, setTodayOverride] = useState(initialPrefs?.dailyOverride     ?? defaultLimit)
  const [spillover,     setSpillover]     = useState(initialPrefs?.spilloverDue      ?? defaultSpillover)
  const [cardsPerSessionOn, setCardsPerSessionOn] = useState((initialPrefs?.cardsPerSession ?? 0) > 0)
  const [cardsPerSession,   setCardsPerSession]   = useState(initialPrefs?.cardsPerSession || 10)
  const [saving,        setSaving]        = useState(false)
  const [saved,         setSaved]         = useState(false)
  const [saveError,     setSaveError]     = useState<string | null>(null)
  const [confirmReset,  setConfirmReset]  = useState(false)
  const [confirmFullReset, setConfirmFullReset] = useState(false)
  const [fullResetting,   setFullResetting]   = useState(false)
  const [fullResetError,  setFullResetError]  = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
    await prefRepo.upsert({
      userId, deckId,
      dailyNewCards:     dailyLimit,
      dailyOverride:     onlyToday ? todayOverride : null,
      dailyOverrideDate: onlyToday ? today         : null,
      spilloverDue:      spillover,
      cardsPerSession:   cardsPerSessionOn ? cardsPerSession : null,
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => { setSaved(false); onClose() }, 800)
    } catch (err: unknown) {
      setSaving(false)
      setSaveError(err instanceof Error ? err.message : 'Save failed — did you run the SQL migrations?')
    }
  }

  async function handleReset() {
    await prefRepo.resetDeckBacklog(userId, deckId)
    setConfirmReset(false)
    onClose()
  }

  async function handleFullReset() {
    setFullResetting(true)
    setFullResetError(null)
    try {
      const deckRepo = new SupabaseDeckRepository()
      await deckRepo.resetProgress(deckId)
      setConfirmFullReset(false)
      onClose()

      // Kick off background regeneration of AI answer choices for every
      // card now that the cached pools were just cleared.
      const resetCards = cards.map(c => ({ ...c, choices: null }))
      const prefetchItems: PrefetchItem[] = resetCards.map(card => ({
        card, side: 'front', deckCards: resetCards, sourceLanguage, targetLanguage,
      }))
      void prefetchChoices(prefetchItems, () => {})
    } catch (err: unknown) {
      setFullResetError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setFullResetting(false)
    }
  }

  return (
    <>
      {confirmReset && (
        <ConfirmDialog
          message="Are you sure you want to reset and stray from your study routine? This will clear the backlog for this deck and treat all in-progress cards as starting fresh today."
          onConfirm={handleReset}
          onCancel={() => setConfirmReset(false)}
        />
      )}

      {confirmFullReset && (
        <ConfirmDialog
          message="This will erase ALL study progress for this deck — every card goes back to never studied, and cached answer choices are cleared and regenerated. The cards themselves and your other settings are not affected. This can't be undone."
          onConfirm={handleFullReset}
          onCancel={() => setConfirmFullReset(false)}
        />
      )}

      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        <div className="panel w-full max-w-sm space-y-5 mx-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">Deck study settings</h2>
            <button onClick={onClose} className="text-ink-faint hover:text-ink text-lg leading-none">✕</button>
          </div>

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

          {/* Cards per session (batch mode) */}
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
                  Keeps {cardsPerSession} new card{cardsPerSession !== 1 ? 's' : ''} in the learning pipeline at a time —
                  once a card graduates, the next session introduces another to take its place. Overrides the daily limit above.
                </p>
              </div>
            )}
          </div>

          {saveError && (
            <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
              ⚠ {saveError}
            </p>
          )}

          <div className="flex gap-3">
            <button className="btn-primary flex-1" onClick={handleSave} disabled={saving}>
              {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
          </div>

          {/* Reset divider */}
          <div className="border-t border-white/10 pt-3">
            <button
              onClick={() => setConfirmReset(true)}
              className="text-sm text-danger/70 hover:text-danger transition-colors w-full text-left"
            >
              ↺ Reset backlog for this deck
            </button>
            <p className="text-xs text-ink-faint mt-1">
              Clears accumulated missed cards — only today&apos;s {dailyLimit} will be due.
            </p>
          </div>

          {/* Full progress reset */}
          <div className="border-t border-white/10 pt-3">
            <button
              onClick={() => setConfirmFullReset(true)}
              disabled={fullResetting}
              className="text-sm text-danger/70 hover:text-danger transition-colors w-full text-left disabled:opacity-40"
            >
              ↺ Reset all progress for this deck
            </button>
            <p className="text-xs text-ink-faint mt-1">
              Resets every card to never studied and clears cached answer choices. Cards and settings are kept.
            </p>
            {fullResetError && (
              <p className="text-danger text-xs bg-danger/10 border border-danger/20 rounded-lg px-3 py-2 mt-2">
                ⚠ {fullResetError}
              </p>
            )}
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
  const [addingCard,       setAddingCard]       = useState(false)
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
          onSave={handleCardSave}
          onClose={() => setEditingCard(null)}
        />
      )}

      {showGear && (
        <DeckSettingsPanel
          deckId={deckId} userId={userId} initialPrefs={prefs}
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
              : `/library?source=${deck.sourceLanguage}&target=${deck.targetLanguage}`}
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
              className={`panel border-t-2 ${border} text-center space-y-1 transition-colors w-full
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
