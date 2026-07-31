'use client'

/**
 * components/settings/ConfigLibrary.tsx — presets and saved configs for ladders and pathways.
 *
 * Two ways to get a shape into the editor: a built-in PRESET (`lib/learningPresets.ts`) or something
 * you saved earlier. Loading only fills the editor — nothing is written until you press the editor's
 * own Save, so trying a preset is never destructive.
 *
 * Saving is separate from what a pair is actively studying: `saved_learning_configs` is a library,
 * `learning_ladders`/`learning_pathways` is the live config. Saving here can't disturb a pair mid-study.
 */

import { useCallback, useEffect, useState } from 'react'
import { SupabaseSavedLearningConfigRepository, type SavedLearningConfig, type SavedConfigKind } from '@/lib/data/savedLearningConfigs'
import { LADDER_PRESETS, PATHWAY_PRESETS, type LearningPreset } from '@/lib/learningPresets'
import type { Ladder, Pathway } from '@/domain'

export function ConfigLibrary({ kind, userId, current, onLoad }: {
  kind:    SavedConfigKind
  userId:  string
  /** What the editor currently holds — what "Save as…" writes. */
  current: Ladder | Pathway | null
  onLoad:  (config: Ladder | Pathway) => void
}) {
  const [saved,   setSaved]   = useState<SavedLearningConfig[]>([])
  const [name,    setName]    = useState('')
  const [busy,    setBusy]    = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [note,    setNote]    = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const presets = (kind === 'ladder' ? LADDER_PRESETS : PATHWAY_PRESETS) as LearningPreset<Ladder | Pathway>[]

  const refresh = useCallback(async () => {
    try { setSaved(await new SupabaseSavedLearningConfigRepository().list(userId, kind)) }
    catch { /* the library is an extra; never block the editor on it */ }
  }, [userId, kind])

  useEffect(() => { void refresh() }, [refresh])

  async function save() {
    if (!current || busy) return
    setBusy(true); setError(null); setNote(null)
    try {
      const existing = saved.find(s => s.name.trim().toLowerCase() === name.trim().toLowerCase())
      await new SupabaseSavedLearningConfigRepository().save(userId, kind, name, current)
      setNote(existing ? `Updated “${name.trim()}”.` : `Saved as “${name.trim()}”.`)
      setName('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.')
    } finally { setBusy(false) }
  }

  async function remove(id: string) {
    setBusy(true); setError(null)
    try { await new SupabaseSavedLearningConfigRepository().remove(id); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not delete that.') }
    finally { setBusy(false); setConfirmDelete(null) }
  }

  const label = kind === 'ladder' ? 'ladder' : 'pathway'

  return (
    <div className="panel space-y-4">
      <div>
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Presets</p>
        <p className="text-[11px] text-ink-faint mt-0.5">
          {`Loads into the editor below — nothing is saved until you press Save ${label}.`}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {presets.map(p => (
          <button
            key={p.id}
            type="button"
            disabled={busy}
            onClick={() => { onLoad(p.build()); setNote(`Loaded the ${p.label} preset — press Save ${label} to keep it.`) }}
            className="text-left rounded-lg border border-line/10 hover:border-accent/40 hover:bg-surface/40 px-3 py-2 transition-colors disabled:opacity-40"
          >
            <span className="text-sm text-ink">{p.label}</span>
            <span className="block text-[11px] text-ink-faint mt-0.5 leading-snug">{p.blurb}</span>
          </button>
        ))}
      </div>

      {saved.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Your saved {label}s</p>
          <div className="rounded-lg border border-line/10 divide-y divide-line/5">
            {saved.map(s => (
              <div key={s.id} className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { onLoad(s.config); setNote(`Loaded “${s.name}” — press Save ${label} to keep it.`) }}
                  className="flex-1 text-left text-sm text-ink hover:text-accent transition-colors disabled:opacity-40 truncate"
                >
                  {s.name}
                </button>
                {confirmDelete === s.id ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => void remove(s.id)}
                      className="text-[11px] text-danger hover:text-danger/80">Delete</button>
                    <button type="button" onClick={() => setConfirmDelete(null)}
                      className="text-[11px] text-ink-faint hover:text-ink">Cancel</button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmDelete(s.id)}
                    className="text-[11px] text-ink-faint hover:text-danger transition-colors">Remove</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Save this {label}</p>
        <div className="flex gap-2">
          <input
            className="input text-sm flex-1"
            placeholder={`Name this ${label}…`}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) { e.preventDefault(); void save() } }}
          />
          <button type="button" className="btn-ghost text-sm" disabled={!current || !name.trim() || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save as…'}
          </button>
        </div>
        <p className="text-[11px] text-ink-faint">
          Re-using a name updates that entry. Saving here doesn&apos;t change what any language is
          studying — it just keeps the shape for later.
        </p>
      </div>

      {note  && <p className="text-xs text-success">{note}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
