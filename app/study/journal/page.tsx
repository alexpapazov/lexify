'use client'

/**
 * /study/journal — free-writing practice, second pass (2026-09-21).
 *
 * Two views. The LIST is the menu: one card per entry (created day, edited days, languages, word
 * count, preview) plus "New entry". Opening an entry — or starting a new one — takes over the
 * WHOLE SCREEN (fixed overlay, safe-area aware): a top bar with Back / language chips / Save, and
 * the writing area filling everything else.
 *
 * History: every save of an existing entry pushes the prior text onto `revisions` (migration 126),
 * so an entry keeps the day it was created, every day it was edited, and every version. The
 * editor's History panel shows word-level diffs between adjacent versions (green = added,
 * red struck = removed), derived on render by lib/textDiff.ts — snapshots stored, diffs computed.
 *
 * Explicit Save (an editor, like the ladder/goal editors — not auto-save); Back with unsaved
 * changes asks first. Schedule-neutral: nothing here touches reviews or goals.
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseJournalRepository } from '@/lib/data/journal'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { langFlag, langName } from '@/lib/languages'
import { diffWords, diffStats } from '@/lib/textDiff'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import type { JournalEntry } from '@/domain'

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

function LanguageChips({ options, selected, onToggle }: {
  options: string[]
  selected: Set<string>
  onToggle: (code: string) => void
}) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {options.map(code => (
        <button key={code} type="button" onClick={() => onToggle(code)}
          className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
            selected.has(code) ? 'border-accent text-accent bg-accent/10' : 'border-line/20 text-ink-muted hover:text-ink'
          }`}>
          {langFlag(code)} {langName(code)}
        </button>
      ))}
    </div>
  )
}

/** One edit in the History panel: when, ±word counts, and the inline word diff. */
function RevisionDiff({ from, to, when }: { from: string; to: string; when: string }) {
  const segments = useMemo(() => diffWords(from, to), [from, to])
  const stats = segments ? diffStats(segments) : null
  return (
    <div className="rounded border border-line/10 bg-surface-raised/50 px-3 py-2 space-y-1.5">
      <p className="text-xs text-ink-faint">
        {day(when)}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="ml-2">
            {stats.added > 0 && <span className="text-success">+{stats.added} word{stats.added === 1 ? '' : 's'}</span>}
            {stats.added > 0 && stats.removed > 0 && ' · '}
            {stats.removed > 0 && <span className="text-danger">−{stats.removed} word{stats.removed === 1 ? '' : 's'}</span>}
          </span>
        )}
      </p>
      {segments ? (
        <p className="text-sm leading-relaxed">
          {segments.map((s, i) =>
            s.type === 'same' ? <span key={i} className="text-ink-muted">{s.text} </span>
            : s.type === 'added' ? <span key={i} className="text-success">{s.text} </span>
            : <span key={i} className="text-danger line-through decoration-danger/60">{s.text} </span>)}
        </p>
      ) : (
        // Above the diff size cap — show the version this edit produced instead of freezing.
        <p className="text-sm text-ink-muted whitespace-pre-wrap">{to}</p>
      )}
    </div>
  )
}

export default function JournalPage() {
  const offline = useOfflineMode()
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [langOptions, setLangOptions] = useState<string[]>([])
  const [defaultLang, setDefaultLang] = useState<string | null>(null)
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Editor overlay: null = list view; 'new' = composing; an id = editing that entry.
  const [openId, setOpenId] = useState<'new' | string | null>(null)
  const [text, setText] = useState('')
  const [notes, setNotes] = useState('')
  const [langs, setLangs] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
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
        const learned = pairs.map(p => p.sourceLanguage)
        const native  = pairs.map(p => p.targetLanguage)
        setLangOptions([...new Set([...learned, ...native])])
        if (new Set(learned).size === 1 && learned[0]) setDefaultLang(learned[0])
        setEntries(list)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [offline, router])

  const openEntry = openId && openId !== 'new' ? entries.find(e => e.id === openId) ?? null : null
  const dirty = openId === 'new'
    ? text.trim() !== '' || notes.trim() !== ''
    : !!openEntry && (text !== openEntry.content || notes !== (openEntry.notes ?? '')
        || [...langs].sort().join() !== [...openEntry.languages].sort().join())

  function openNew() {
    setOpenId('new')
    setText('')
    setNotes('')
    setLangs(defaultLang ? new Set([defaultLang]) : new Set())
    setShowHistory(false)
    setError(null)
  }

  function openExisting(entry: JournalEntry) {
    setOpenId(entry.id)
    setText(entry.content)
    setNotes(entry.notes ?? '')
    setLangs(new Set(entry.languages))
    setShowHistory(false)
    setError(null)
  }

  function closeEditor() {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    setOpenId(null)
  }

  async function handleSave() {
    if (!userId || saving || !text.trim() || langs.size === 0) return
    setSaving(true)
    setError(null)
    const repo = new SupabaseJournalRepository()
    const orderedLangs = langOptions.filter(c => langs.has(c))
    try {
      if (openId === 'new') {
        const entry = await repo.create(userId, { content: text.trim(), languages: orderedLangs, notes: notes.trim() || null })
        setEntries(prev => [entry, ...prev])
        setOpenId(entry.id)
      } else if (openEntry) {
        // The prior version joins the history — `editedAt` is the moment it was replaced. A save
        // that changed only the languages records no text revision (there's no diff to keep).
        const revisions = text.trim() !== openEntry.content
          ? [...openEntry.revisions, { content: openEntry.content, editedAt: new Date().toISOString() }]
          : openEntry.revisions
        // Notes are a scratchpad, not prose — they save with the entry but keep no revision trail.
        const updated = await repo.update(openEntry.id, { content: text.trim(), languages: orderedLangs, notes: notes.trim() || null, revisions })
        setEntries(prev => prev.map(e => e.id === updated.id ? updated : e))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setError(null)
    try {
      await new SupabaseJournalRepository().softDelete(id)
      setEntries(prev => prev.filter(e => e.id !== id))
      setConfirmDeleteId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** "Created Sep 20 · edited Sep 21, Sep 23" — distinct days only, from the revision timestamps. */
  function editedLine(entry: JournalEntry): string {
    const days = [...new Set(entry.revisions.map(r => day(r.editedAt)))]
    return days.length === 0 ? `Created ${day(entry.createdAt)}` : `Created ${day(entry.createdAt)} · edited ${days.join(', ')}`
  }

  const totalWords = useMemo(() => entries.reduce((s, e) => s + wordCount(e.content), 0), [entries])

  if (offline) return <OfflineUnavailable feature="Journal" />
  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading journal…</div>

  // ── Full-screen editor ────────────────────────────────────────────────────────
  if (openId !== null) {
    // Versions for the history panel: every save's diff, newest edit first. Version i's text is
    // revisions[i].content; the text it BECAME is the next revision's content (or the live text).
    const history = openEntry ? openEntry.revisions.map((rev, i) => ({
      from: rev.content,
      to: openEntry.revisions[i + 1]?.content ?? openEntry.content,
      when: rev.editedAt,
    })).reverse() : []

    return (
      <div className="fixed inset-0 z-[60] bg-surface-deep flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line/10">
          <button className="text-sm text-ink-muted hover:text-ink shrink-0" onClick={closeEditor}>← Entries</button>
          <span className="text-xs text-ink-faint truncate">
            {openEntry ? editedLine(openEntry) : 'New entry'}
          </span>
          <button className="btn-primary text-sm px-5 disabled:opacity-40 shrink-0" onClick={() => void handleSave()}
            disabled={saving || !text.trim() || langs.size === 0 || !dirty}
            title={langs.size === 0 ? 'Pick the language(s) you wrote in' : undefined}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>

        {/* Languages + word count */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-line/5 flex-wrap">
          <LanguageChips options={langOptions} selected={langs}
            onToggle={code => setLangs(prev => { const n = new Set(prev); if (n.has(code)) n.delete(code); else n.add(code); return n })} />
          <div className="flex items-center gap-3 ml-auto">
            <span className="text-xs text-ink-faint">{wordCount(text)} word{wordCount(text) === 1 ? '' : 's'}</span>
            {openEntry && openEntry.revisions.length > 0 && (
              <button className={`text-xs ${showHistory ? 'text-accent' : 'text-ink-faint hover:text-ink'}`}
                onClick={() => setShowHistory(v => !v)}>
                History ({openEntry.revisions.length})
              </button>
            )}
          </div>
        </div>

        {error && <p className="px-4 py-2 text-sm text-danger">{error}</p>}

        {/* Writing area fills the rest of the screen; History slides in beside/instead on toggle. */}
        {showHistory && openEntry ? (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
            <p className="text-xs text-ink-faint">
              Every save keeps the previous version — green was added by that edit, struck red was removed.
            </p>
            {history.map((h, i) => <RevisionDiff key={i} from={h.from} to={h.to} when={h.when} />)}
            <button className="text-xs text-ink-faint hover:text-ink" onClick={() => setShowHistory(false)}>← Back to writing</button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            <textarea
              className="flex-1 w-full bg-transparent px-4 py-3 text-[16px] leading-relaxed text-ink outline-none resize-none"
              placeholder="Write in the language you're learning…"
              value={text}
              onChange={e => setText(e.target.value)}
              autoFocus
            />
            {/* Side notes: new words / grammar spotted while writing. Just a field for now —
                functionality on top of it is planned. */}
            <div className="border-t border-line/10 px-4 py-2 space-y-1">
              <label className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider">
                Notes — new words, grammar, things to remember
              </label>
              <textarea
                className="w-full bg-transparent text-sm leading-relaxed text-ink outline-none resize-none min-h-[64px] max-h-[20vh]"
                placeholder="e.g. сътворявам — to create · все пак = after all"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── List view (the entries menu) ──────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-2xl mx-auto pb-12">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Journal</h1>
          <p className="text-sm text-ink-muted mt-1">
            Free writing practice — every entry keeps its full edit history.
          </p>
        </div>
        <button className="btn-primary text-sm px-5 shrink-0" onClick={openNew}>New entry</button>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {entries.length === 0 ? (
        <div className="panel text-sm text-ink-muted text-center py-10">
          No entries yet — start your first one.
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-faint text-right">{entries.length} entr{entries.length === 1 ? 'y' : 'ies'} · {totalWords} words</p>
          {entries.map(entry => (
            <div key={entry.id} className="panel space-y-1.5 cursor-pointer hover:border-line/20 transition-colors"
              onClick={() => openExisting(entry)}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-ink-faint">{editedLine(entry)}</span>
                <div className="flex items-center gap-2 text-xs shrink-0" onClick={e => e.stopPropagation()}>
                  <span className="text-ink-faint">{entry.languages.map(c => langFlag(c)).join(' ')} · {wordCount(entry.content)} w</span>
                  {confirmDeleteId === entry.id ? (
                    <>
                      <span className="text-ink-muted">Delete?</span>
                      <button className="text-danger hover:underline" onClick={() => void handleDelete(entry.id)}>Yes</button>
                      <button className="text-ink-faint hover:text-ink" onClick={() => setConfirmDeleteId(null)}>No</button>
                    </>
                  ) : (
                    <button className="text-ink-faint hover:text-danger" onClick={() => setConfirmDeleteId(entry.id)}>Delete</button>
                  )}
                </div>
              </div>
              <p className="text-sm text-ink-muted line-clamp-3 whitespace-pre-wrap">{entry.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
