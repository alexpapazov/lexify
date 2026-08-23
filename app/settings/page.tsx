'use client'

import { Suspense, useEffect, useState } from 'react'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import CatchUpPanel from '@/components/settings/CatchUpPanel'
import { SupabaseDeckPreferencesRepository }  from '@/lib/data/deckPreferences'
import { SupabaseCardStateRepository }        from '@/lib/data/cardStates'
import { SupabaseLanguageSyncRuleRepository } from '@/lib/data/languageSyncRules'
import { SupabaseLanguagePairRepository }     from '@/lib/data/languagePairs'
import { SupabaseFolderRepository }           from '@/lib/data/folders'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'
import type { LanguagePair, LanguageSyncRule, CardState } from '@/domain'
import { langName, langFlag, assignLanguageColors, LANG_COLOR_PALETTE } from '@/lib/languages'
import { fsrsFuzzRange } from '@/engine/fsrs'
import { getToday } from '@/lib/dates'
import { ThemeToggle } from '@/components/ThemeToggle'
import { OfflinePanel } from '@/components/settings/OfflinePanel'
import {
  SettingsShell, SettingsPane, SettingsSection, SettingsRow, parseSection,
  type SettingsSectionId,
} from '@/components/settings/SettingsShell'
import { GoalsSettings } from '@/components/settings/GoalsSettings'
import { LaddersSettings } from '@/components/settings/LaddersSettings'
import { startTour } from '@/components/Tour'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { voiceNameFor } from '@/lib/speak'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { labelCards, type LabelableCard } from '@/lib/labelCards'

// ── Language color picker: a 7×7 gradient swatch grid, with the OS color wheel behind "Custom". ──
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = hex.replace('#', '')
  const r = parseInt(m.slice(0, 2), 16) / 255
  const g = parseInt(m.slice(2, 4), 16) / 255
  const b = parseInt(m.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const l = (max + min) / 2
  let h = 0, s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60; if (h < 0) h += 360
  }
  return { h, s: s * 100, l: l * 100 }
}
// Swatch grid derived from the LexiCard categorical palette (the per-language colors):
// columns = the 12 palette hues sorted into a spectrum, each shown as a tint · base · shade,
// then a grayscale row. The OS color wheel sits behind "Custom".
const clampL = (l: number) => Math.max(8, Math.min(94, l))
// The categorical palette plus the yellow highlight accent — yellow is held out of the
// auto-assigned/chart set, but offered here as a manual per-language choice.
const PICKER_PALETTE = [...LANG_COLOR_PALETTE, '#F5C518']
const PALETTE_COLS = PICKER_PALETTE
  .map(hex => ({ hex, ...hexToHsl(hex) }))
  .sort((a, b) => a.h - b.h)
const L_OFFSETS = [16, 0, -16] // tint · base (exact palette color) · shade
const COLOR_SWATCHES: string[] = [
  ...L_OFFSETS.flatMap(dl => PALETTE_COLS.map(c =>
    dl === 0 ? c.hex : hslToHex(c.h, c.s, clampL(c.l + dl)),
  )),
  // grayscale row: white → black
  ...Array.from({ length: PALETTE_COLS.length }, (_, i) =>
    hslToHex(0, 0, Math.round(96 - (i * 88) / (PALETTE_COLS.length - 1))),
  ),
]

function LanguageColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} aria-label="Choose color"
        className="w-8 h-8 rounded cursor-pointer border border-line/10 hover:border-line/30 transition-colors"
        style={{ backgroundColor: value }} />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 left-0 p-3 rounded-lg border border-line/10 bg-surface-raised shadow-lg">
            <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(13, 1.5rem)' }}>
              {COLOR_SWATCHES.map(hex => (
                <button key={hex} type="button" title={hex} onClick={() => { onChange(hex); setOpen(false) }}
                  className={`w-6 h-6 rounded-md border border-line/10 transition-transform hover:scale-125 hover:z-10 ${value.toLowerCase() === hex.toLowerCase() ? 'ring-2 ring-ink ring-offset-1 ring-offset-surface-raised' : ''}`}
                  style={{ backgroundColor: hex }} />
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
              <input type="color" value={value} onChange={e => onChange(e.target.value)}
                className="w-6 h-6 rounded cursor-pointer bg-transparent border border-line/10 p-0.5" />
              Custom…
            </label>
          </div>
        </>
      )}
    </div>
  )
}

function ConfirmDialog({ message, onConfirm, onCancel }: {
  message: string; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="panel w-full max-w-sm space-y-4 mx-4">
        <p className="text-ink text-sm leading-relaxed">{message}</p>
        <div className="flex gap-3">
          <button onClick={onConfirm} className="btn-primary flex-1 bg-danger hover:bg-danger/80">Yes, reset all</button>
          <button onClick={onCancel}  className="btn-ghost flex-1">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function detectBrowserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' }
}

const MODE_LABELS: Record<string, string> = {
  review_first: 'Review first',
  auto:         'Auto-approve',
}
const TRIGGER_LABELS: Record<string, string> = {
  manual_only:        'Manual only',
  on_card_created:    'When card is created',
  on_card_graduated:  'When card graduates',
}

function pairLabel(p: LanguagePair): string {
  return `${langName(p.sourceLanguage)} → ${langName(p.targetLanguage)}`
}

/**
 * Vocabulary labels (practice-mode groundwork, migration 110): part-of-speech + lemma for every
 * card's front. Idempotent — each run labels only cards without a label, so new cards are picked up
 * by simply running it again. Labels persist batch-by-batch (lib/labelCards.ts), so navigating away
 * mid-run loses nothing.
 */
function VocabularyLabelsPanel({ userId }: { userId: string }) {
  const [unlabeled, setUnlabeled] = useState<LabelableCard[] | null>(null)
  const [running,   setRunning]   = useState(false)
  const [progress,  setProgress]  = useState<{ done: number; total: number } | null>(null)
  const [message,   setMessage]   = useState<string | null>(null)

  async function loadUnlabeled(): Promise<void> {
    try {
      const cards = await new SupabaseCardRepository().listAllForUser(userId)
      setUnlabeled(cards.filter(c => !c.pos).map(c => ({
        id: c.id, front: c.front, back: c.back,
        sourceLanguage: c.sourceLanguage, targetLanguage: c.targetLanguage,
      })))
    } catch {
      setUnlabeled([])
    }
  }

  useEffect(() => { void loadUnlabeled() }, [userId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    if (!unlabeled || unlabeled.length === 0 || running) return
    setRunning(true)
    setMessage(null)
    setProgress({ done: 0, total: unlabeled.length })
    try {
      const result = await labelCards(unlabeled, (done, total) => setProgress({ done, total }))
      setMessage(result.failedCount === 0
        ? `Labeled ${result.labeledCount} card${result.labeledCount !== 1 ? 's' : ''}.`
        : `Labeled ${result.labeledCount}; ${result.failedCount} couldn't be labeled — run again to retry.`)
      await loadUnlabeled()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Labeling failed. Please try again.')
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const count = unlabeled?.length ?? 0
  return (
    <div className="panel space-y-3">
      <div>
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Vocabulary labels</h2>
        <p className="text-xs text-ink-faint mt-1">
          Tags every card with its word class (noun, verb, …) and dictionary form — the groundwork for
          practice exercises that build sentences from your vocabulary. Safe to re-run any time: only
          unlabeled cards are sent.
        </p>
      </div>
      {message && <p className="text-xs text-success">{message}</p>}
      <button
        onClick={() => void run()}
        disabled={running || unlabeled === null || count === 0}
        className="text-sm border border-line/20 text-ink-muted hover:text-ink hover:border-line/40 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
      >
        {running && progress
          ? `Labeling… ${progress.done} / ${progress.total}`
          : unlabeled === null
            ? 'Loading…'
            : count === 0
              ? 'All cards labeled'
              : `Label ${count} card${count !== 1 ? 's' : ''}`}
      </button>
    </div>
  )
}

function LanguageSyncPanel({ userId }: { userId: string }) {
  const [pairs,          setPairs]          = useState<LanguagePair[]>([])
  const [rules,          setRules]          = useState<LanguageSyncRule[]>([])
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState<string | null>(null)
  const [showForm,       setShowForm]       = useState(false)
  const [saving,         setSaving]         = useState(false)
  const [formError,      setFormError]      = useState<string | null>(null)
  const [deleteError,    setDeleteError]    = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting,       setDeleting]       = useState(false)

  // New-rule form state
  const [srcPairId,  setSrcPairId]  = useState('')
  const [dstPairId,  setDstPairId]  = useState('')
  const [mode,       setMode]       = useState<'review_first' | 'auto'>('review_first')
  const [trigger,    setTrigger]    = useState<'manual_only' | 'on_card_created' | 'on_card_graduated'>('manual_only')

  useEffect(() => {
    const ruleRepo = new SupabaseLanguageSyncRuleRepository()
    const pairRepo = new SupabaseLanguagePairRepository()
    Promise.all([pairRepo.list(userId), ruleRepo.listForUser(userId)])
      .then(([p, r]) => { setPairs(p); setRules(r) })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [userId])

  const availableDest = pairs.filter(p => p.id !== srcPairId)

  async function handleAddRule() {
    if (!srcPairId || !dstPairId) { setFormError('Select both pairs.'); return }
    if (srcPairId === dstPairId)   { setFormError('Source and destination must differ.'); return }
    if (rules.some(r => r.sourcePairId === srcPairId && r.destinationPairId === dstPairId)) {
      setFormError('A rule for this direction already exists.'); return
    }
    setSaving(true)
    setFormError(null)
    try {
      const ruleRepo = new SupabaseLanguageSyncRuleRepository()
      const created  = await ruleRepo.upsert({
        userId, sourcePairId: srcPairId, destinationPairId: dstPairId,
        enabled: true, mode, trigger, allowSyncedCardsToTriggerSync: false,
      })
      setRules(prev => [...prev, created])
      setSrcPairId(''); setDstPairId('')
      setMode('review_first'); setTrigger('manual_only')
      setShowForm(false)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to create rule')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(rule: LanguageSyncRule) {
    try {
      const ruleRepo = new SupabaseLanguageSyncRuleRepository()
      const updated  = await ruleRepo.upsert({ ...rule, enabled: !rule.enabled })
      setRules(prev => prev.map(r => r.id === rule.id ? updated : r))
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Toggle failed')
    }
  }

  async function handleDeleteConfirmed() {
    if (!confirmDeleteId) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const supabase = createClient()
      // Clear any synced_card_links referencing this rule first (FK constraint)
      await supabase.from('synced_card_links').delete().eq('sync_rule_id', confirmDeleteId)
      const ruleRepo = new SupabaseLanguageSyncRuleRepository()
      await ruleRepo.delete(confirmDeleteId)
      setRules(prev => prev.filter(r => r.id !== confirmDeleteId))
      setConfirmDeleteId(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <p className="text-ink-faint text-sm">Loading…</p>
  if (error)   return <p className="text-danger text-sm">{error}</p>
  if (pairs.length < 2) return (
    <p className="text-ink-faint text-sm">
      You need at least two language pairs to create sync rules.
      Add them on the{' '}
      <a href="/library" className="text-accent underline">Library</a> page.
    </p>
  )

  return (
    <div className="space-y-4">
      {/* Existing rules */}
      {rules.length === 0 && !showForm && (
        <p className="text-ink-faint text-sm">No sync rules yet. Add one below.</p>
      )}

      {deleteError && (
        <p className="text-danger text-xs">{deleteError}</p>
      )}

      {rules.map(rule => {
        const src = pairs.find(p => p.id === rule.sourcePairId)
        const dst = pairs.find(p => p.id === rule.destinationPairId)
        if (!src || !dst) return null
        const confirmingDelete = confirmDeleteId === rule.id
        return (
          <div key={rule.id} className={`rounded-card border p-3 space-y-2 ${rule.enabled && !confirmingDelete ? 'border-line/10' : confirmingDelete ? 'border-danger/30 bg-danger/5' : 'border-line/5 opacity-60'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {pairLabel(src)}
                  <span className="mx-2 text-accent">⟹</span>
                  {pairLabel(dst)}
                </p>
                <p className="text-xs text-ink-faint mt-0.5">
                  {MODE_LABELS[rule.mode]} · {TRIGGER_LABELS[rule.trigger]}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0 pt-0.5">
                {!confirmingDelete && (
                  <>
                    <button
                      onClick={() => handleToggle(rule)}
                      title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                      className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${rule.enabled ? 'bg-accent' : 'bg-line/20'}`}
                    >
                      <span className={`absolute top-1 w-3 h-3 bg-white rounded-full shadow transition-transform ${rule.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                    <button
                      onClick={() => { setConfirmDeleteId(rule.id); setDeleteError(null) }}
                      title="Delete rule"
                      className="text-xs text-danger/60 hover:text-danger border border-danger/20 hover:border-danger/50 px-2 py-1 rounded transition-colors"
                    >
                      Delete
                    </button>
                  </>
                )}
                {confirmingDelete && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-danger">Delete this rule?</span>
                    <button
                      onClick={handleDeleteConfirmed}
                      disabled={deleting}
                      className="text-xs bg-danger/80 hover:bg-danger text-white px-3 py-1 rounded transition-colors disabled:opacity-50"
                    >
                      {deleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={deleting}
                      className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded border border-line/10 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}

      {/* Add-rule form */}
      {showForm ? (
        <div className="rounded-card border border-line/10 p-4 space-y-3">
          <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wider">New sync rule</h3>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-ink-faint">Source pair (vocab you&apos;re studying)</label>
              <select
                className="input text-sm"
                value={srcPairId}
                onChange={e => { setSrcPairId(e.target.value); setDstPairId('') }}
              >
                <option value="">Select…</option>
                {pairs.map(p => <option key={p.id} value={p.id}>{pairLabel(p)}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-ink-faint">Destination pair (where cards get synced)</label>
              <select
                className="input text-sm"
                value={dstPairId}
                onChange={e => setDstPairId(e.target.value)}
                disabled={!srcPairId}
              >
                <option value="">Select…</option>
                {availableDest.map(p => <option key={p.id} value={p.id}>{pairLabel(p)}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-ink-faint">Review mode</label>
              <select className="input text-sm" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
                <option value="review_first">Review first — you approve before the card is created</option>
                <option value="auto">Auto-approve — cards created immediately</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-ink-faint">When to trigger</label>
              <select className="input text-sm" value={trigger} onChange={e => setTrigger(e.target.value as typeof trigger)}>
                <option value="manual_only">Manual only — use the Sync button on each card</option>
                <option value="on_card_created">When a card is created in the source pair</option>
                <option value="on_card_graduated">When a card graduates in the source pair</option>
              </select>
            </div>
          </div>

          {formError && <p className="text-danger text-xs">{formError}</p>}

          <div className="flex gap-2">
            <button
              className="btn-primary text-sm py-1.5 px-4"
              onClick={handleAddRule}
              disabled={saving || !srcPairId || !dstPairId}
            >
              {saving ? 'Adding…' : 'Add rule'}
            </button>
            <button
              className="btn-ghost text-sm py-1.5 px-3"
              onClick={() => { setShowForm(false); setFormError(null) }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="text-sm text-accent hover:text-accent/80 transition-colors"
          onClick={() => setShowForm(true)}
        >
          + Add sync rule
        </button>
      )}
    </div>
  )
}

/**
 * The settings sections that are driven by the shared profile/language state loaded here. Daily goals
 * and Learning ladders are their own components (own data, own editors) and are rendered by the page
 * beside this one — see `app/settings/page.tsx`'s default export.
 */
export function SettingsScreen({ section }: { section: SettingsSectionId }) {
  const [userId,        setUserId]        = useState('')
  const [displayName,   setDisplayName]   = useState('')
  const [selectedLangs, setSelectedLangs] = useState<string[]>([])
  const [dailyNewCards, setDailyNewCards] = useState(DEFAULT_DAILY_NEW_CARDS)
  const [studyModeAutoplay,   setStudyModeAutoplay]   = useState(true)
  const [audioSourceDefault,  setAudioSourceDefaultState] = useState<'browser' | 'elevenlabs' | 'forvo' | 'standard'>('browser')
  const [audioSourceByLang,   setAudioSourceByLangState]  = useState<Record<string, string>>({})
  const [langColors,          setLangColors]          = useState<Record<string, string>>({})
  const [timezone,            setTimezone]            = useState('')
  const [turnoverHour,        setTurnoverHour]        = useState(0)
  const [loading,       setLoading]       = useState(true)
  const [saved,         setSaved]         = useState(false)
  const [tzList,            setTzList]            = useState<string[]>([])
  const [redistributing,    setRedistributing]    = useState(false)
  const [redistributeMsg,   setRedistributeMsg]   = useState<string | null>(null)
  const [langPairs,              setLangPairs]              = useState<LanguagePair[]>([])
  const [confirmDeletePair,      setConfirmDeletePair]      = useState<string | null>(null)  // "src|tgt", first warning
  const [deletingPair,           setDeletingPair]           = useState(false)
  const [deletePairError,        setDeletePairError]        = useState<string | null>(null)

  const offline  = useOfflineMode()
  const router   = useRouter()
  const supabase = createClient()

  // Two-step language deletion: the inline "Delete" → confirmation panel is the first
  // warning; this native confirm is the second. Then it wipes the pair's cards, decks,
  // and folders (irreversible).
  async function handleDeleteLanguage(source: string, target: string) {
    if (!userId) return
    const ok = window.confirm(
      `Final confirmation — this cannot be undone.\n\nPermanently delete ${langName(source)} → ${langName(target)} and ALL of its cards, folders, and study progress?`
    )
    if (!ok) return
    setDeletingPair(true)
    setDeletePairError(null)
    try {
      const folderRepo = new SupabaseFolderRepository()
      const folders = await folderRepo.list(userId)
      await Promise.all(
        folders
          .filter(f => f.sourceLanguage === source && f.targetLanguage === target)
          .map(f => folderRepo.softDelete(f.id)),
      )
      await new SupabaseLanguagePairRepository().deletePair(source, target)
      const remaining = langPairs.filter(p => !(p.sourceLanguage === source && p.targetLanguage === target))
      setLangPairs(remaining)
      // Drop the learned language from the profile pills if no other pair still uses it.
      if (!remaining.some(p => p.sourceLanguage === source)) {
        setSelectedLangs(sel => sel.filter(c => c !== source))
      }
      setConfirmDeletePair(null)
    } catch (e) {
      setDeletePairError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeletingPair(false)
    }
  }

  useEffect(() => {
    // Populate timezone list from browser (en-CA locale gives YYYY-MM-DD dates)
    try {
      const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
      setTzList(zones)
    } catch { setTzList([]) }

    supabase.auth.getSession().then(async ({ data }) => {
      const uid = data.session?.user.id
      if (!uid) { router.push('/auth'); return }
      setUserId(uid)

      const [{ data: profile }, pairs] = await Promise.all([
        supabase
          .from('profiles')
          .select('display_name, default_daily_new_cards, learning_languages, timezone, day_turnover_hour, study_mode_autoplay, audio_source_default, audio_source_by_language, language_colors')
          .eq('user_id', uid)
          .single(),
        new SupabaseLanguagePairRepository().list(uid),
      ])

      if (profile) {
        setDisplayName(profile.display_name ?? '')
        setDailyNewCards(profile.default_daily_new_cards ?? DEFAULT_DAILY_NEW_CARDS)
        setSelectedLangs((profile.learning_languages as string[]) ?? [])
        setTimezone((profile.timezone as string | null) ?? detectBrowserTimezone())
        setTurnoverHour((profile.day_turnover_hour as number | null) ?? 0)
        setStudyModeAutoplay((profile.study_mode_autoplay as boolean | null) ?? true)
        setAudioSourceDefaultState(((profile.audio_source_default as string | null) ?? 'browser') as 'browser' | 'elevenlabs' | 'forvo' | 'standard')
        setAudioSourceByLangState((profile.audio_source_by_language as Record<string, string> | null) ?? {})
        setLangColors((profile.language_colors as Record<string, string> | null) ?? {})
      } else {
        setTimezone(detectBrowserTimezone())
      }

      setLangPairs(pairs)
      setLoading(false)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    await supabase.from('profiles').update({
      display_name:              displayName,
      default_daily_new_cards:   dailyNewCards,
      learning_languages:        selectedLangs,
      timezone:                  timezone || null,
      day_turnover_hour:         turnoverHour,
      study_mode_autoplay:       studyModeAutoplay,
      audio_source_default:      audioSourceDefault,
      audio_source_by_language:  audioSourceByLang,
      language_colors:           langColors,
    }).eq('user_id', session.user.id)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }


  async function handleGlobalRedistribute() {
    if (redistributing || !userId) return
    setRedistributing(true)
    setRedistributeMsg(null)
    try {
      const todayStr = getToday(timezone || deviceTimeZone(), turnoverHour)
      const today    = new Date(todayStr + 'T00:00:00.000Z')

      const stateRepo = new SupabaseCardStateRepository()
      const allStates = await stateRepo.listAllGraduated(userId)

      interface Movable { state: CardState; earliest: string; latest: string }
      const movable: Movable[] = []

      for (const s of allStates) {
        if (!s.dueAt) continue
        if (s.relearningStep > 0) continue

        // Fast-track cards on first review cycle: window = [today, graduatedAt + 14 days]
        if (s.acceleratedMode === 'import_known' && s.reps === 0 && s.graduatedAt) {
          const gradDay = new Date(s.graduatedAt)
          gradDay.setUTCHours(0, 0, 0, 0)
          const maxDate = new Date(gradDay.getTime() + 14 * 24 * 60 * 60 * 1000)
          const earliest = todayStr
          const latest   = maxDate.toISOString().slice(0, 10)
          if (earliest <= latest) movable.push({ state: s, earliest, latest })
          continue
        }

        // Graduated cards are FSRS-scheduled — the movable window is the fuzz
        // window around the current interval (matches how they were scheduled).
        if (!s.lastReviewedAt || s.scheduledIntervalDays <= 0) continue

        const [smoothMinDays, smoothMaxDays] = fsrsFuzzRange(s.scheduledIntervalDays)

        const lastReviewed = new Date(s.lastReviewedAt)
        lastReviewed.setUTCHours(0, 0, 0, 0)

        const minDate = new Date(lastReviewed)
        minDate.setUTCDate(minDate.getUTCDate() + Math.ceil(smoothMinDays))
        const maxDate = new Date(lastReviewed)
        maxDate.setUTCDate(maxDate.getUTCDate() + Math.floor(smoothMaxDays))

        const earliestDate = minDate < today ? today : minDate
        const earliest = earliestDate.toISOString().slice(0, 10)
        const latest   = maxDate.toISOString().slice(0, 10)

        if (earliest <= latest) movable.push({ state: s, earliest, latest })
      }

      if (movable.length === 0) {
        setRedistributeMsg('No cards can be moved — all are at the boundary of their scheduling window.')
        return
      }

      // Build windowDays spanning from today to the furthest card's latest date
      const maxLatest = movable.reduce((m, c) => c.latest > m ? c.latest : m, todayStr)
      const windowDays: string[] = []
      for (let d = new Date(today); d.toISOString().slice(0, 10) <= maxLatest; d.setUTCDate(d.getUTCDate() + 1)) {
        windowDays.push(d.toISOString().slice(0, 10))
      }

      // Load map from ALL graduated states
      const loadMap = new Map<string, number>()
      for (const day of windowDays) loadMap.set(day, 0)
      for (const s of allStates) {
        if (!s.dueAt) continue
        const dayKey = s.dueAt.slice(0, 10)
        if (loadMap.has(dayKey)) loadMap.set(dayKey, (loadMap.get(dayKey) ?? 0) + 1)
      }

      // Greedy: tightest window first
      movable.sort((a, b) => {
        const aSpan = windowDays.filter(d => d >= a.earliest && d <= a.latest).length
        const bSpan = windowDays.filter(d => d >= b.earliest && d <= b.latest).length
        return aSpan - bSpan
      })
      const assignments = new Map<string, string>()
      for (const { state, earliest, latest } of movable) {
        let bestDay  = state.dueAt!.slice(0, 10)
        let bestLoad = Infinity
        for (const day of windowDays) {
          if (day < earliest || day > latest) continue
          const load = loadMap.get(day) ?? 0
          if (load < bestLoad) { bestLoad = load; bestDay = day }
        }
        assignments.set(state.cardId, bestDay)
        loadMap.set(bestDay, (loadMap.get(bestDay) ?? 0) + 1)
        const prevDay = state.dueAt!.slice(0, 10)
        loadMap.set(prevDay, Math.max(0, (loadMap.get(prevDay) ?? 1) - 1))
      }

      const toUpdate: CardState[] = []
      for (const { state } of movable) {
        const newDay = assignments.get(state.cardId)
        if (!newDay || newDay === state.dueAt!.slice(0, 10)) continue
        const timePart = state.dueAt!.slice(10)
        const newDue   = newDay + timePart
        // Move the active production column too (queue building reads it, not dueAt).
        const trackPatch = state.smartDueAt ? { smartDueAt: newDue }
          : state.typedDueAt ? { typedDueAt: newDue } : {}
        toUpdate.push({ ...state, dueAt: newDue, ...trackPatch })
      }

      if (toUpdate.length > 0) {
        await stateRepo.upsertBatch(toUpdate)
        setRedistributeMsg(`Moved ${toUpdate.length} card${toUpdate.length !== 1 ? 's' : ''} — ${movable.length - toUpdate.length} already optimal.`)
      } else {
        setRedistributeMsg('Cards are already well distributed within their scheduling windows.')
      }
    } catch (err) {
      console.error('Global redistribute failed:', err)
      setRedistributeMsg('Something went wrong. Please try again.')
    } finally {
      setRedistributing(false)
    }
  }

  if (loading) return <p className="text-sm text-ink-faint">Loading…</p>

  // Sections whose controls are part of the one profile write `handleSave` performs. Everything else
  // saves itself (theme, offline, sync rules, labels, deletes), so a Save button there would be a lie.
  const needsSave = section === 'profile' || section === 'time' || section === 'study' || section === 'colors'
  const codes = [...new Set(langPairs.map(p => p.sourceLanguage))]

  return (
    <SettingsPane>
      {section === 'profile' && (
        <SettingsSection title="Profile">
          <div className="space-y-1.5 max-w-md">
            <label className="text-sm text-ink-muted">Display name</label>
            <input className="input" placeholder="Your display name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-1.5 max-w-md">
            <label className="text-sm text-ink-muted">Password</label>
            <input type="password" className="input" placeholder="••••••••" disabled />
            <p className="text-xs text-ink-faint">Password changes via Supabase email link — coming soon.</p>
          </div>
        </SettingsSection>
      )}

      {section === 'appearance' && (<>
        <SettingsSection title="Appearance">
          <SettingsRow label="Theme"><ThemeToggle /></SettingsRow>
        </SettingsSection>
        {!offline && (
          <SettingsSection title="Tutorial">
            <SettingsRow label="Guided product tour" hint="Walks through the main screens again from the beginning.">
              <button className="btn-ghost text-sm py-1.5 px-3" onClick={() => startTour()}>Replay tutorial</button>
            </SettingsRow>
          </SettingsSection>
        )}
      </>)}

      {section === 'time' && (
        <SettingsSection title="Time zone">
          <div className="space-y-1.5 max-w-md">
            <label className="text-sm text-ink-muted">Your time zone</label>
            {tzList.length > 0 ? (
              <select className="input" value={timezone} onChange={e => setTimezone(e.target.value)}>
                {tzList.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            ) : (
              <input className="input" placeholder="e.g. America/New_York" value={timezone} onChange={e => setTimezone(e.target.value)} />
            )}
            <p className="text-xs text-ink-faint">
              Used to determine when &ldquo;today&rdquo; starts for daily study limits and card scheduling.
            </p>
          </div>
          <div className="space-y-1.5 max-w-md">
            <label className="text-sm text-ink-muted">Day turnover time</label>
            <select className="input" value={turnoverHour} onChange={e => setTurnoverHour(parseInt(e.target.value, 10))}>
              {Array.from({ length: 13 }, (_, h) => (
                <option key={h} value={h}>
                  {h === 0 ? '12:00 AM — midnight (default)' : h < 12 ? `${h}:00 AM` : '12:00 PM — noon'}
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-faint">
              If you study past midnight, cards completed before this time count toward the previous day&rsquo;s session.
              E.g. set to 4:00 AM and studying at 3 AM is part of yesterday.
            </p>
          </div>
        </SettingsSection>
      )}

      {section === 'offline' && <div className="py-6 first:pt-0"><OfflinePanel /></div>}

      {section === 'study' && (<>
        <SettingsSection title="New cards"
          description="Applied to any deck without its own setting — configure a single deck from the ⚙ icon in deck view.">
          <div className="space-y-1.5">
            <label className="text-sm text-ink-muted block">Default new cards per day</label>
            <input type="number" min={1} max={500} className="input w-32" value={dailyNewCards}
              onChange={e => setDailyNewCards(Math.max(1, parseInt(e.target.value) || 1))} />
          </div>
        </SettingsSection>

        <SettingsSection title="Audio"
          description={<>The voice used for new cards. <strong className="text-ink">Robotic</strong> uses your device&apos;s built-in speech and generates nothing. <strong className="text-ink">AI voice</strong> and <strong className="text-ink">Forvo</strong> pre-generate real clips (Forvo falls back to AI when it has no recording). You can still override the source per card from its ℹ panel; existing cards keep their current audio until you clear it.</>}>
          <SettingsRow label="Auto-play audio in Study mode"
            hint="Target-language audio plays automatically during Due Now sessions.">
            <input type="checkbox" checked={studyModeAutoplay} onChange={e => setStudyModeAutoplay(e.target.checked)} className="accent-accent w-4 h-4" />
          </SettingsRow>
          <SettingsRow label="Default audio source">
            <select value={audioSourceDefault} onChange={e => setAudioSourceDefaultState(e.target.value as 'browser' | 'elevenlabs' | 'forvo' | 'standard')}
              className="input text-sm w-52">
              <option value="browser">Robotic (device voice)</option>
              <option value="standard">Standard voice (same for everyone)</option>
              <option value="elevenlabs">AI voice (ElevenLabs)</option>
              <option value="forvo">Forvo (real recordings)</option>
            </select>
          </SettingsRow>

          {/* Which device voice is actually being used. Apple ships a low-quality "compact" voice per
              language and offers a much better Enhanced/Premium download — this readout is how you tell
              whether the good one is installed and picked up. */}
          <DeviceVoiceReadout codes={codes} />

          {codes.length > 0 && (
            <div className="pt-2 space-y-1">
              <p className="text-xs uppercase tracking-wider text-ink-faint">Per-language override</p>
              {codes.map(code => (
                <SettingsRow key={code} label={`${langFlag(code)} ${langName(code)}`}>
                  <select
                    value={audioSourceByLang[code] ?? ''}
                    onChange={e => setAudioSourceByLangState(prev => {
                      const next = { ...prev }
                      if (e.target.value) next[code] = e.target.value; else delete next[code]
                      return next
                    })}
                    className="input text-sm w-52">
                    <option value="">Use default</option>
                    <option value="browser">Robotic (device voice)</option>
                    <option value="standard">Standard voice (same for everyone)</option>
                    <option value="elevenlabs">AI voice (ElevenLabs)</option>
                    <option value="forvo">Forvo (real recordings)</option>
                  </select>
                </SettingsRow>
              ))}
            </div>
          )}
        </SettingsSection>
      </>)}

      {section === 'colors' && (
        <SettingsSection title="Language colors"
          description="Each language’s color in the analytics charts and the combined goal calendar.">
          {codes.length === 0
            ? <p className="text-sm text-ink-faint">Add a language pairing first and its color will appear here.</p>
            : (() => {
                const colorMap = assignLanguageColors(codes, langColors)   // distinct defaults + overrides
                return (
                  <div className="flex flex-col gap-3">
                    {codes.map(code => (
                      <div key={code} className="flex items-center gap-3 text-sm">
                        <LanguageColorPicker value={colorMap[code]!}
                          onChange={hex => setLangColors(prev => ({ ...prev, [code]: hex }))} />
                        <span className="text-ink">{langFlag(code)} {langName(code)}</span>
                        {langColors[code] && (
                          <button onClick={() => setLangColors(prev => { const n = { ...prev }; delete n[code]; return n })}
                            className="text-xs text-ink-faint hover:text-ink underline">Reset to default</button>
                        )}
                      </div>
                    ))}
                  </div>
                )
              })()}
        </SettingsSection>
      )}

      {section === 'sync' && !offline && userId && (
        <SettingsSection title="Language sync"
          description="Sync rules generate linked vocabulary in another language pair when you study — e.g. a French card you study can auto-generate the Korean equivalent.">
          <LanguageSyncPanel userId={userId} />
        </SettingsSection>
      )}

      {section === 'labels' && !offline && userId && <VocabularyLabelsPanel userId={userId} />}

      {section === 'data' && !offline && userId && (
        <SettingsSection title="Catch up on a backlog"
          description="When cards pile up, pick a date to be level again by and everything overdue or due today is dealt out across the days between — the ones you'd lose most by putting off go first, and deeply lapsed cards are spread evenly so no day becomes a wall of relearning. Future-scheduled cards never move, and nothing about the memory model changes.">
          <CatchUpPanel userId={userId} timezone={timezone || deviceTimeZone()} turnoverHour={turnoverHour} />
        </SettingsSection>
      )}

      {section === 'data' && !offline && userId && (
        <SettingsSection title="Redistribute cards"
          description="Spreads all graduated cards evenly across their scheduling windows so no single day is overloaded. Cards already at the edge of their window are left in place.">
          {redistributeMsg && (
            <p className={`text-sm ${redistributeMsg.startsWith('Moved') || redistributeMsg.startsWith('Cards are') ? 'text-success' : 'text-danger'}`}>
              {redistributeMsg}
            </p>
          )}
          <button onClick={handleGlobalRedistribute} disabled={redistributing}
            className="text-sm border border-line/20 text-ink-muted hover:text-ink hover:border-line/40 px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
            {redistributing ? 'Redistributing…' : '⟳ Redistribute all cards'}
          </button>
        </SettingsSection>
      )}

      {section === 'danger' && !offline && (
        <SettingsSection title="Delete a language"
          description={<>Deletes a language pairing and <strong className="text-ink">everything in it</strong> — all cards, folders, and study progress. This cannot be undone.</>}>
          {deletePairError && <p className="text-danger text-sm">{deletePairError}</p>}
          {langPairs.length === 0
            ? <p className="text-sm text-ink-faint">No language pairings yet.</p>
            : (() => {
                const seen = new Set<string>()
                const uniquePairs = langPairs.filter(p => {
                  const key = `${p.sourceLanguage}|${p.targetLanguage}`
                  if (seen.has(key)) return false
                  seen.add(key); return true
                })
                return (
                  <div className="space-y-2 max-w-2xl">
                    {uniquePairs.map(p => {
                      const key = `${p.sourceLanguage}|${p.targetLanguage}`
                      const confirming = confirmDeletePair === key
                      return (
                        <div key={key} className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${confirming ? 'border-danger/40 bg-danger/5' : 'border-line/10'}`}>
                          <span className="text-sm text-ink">
                            {langFlag(p.sourceLanguage)} {langName(p.sourceLanguage)} <span className="text-ink-faint">→ {langName(p.targetLanguage)}</span>
                          </span>
                          {confirming ? (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-danger hidden sm:inline">Delete everything?</span>
                              <button disabled={deletingPair}
                                onClick={() => handleDeleteLanguage(p.sourceLanguage, p.targetLanguage)}
                                className="text-xs bg-danger/90 hover:bg-danger text-white px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                                {deletingPair ? 'Deleting…' : 'Yes, delete'}
                              </button>
                              <button disabled={deletingPair}
                                onClick={() => { setConfirmDeletePair(null); setDeletePairError(null) }}
                                className="text-xs text-ink-faint hover:text-ink px-2 py-1.5">
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button onClick={() => { setConfirmDeletePair(key); setDeletePairError(null) }}
                              className="text-xs border border-danger/30 text-danger/80 hover:text-danger hover:border-danger/60 px-3 py-1.5 rounded-lg transition-colors">
                              Delete
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
        </SettingsSection>
      )}

      {needsSave && (
        <div className="pt-6">
          <button className="btn-primary" onClick={handleSave}>{saved ? 'Saved ✓' : 'Save settings'}</button>
        </div>
      )}
    </SettingsPane>
  )
}

function SettingsPageInner() {
  const section = parseSection(useSearchParams().get('section'))
  return (
    <SettingsShell active={section}>
      {section === 'goals'   ? <GoalsSettings />
        : section === 'ladders' ? <LaddersSettings />
        : <SettingsScreen section={section} />}
    </SettingsShell>
  )
}

export default function SettingsPage() {
  // Suspense is required for useSearchParams in the App Router; without it the page opts out of
  // static rendering, which the Capacitor export needs.
  return <Suspense fallback={<p className="p-6 text-sm text-ink-faint">Loading…</p>}><SettingsPageInner /></Suspense>
}

/**
 * Shows the device voice actually selected for each learning language, and flags when it's the
 * low-quality compact one. Voices load asynchronously, so this re-reads on `voiceschanged`.
 */
function DeviceVoiceReadout({ codes }: { codes: string[] }) {
  const [, bump] = useState(0)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    const onChange = () => bump(n => n + 1)
    window.speechSynthesis.addEventListener?.('voiceschanged', onChange)
    // Voices are often not ready on first paint; nudge once shortly after mount.
    const t = setTimeout(onChange, 300)
    return () => { window.speechSynthesis.removeEventListener?.('voiceschanged', onChange); clearTimeout(t) }
  }, [])
  if (codes.length === 0) return null
  const rows = codes.map(code => ({ code, name: voiceNameFor(code) }))
  const anyBasic = rows.some(r => r.name && !/premium|enhanced|neural|natural|siri/i.test(r.name))
  return (
    <div className="pt-2 space-y-1">
      <div className="text-xs text-ink-muted">Device voice in use</div>
      {rows.map(r => {
        const good = r.name ? /premium|enhanced|neural|natural|siri/i.test(r.name) : false
        return (
          <div key={r.code} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-ink-muted">{langFlag(r.code)} {langName(r.code)}</span>
            <span className={good ? 'text-success' : 'text-ink-faint'}>
              {r.name ?? 'no voice installed'}{good ? ' ✓' : ''}
            </span>
          </div>
        )
      })}
      {anyBasic && (
        <p className="text-[11px] text-ink-faint pt-1">
          Voices without <em>Enhanced</em> or <em>Premium</em> in the name are the basic compact ones — that&apos;s the
          robotic sound. Download a better one free: <strong>iPhone → Settings → Accessibility → Spoken Content →
          Voices</strong> (or macOS → System Settings → Accessibility → Spoken Content → System Voice → Manage Voices),
          pick the language, and grab the Enhanced/Premium variant. Reload Lexify afterwards and it&apos;ll be used
          automatically — no AI, works offline.
        </p>
      )}
    </div>
  )
}
