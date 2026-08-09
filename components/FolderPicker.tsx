'use client'

/**
 * components/FolderPicker.tsx — "save this somewhere" as a mini library you walk into.
 *
 * Replaces a flat `<select>` built from `buildFolderOptions`. That list carried its nesting as
 * `'  '.repeat(depth)` on each `<option>`, and browsers COLLAPSE whitespace inside an option — so a
 * five-level tree rendered as one flush-left column and "Nouns" appeared twice with nothing to say
 * which was which. Depth has to be structural, not typographic.
 *
 * Interaction is deliberately unambiguous: a row NAVIGATES into that folder, and the pinned row at
 * the top SELECTS wherever you currently are. Making a row do both (click to pick, chevron to
 * descend) puts two meanings on one target, which is exactly how you end up saving a deck into the
 * wrong folder.
 *
 * A new folder is created **inside the folder you're standing in**, which is the whole point of
 * navigating there. The old picker always created at the root regardless.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { folderMatchesPair, descendantDeckIds } from '@/lib/folderStats'
import type { Deck, Folder } from '@/domain'

export function FolderPicker({
  folders, decks, sourceLanguage, targetLanguage, rootLabel,
  value, onChange, creating, onCreatingChange,
}: {
  folders: Folder[]
  decks: Deck[]
  sourceLanguage: string
  targetLanguage: string
  /** What the pairing root is called, e.g. "Spanish / English — root". */
  rootLabel: string
  /** Selected folder id, or null for the pairing root. */
  value: string | null
  onChange: (folderId: string | null) => void
  /** True while the caller is collecting a new folder's name (its input lives outside). */
  creating: boolean
  onCreatingChange: (creating: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  /** Which folder the list is currently showing the contents of. Null = the pairing root. */
  const [browsing, setBrowsing] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // Folders belonging to this pairing. Empty synced folders are auto-managed leftovers and were
  // never a valid destination — same exclusion `buildFolderOptions` made.
  const scoped = useMemo(() => folders.filter(f => {
    if (!folderMatchesPair(f.id, folders, decks, sourceLanguage, targetLanguage)) return false
    if (f.isSynced && descendantDeckIds(f.id, folders, decks).length === 0) return false
    return true
  }), [folders, decks, sourceLanguage, targetLanguage])

  const byParent = useMemo(() => {
    const map = new Map<string | null, Folder[]>()
    for (const f of scoped) {
      const arr = map.get(f.parentId) ?? []
      arr.push(f)
      map.set(f.parentId, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position)
    return map
  }, [scoped])

  const byId = useMemo(() => new Map(scoped.map(f => [f.id, f])), [scoped])

  /** Root → … → folder, for the breadcrumb. Stops if a parent is outside the pairing. */
  const pathTo = (id: string | null): Folder[] => {
    const out: Folder[] = []
    let cur = id ? byId.get(id) : undefined
    while (cur) {
      out.unshift(cur)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return out
  }

  // Open where the current selection lives, so what's already chosen is visible rather than
  // requiring the user to re-find it.
  useEffect(() => {
    if (open) setBrowsing(value ? (byId.get(value)?.parentId ?? null) : null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  const selectedPath = pathTo(value)
  const summary = creating
    ? 'New folder…'
    : value == null
      ? rootLabel
      : selectedPath.map(f => f.name).join(' / ') || rootLabel

  const browsePath = pathTo(browsing)
  const children = byParent.get(browsing) ?? []

  function pick(id: string | null) {
    onCreatingChange(false)
    onChange(id)
    setOpen(false)
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="input text-sm w-full text-left flex items-center justify-between gap-2"
      >
        <span className="truncate">{summary}</span>
        <span className="text-ink-faint shrink-0">▾</span>
      </button>

      {open && (
        <div className="absolute z-40 mt-1 w-full min-w-[18rem] max-h-80 overflow-y-auto rounded-md border border-line/20 bg-surface shadow-lg p-1">
          {/* Breadcrumb — every crumb walks back up. */}
          <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 text-xs text-ink-faint">
            <button type="button" className="hover:text-ink" onClick={() => setBrowsing(null)}>
              {rootLabel}
            </button>
            {browsePath.map(f => (
              <span key={f.id} className="flex items-center gap-1">
                <span>/</span>
                <button type="button" className="hover:text-ink" onClick={() => setBrowsing(f.id)}>{f.name}</button>
              </span>
            ))}
          </div>

          {/* Selecting is always THIS row, never a folder row — one meaning per target. */}
          <button
            type="button"
            onClick={() => pick(browsing)}
            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center justify-between gap-2 ${
              value === browsing && !creating ? 'bg-accent text-white' : 'text-ink hover:bg-surface/60'}`}
          >
            <span className="truncate">
              Save here — {browsing == null ? rootLabel : (byId.get(browsing)?.name ?? rootLabel)}
            </span>
            {value === browsing && !creating && <span className="shrink-0">✓</span>}
          </button>

          {children.length > 0 && <div className="border-t border-line/10 my-1" />}

          {children.map(f => {
            const deckCount = descendantDeckIds(f.id, folders, decks).length
            const subCount = (byParent.get(f.id) ?? []).length
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setBrowsing(f.id)}
                className="w-full text-left px-2 py-1.5 rounded text-sm text-ink hover:bg-surface/60 flex items-center justify-between gap-2"
              >
                <span className="truncate">📁 {f.name}</span>
                <span className="text-xs text-ink-faint shrink-0">
                  {subCount > 0 && `${subCount} folder${subCount === 1 ? '' : 's'} · `}
                  {deckCount} deck{deckCount === 1 ? '' : 's'} ›
                </span>
              </button>
            )
          })}

          <div className="border-t border-line/10 my-1" />
          <button
            type="button"
            onClick={() => {
              // The new folder lands INSIDE wherever you navigated to — that's why you navigated.
              onChange(browsing)
              onCreatingChange(true)
              setOpen(false)
            }}
            className="w-full text-left px-2 py-1.5 rounded text-sm text-ink-muted hover:text-ink hover:bg-surface/60"
          >
            + New folder in {browsing == null ? rootLabel : (byId.get(browsing)?.name ?? rootLabel)}…
          </button>
        </div>
      )}
    </div>
  )
}
