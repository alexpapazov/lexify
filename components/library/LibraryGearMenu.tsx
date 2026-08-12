'use client'

/**
 * components/library/LibraryGearMenu.tsx — the ⚙ dropdown shared by every library level.
 *
 * The language pair, a folder, and a deck all need the same two things (label the cards, export the
 * subtree) plus their own extras, so those two live here and each caller passes its own `items`.
 * Keeping one component means the export format and the labeling scope can't drift between levels.
 *
 * **Export and labeling both take a SCOPE, not "everything"** — exporting from a deck must not dump
 * the whole library, and labeling from a folder must not spend model calls on unrelated decks.
 */

import { useEffect, useRef, useState } from 'react'
import type { Deck, Folder, UserId } from '@/domain'
import {
  buildLibraryExport, renderLibraryText, buildLibraryDocx, openLibraryPdf,
  exportFilename, downloadTextFile, downloadBlob,
  type ExportScope, type ExportFormat,
} from '@/lib/libraryExport'
import { labelCards } from '@/lib/labelCards'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { getToday } from '@/lib/dates'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'

export interface GearItem {
  label:     string
  onSelect:  () => void
  danger?:   boolean
  disabled?: boolean
  title?:    string
}

export function LibraryGearMenu({
  title, items = [], exportScope, folders, decks, userId, labelScopeDeckIds,
}: {
  title:  string
  /** Level-specific entries, rendered above the shared Label / Export actions. */
  items?: GearItem[]
  exportScope: ExportScope
  folders: Folder[]
  decks:   Deck[]
  userId:  UserId
  /** Decks the labeling pass may touch. Empty disables the action. */
  labelScopeDeckIds: string[]
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'export' | 'label' | null>(null)
  /** Second-level menu: pick a format once Export is chosen. */
  const [formatOpen, setFormatOpen] = useState(false)
  const [msg, setMsg]   = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const offline = useOfflineMode()

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setFormatOpen(false) }
    }
    function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') { setOpen(false); setFormatOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc) }
  }, [open])

  async function handleExport(format: ExportFormat) {
    if (busy) return
    setBusy('export'); setMsg(null); setOpen(false); setFormatOpen(false)
    try {
      const on = getToday(deviceTimeZone(), 0)
      const tree = await buildLibraryExport(exportScope, folders, decks, userId)

      if (format === 'clipboard') {
        await navigator.clipboard.writeText(renderLibraryText(tree, on))
        setMsg('Copied to clipboard.')
      } else if (format === 'text') {
        downloadTextFile(exportFilename(tree.title, on, 'txt'), renderLibraryText(tree, on))
        setMsg('Exported .txt')
      } else if (format === 'docx') {
        downloadBlob(exportFilename(tree.title, on, 'docx'), await buildLibraryDocx(tree, on))
        setMsg('Exported .docx')
      } else {
        // Printing is the PDF path — see openLibraryPdf for why this isn't a hand-built PDF.
        setMsg(openLibraryPdf(tree, on)
          ? 'Opened the print dialog — choose "Save as PDF".'
          : 'Allow pop-ups for this site to export a PDF.')
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  async function handleLabel() {
    if (busy || !userId) return
    setBusy('label'); setMsg(null); setProgress(null); setOpen(false)
    try {
      // Only cards in scope that aren't labeled yet — the model call is the expensive part, and a
      // second run must not re-pay for cards a first run already did.
      const inScope = new Set(labelScopeDeckIds)
      const byDeck = await new SupabaseCardRepository().listForDecks([...inScope])
      const seen = new Set<string>()
      const unlabeled: { id: string; front: string; back: string; sourceLanguage: string; targetLanguage: string }[] = []
      for (const cards of byDeck.values()) {
        for (const c of cards) {
          if (c.pos || seen.has(c.id)) continue   // a shared card appears under several decks
          seen.add(c.id)
          unlabeled.push({ id: c.id, front: c.front, back: c.back, sourceLanguage: c.sourceLanguage, targetLanguage: c.targetLanguage })
        }
      }
      if (unlabeled.length === 0) { setMsg('Every card here is already labeled.'); return }
      setProgress({ done: 0, total: unlabeled.length })
      const res = await labelCards(unlabeled, (done, total) => setProgress({ done, total }))
      setMsg(res.failedCount === 0
        ? `Labeled ${res.labeledCount} card${res.labeledCount === 1 ? '' : 's'}.`
        : `Labeled ${res.labeledCount}; ${res.failedCount} couldn’t be labeled — run again to retry.`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null); setProgress(null) }
  }

  const itemClass = (danger?: boolean) =>
    `w-full text-left px-4 py-2 text-sm transition-colors hover:bg-line/5 disabled:opacity-50 ${danger ? 'text-danger/80' : 'text-ink'}`

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => { setOpen(v => !v); setFormatOpen(false) }}
        title={title}
        aria-label={title}
        className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-raised transition-colors"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* Progress / result, shown next to the gear so it survives the menu closing. */}
      {(busy || msg) && (
        <span className="absolute right-full top-1.5 mr-2 whitespace-nowrap text-xs text-ink-faint">
          {busy === 'export' ? 'Building export…'
            : busy === 'label' ? (progress ? `Labeling ${progress.done}/${progress.total}…` : 'Labeling…')
            : msg}
        </span>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 bg-surface-raised border border-line/10 rounded-lg py-1 w-64 shadow-xl">
          {items.map(item => (
            <button key={item.label} disabled={item.disabled} title={item.title}
              onClick={() => { setOpen(false); item.onSelect() }}
              className={itemClass(item.danger)}>
              {item.label}
            </button>
          ))}
          {items.length > 0 && <div className="my-1 border-t border-line/10" />}
          <button
            onClick={() => void handleLabel()}
            disabled={!!busy || offline || labelScopeDeckIds.length === 0}
            title={offline ? 'Labeling needs a connection' : 'Tag each card with its part of speech and dictionary form, so Practice can build sentences from it'}
            className={itemClass()}
          >
            Label cards…
          </button>
          <button onClick={() => setFormatOpen(v => !v)} disabled={!!busy} className={itemClass()}
            title="Folders, subfolders, decks and their cards, in the format you pick">
            <span className="flex items-center justify-between gap-2">
              Export…
              <span className={`text-ink-faint transition-transform ${formatOpen ? 'rotate-90' : ''}`}>›</span>
            </span>
          </button>
          {formatOpen && (
            <div className="border-t border-line/10 mt-1 pt-1">
              {([
                ['clipboard', 'Copy as text',       'Plain text on the clipboard, ready to paste'],
                ['text',      'Download .txt',      'Plain text file'],
                ['docx',      'Download Word .docx','Opens in Word, Pages or Google Docs'],
                ['pdf',       'Save as PDF…',       'Opens the print dialog — choose "Save as PDF"'],
              ] as const).map(([fmt, label, hint]) => (
                <button key={fmt} onClick={() => void handleExport(fmt)} disabled={!!busy} title={hint}
                  className={`${itemClass()} pl-7`}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
