'use client'

/**
 * /study/journal — free-writing practice (v1: keep the data, nothing else).
 *
 * Write an entry, tag WHICH language(s) it was written in (chips built from your language pairs —
 * learned languages first, native ones after), and it's saved. Past entries list below, editable
 * in place, soft-deleted on remove. Schedule-neutral: nothing here touches reviews or goals.
 *
 * Planned but deliberately NOT in v1: writing prompts and AI feedback (the `prompt` column and
 * domain field already exist for them). The page sits under Study for now — expected to move.
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseJournalRepository } from '@/lib/data/journal'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { langFlag, langName } from '@/lib/languages'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import type { JournalEntry } from '@/domain'

/** Word count on whitespace runs — fine for the space-separated languages Lexify targets. */
const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)

function LanguageChips({ options, selected, onToggle }: {
  options: string[]
  selected: Set<string>
  onToggle: (code: string) => void
}) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {options.map(code => (
        <button key={code} type="button" onClick={() => onToggle(code)}
          className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
            selected.has(code) ? 'border-accent text-accent bg-accent/10' : 'border-line/20 text-ink-muted hover:text-ink'
          }`}>
          {langFlag(code)} {langName(code)}
        </button>
      ))}
    </div>
  )
}

export default function JournalPage() {
  const offline = useOfflineMode()
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [langOptions, setLangOptions] = useState<string[]>([])
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Composer
  const [draft, setDraft] = useState('')
  const [draftLangs, setDraftLangs] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  // In-place editing of one past entry at a time.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editLangs, setEditLangs] = useState<Set<string>>(new Set())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    if (offline) return
    ;(async () => {
      try {
        const { data: { session } } = await createClient().auth.getSession()
        if (!session) { router.push('/auth'); return }
        const uid = session.user.id
        setUserId(uid)
        const [pairs, list] = await Promise.all([
          new SupabaseLanguagePairRepository().list(uid),
          new SupabaseJournalRepository().list(uid),
        ])
        // Learned languages first (that's what you practice writing), native ones after — deduped.
        const learned = pairs.map(p => p.sourceLanguage)
        const native  = pairs.map(p => p.targetLanguage)
        const opts = [...new Set([...learned, ...native])]
        setLangOptions(opts)
        // One learned language → preselect it; otherwise the learner picks per entry.
        if (new Set(learned).size === 1 && learned[0]) setDraftLangs(new Set([learned[0]]))
        setEntries(list)
      } catch (e) {
        // Most likely cause on a fresh deploy: migration 125 not applied yet.
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [offline, router])

  const toggle = (set: Set<string>, code: string): Set<string> => {
    const next = new Set(set)
    if (next.has(code)) next.delete(code); else next.add(code)
    return next
  }

  async function handleSave() {
    if (!userId || saving || !draft.trim() || draftLangs.size === 0) return
    setSaving(true)
    setError(null)
    try {
      const entry = await new SupabaseJournalRepository().create(userId, {
        content: draft.trim(),
        // Keep the chip order (learned first) rather than insertion order.
        languages: langOptions.filter(c => draftLangs.has(c)),
      })
      setEntries(prev => [entry, ...prev])
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  function startEdit(entry: JournalEntry) {
    setEditingId(entry.id)
    setEditText(entry.content)
    setEditLangs(new Set(entry.languages))
    setConfirmDeleteId(null)
  }

  async function handleEditSave() {
    if (!editingId || !editText.trim() || editLangs.size === 0) return
    setError(null)
    try {
      const updated = await new SupabaseJournalRepository().update(editingId, {
        content: editText.trim(),
        languages: langOptions.filter(c => editLangs.has(c)),
      })
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e))
      setEditingId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDelete(id: string) {
    setError(null)
    try {
      await new SupabaseJournalRepository().softDelete(id)
      setEntries(prev => prev.filter(e => e.id !== id))
      setConfirmDeleteId(null)
      if (editingId === id) setEditingId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const totalWords = useMemo(() => entries.reduce((s, e) => s + wordCount(e.content), 0), [entries])

  if (offline) return <OfflineUnavailable feature="Journal" />
  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading journal…</div>

  return (
    <div className="space-y-6 max-w-2xl mx-auto pb-12">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Journal</h1>
        <p className="text-sm text-ink-muted mt-1">
          Free writing practice. Tag each entry with the language(s) you wrote it in.
          Nothing here changes your review schedule.
        </p>
      </div>

      {/* Composer */}
      <div className="panel space-y-3">
        <textarea
          className="input min-h-[140px] resize-y text-[15px] leading-relaxed"
          placeholder="Write in the language you're learning…"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Written in</p>
            <LanguageChips options={langOptions} selected={draftLangs}
              onToggle={code => setDraftLangs(prev => toggle(prev, code))} />
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <span className="text-xs text-ink-faint">{wordCount(draft)} word{wordCount(draft) === 1 ? '' : 's'}</span>
            <button className="btn-primary text-sm px-5 disabled:opacity-40" onClick={() => void handleSave()}
              disabled={saving || !draft.trim() || draftLangs.size === 0}
              title={draftLangs.size === 0 ? 'Pick the language(s) you wrote in' : undefined}>
              {saving ? 'Saving…' : 'Save entry'}
            </button>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {/* Past entries */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium text-ink">Entries</h2>
          {entries.length > 0 && (
            <span className="text-xs text-ink-faint">
              {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} · {totalWords} words
            </span>
          )}
        </div>

        {entries.length === 0 && (
          <div className="panel text-sm text-ink-muted text-center py-8">
            No entries yet — your first one goes right above.
          </div>
        )}

        {entries.map(entry => (
          <div key={entry.id} className="panel space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-ink-faint">
                {new Date(entry.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                {' · '}{entry.languages.map(c => `${langFlag(c)} ${langName(c)}`).join(' · ')}
                {' · '}{wordCount(entry.content)} word{wordCount(entry.content) === 1 ? '' : 's'}
              </span>
              <div className="flex items-center gap-2 text-xs">
                {confirmDeleteId === entry.id ? (
                  <>
                    <span className="text-ink-muted">Delete?</span>
                    <button className="text-danger hover:underline" onClick={() => void handleDelete(entry.id)}>Yes</button>
                    <button className="text-ink-faint hover:text-ink" onClick={() => setConfirmDeleteId(null)}>No</button>
                  </>
                ) : (
                  <>
                    <button className="text-ink-faint hover:text-ink" onClick={() => startEdit(entry)}>Edit</button>
                    <button className="text-ink-faint hover:text-danger" onClick={() => { setConfirmDeleteId(entry.id); setEditingId(null) }}>Delete</button>
                  </>
                )}
              </div>
            </div>

            {editingId === entry.id ? (
              <div className="space-y-3">
                <textarea className="input min-h-[120px] resize-y text-[15px] leading-relaxed"
                  value={editText} onChange={e => setEditText(e.target.value)} />
                <LanguageChips options={langOptions} selected={editLangs}
                  onToggle={code => setEditLangs(prev => toggle(prev, code))} />
                <div className="flex items-center gap-2">
                  <button className="btn-primary text-sm px-4 disabled:opacity-40" onClick={() => void handleEditSave()}
                    disabled={!editText.trim() || editLangs.size === 0}>Save</button>
                  <button className="btn-ghost text-sm" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <p className="text-[15px] leading-relaxed text-ink whitespace-pre-wrap">{entry.content}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
