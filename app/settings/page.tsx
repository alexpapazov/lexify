'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckPreferencesRepository }  from '@/lib/data/deckPreferences'
import { SupabaseLanguageSyncRuleRepository } from '@/lib/data/languageSyncRules'
import { SupabaseLanguagePairRepository }     from '@/lib/data/languagePairs'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'
import type { LanguagePair, LanguageSyncRule } from '@/domain'
import { langName } from '@/lib/languages'

const LANGUAGES = [
  { code: 'es', label: 'Spanish'    },
  { code: 'fr', label: 'French'     },
  { code: 'de', label: 'German'     },
  { code: 'bg', label: 'Bulgarian'  },
  { code: 'zh', label: 'Mandarin'   },
  { code: 'ja', label: 'Japanese'   },
  { code: 'ko', label: 'Korean'     },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian'    },
  { code: 'asl', label: 'ASL'       },
]

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
          <div key={rule.id} className={`rounded-card border p-3 space-y-2 ${rule.enabled && !confirmingDelete ? 'border-white/10' : confirmingDelete ? 'border-danger/30 bg-danger/5' : 'border-white/5 opacity-60'}`}>
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
                      className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${rule.enabled ? 'bg-accent' : 'bg-white/20'}`}
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
                      className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded border border-white/10 transition-colors"
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
        <div className="rounded-card border border-white/10 p-4 space-y-3">
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

export default function SettingsPage() {
  const [userId,        setUserId]        = useState('')
  const [displayName,   setDisplayName]   = useState('')
  const [selectedLangs, setSelectedLangs] = useState<string[]>([])
  const [dailyNewCards, setDailyNewCards] = useState(DEFAULT_DAILY_NEW_CARDS)
  const [spilloverDue,  setSpilloverDue]  = useState(false)
  const [timezone,      setTimezone]      = useState('')
  const [turnoverHour,  setTurnoverHour]  = useState(0)
  const [loading,       setLoading]       = useState(true)
  const [saved,         setSaved]         = useState(false)
  const [confirmReset,  setConfirmReset]  = useState(false)
  const [resetDone,     setResetDone]     = useState(false)
  const [tzList,        setTzList]        = useState<string[]>([])

  const router   = useRouter()
  const supabase = createClient()

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

      const { data: profile } = await supabase
        .from('profiles')
        .select('display_name, default_daily_new_cards, spillover_due, learning_languages, timezone, day_turnover_hour')
        .eq('user_id', uid)
        .single()

      if (profile) {
        setDisplayName(profile.display_name ?? '')
        setDailyNewCards(profile.default_daily_new_cards ?? DEFAULT_DAILY_NEW_CARDS)
        setSpilloverDue(profile.spillover_due ?? false)
        setSelectedLangs((profile.learning_languages as string[]) ?? [])
        setTimezone((profile.timezone as string | null) ?? detectBrowserTimezone())
        setTurnoverHour((profile.day_turnover_hour as number | null) ?? 0)
      } else {
        setTimezone(detectBrowserTimezone())
      }
      setLoading(false)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    await supabase.from('profiles').update({
      display_name:            displayName,
      default_daily_new_cards: dailyNewCards,
      spillover_due:           spilloverDue,
      learning_languages:      selectedLangs,
      timezone:                timezone || null,
      day_turnover_hour:       turnoverHour,
    }).eq('user_id', session.user.id)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleGlobalReset() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    const prefRepo = new SupabaseDeckPreferencesRepository()
    await prefRepo.resetAllBacklogs(session.user.id)
    setConfirmReset(false)
    setResetDone(true)
    setTimeout(() => setResetDone(false), 3000)
  }

  function toggle(code: string) {
    setSelectedLangs(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code])
  }

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  return (
    <div className="space-y-8 max-w-lg mx-auto">
      {confirmReset && (
        <ConfirmDialog
          message="Are you sure you want to reset and stray from your study routine? This will clear the backlog across ALL decks and treat all in-progress cards as starting fresh today."
          onConfirm={handleGlobalReset}
          onCancel={() => setConfirmReset(false)}
        />
      )}

      <h1 className="text-2xl font-semibold text-ink">Settings</h1>

      {/* Profile */}
      <div className="panel space-y-4">
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Profile</h2>
        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Display name</label>
          <input className="input" placeholder="Your display name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Password</label>
          <input type="password" className="input" placeholder="••••••••" disabled />
          <p className="text-xs text-ink-faint">Password changes via Supabase email link — coming soon.</p>
        </div>
      </div>

      {/* Timezone */}
      <div className="panel space-y-4">
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Time zone</h2>
        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Your time zone</label>
          {tzList.length > 0 ? (
            <select
              className="input"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
            >
              {tzList.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              placeholder="e.g. America/New_York"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
            />
          )}
          <p className="text-xs text-ink-faint">
            Used to determine when &ldquo;today&rdquo; starts for daily study limits and card scheduling.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Day turnover time</label>
          <select
            className="input"
            value={turnoverHour}
            onChange={e => setTurnoverHour(parseInt(e.target.value, 10))}
          >
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
      </div>

      {/* Study defaults */}
      <div className="panel space-y-4">
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Study defaults</h2>

        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Default new cards per day</label>
          <input type="number" min={1} max={500} className="input" value={dailyNewCards}
            onChange={e => setDailyNewCards(Math.max(1, parseInt(e.target.value) || 1))} />
          <p className="text-xs text-ink-faint">
            Applied to any deck without its own setting (configure per-deck via the ⚙ icon in deck view).
          </p>
        </div>

        <div className="space-y-1">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={spilloverDue} onChange={e => setSpilloverDue(e.target.checked)} className="accent-accent w-4 h-4" />
            <span className="text-sm text-ink">Due cards spill over (global default)</span>
          </label>
          <p className="text-xs text-ink-faint pl-6">
            {spilloverDue
              ? 'Cards you miss accumulate — you may see more than your daily limit if you fall behind.'
              : 'Missed cards count toward tomorrow\'s limit — your daily total stays fixed at ' + dailyNewCards + '.'}
          </p>
        </div>
      </div>

      {/* Languages */}
      <div className="panel space-y-4">
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Languages I&apos;m learning</h2>
        <div className="flex flex-wrap gap-2">
          {LANGUAGES.map(({ code, label }) => {
            const active = selectedLangs.includes(code)
            return (
              <button key={code} onClick={() => toggle(code)} className={[
                'px-3 py-1.5 rounded-full text-sm font-medium border transition-colors',
                active ? 'bg-accent/20 border-accent/60 text-accent-soft'
                       : 'bg-surface-raised border-white/10 text-ink-muted hover:border-white/20 hover:text-ink',
              ].join(' ')}>{label}</button>
            )
          })}
        </div>
      </div>

      <div className="flex gap-3">
        <button className="btn-primary" onClick={handleSave}>
          {saved ? 'Saved ✓' : 'Save settings'}
        </button>
      </div>

      {/* Language Sync */}
      {userId && (
        <div className="panel space-y-4">
          <div>
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Language Sync</h2>
            <p className="text-xs text-ink-faint mt-1">
              Sync rules generate linked vocabulary in another language pair when you study.
              E.g. a French card you study can auto-generate the Korean equivalent.
            </p>
          </div>
          <LanguageSyncPanel userId={userId} />
        </div>
      )}

      {/* Global reset */}
      <div className="panel border-danger/20 space-y-2">
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Danger zone</h2>
        <p className="text-xs text-ink-muted">
          Reset the study backlog across <strong className="text-ink">all decks</strong>.
          Cards you missed will no longer pile up — only today&apos;s limit will be due.
        </p>
        {resetDone && <p className="text-success text-xs">✓ Backlog cleared across all decks.</p>}
        <button
          onClick={() => setConfirmReset(true)}
          className="text-sm border border-danger/30 text-danger/80 hover:text-danger hover:border-danger/60 px-4 py-2 rounded-lg transition-colors"
        >
          ↺ Global reset — clear all backlogs
        </button>
      </div>
    </div>
  )
}
