'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckPreferencesRepository } from '@/lib/data/deckPreferences'
import { DEFAULT_DAILY_NEW_CARDS } from '@/domain'

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

export default function SettingsPage() {
  const [displayName,   setDisplayName]   = useState('')
  const [selectedLangs, setSelectedLangs] = useState<string[]>([])
  const [dailyNewCards, setDailyNewCards] = useState(DEFAULT_DAILY_NEW_CARDS)
  const [spilloverDue,  setSpilloverDue]  = useState(false)
  const [timezone,      setTimezone]      = useState('')
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

      const { data: profile } = await supabase
        .from('profiles')
        .select('display_name, default_daily_new_cards, spillover_due, learning_languages, timezone')
        .eq('user_id', uid)
        .single()

      if (profile) {
        setDisplayName(profile.display_name ?? '')
        setDailyNewCards(profile.default_daily_new_cards ?? DEFAULT_DAILY_NEW_CARDS)
        setSpilloverDue(profile.spillover_due ?? false)
        setSelectedLangs((profile.learning_languages as string[]) ?? [])
        setTimezone((profile.timezone as string | null) ?? detectBrowserTimezone())
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
