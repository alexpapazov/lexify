/**
 * lib/libraryExport.ts — export a language pair, a folder, or a single deck.
 *
 * Four outputs, one tree: copy to clipboard, download .txt, download .docx, or print to PDF. The
 * shape mirrors the LIBRARY TREE — folders nest, decks sit inside their folder, cards under the deck.
 * A nested structure is exactly what CSV cannot express, which is why none of these is a spreadsheet.
 *
 * `renderLibraryText` is PURE and takes an already-assembled tree, so the shape is unit-testable
 * without a database. `buildLibraryExport` does the loading.
 */

import type { Card, Deck, Folder, UserId } from '@/domain'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { descendantDeckIds } from '@/lib/folderStats'
import { displayText } from '@/lib/cardText'
import { langName } from '@/lib/languages'
import { buildDocx, type DocxLine } from '@/lib/docxWrite'

const INDENT = '    '

export interface ExportDeck { name: string; cards: { front: string; back: string }[] }
export interface ExportFolder { name: string; folders: ExportFolder[]; decks: ExportDeck[] }

export interface ExportTree {
  /** Heading — the pair, the folder name, or the deck name. */
  title:   string
  folders: ExportFolder[]
  /** Decks not inside any folder in this scope (the scope's own root). */
  decks:   ExportDeck[]
}

function countTree(t: ExportTree): { folders: number; decks: number; cards: number } {
  let folders = 0, decks = 0, cards = 0
  const walkDecks = (ds: ExportDeck[]) => { for (const d of ds) { decks++; cards += d.cards.length } }
  const walk = (fs: ExportFolder[]) => {
    for (const f of fs) { folders++; walkDecks(f.decks); walk(f.folders) }
  }
  walk(t.folders); walkDecks(t.decks)
  return { folders, decks, cards }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The tree as indented plain text.
 *
 * Folders end in `/` and decks carry their card count, so the two are never ambiguous at a glance
 * even though both are just indented names. Card text goes through `displayText`, the same helper
 * the study screens use, so a back stored as a quoted literal doesn't leak its quotes into the file.
 */
export function renderLibraryText(tree: ExportTree, exportedOn: string): string {
  const { folders, decks, cards } = countTree(tree)
  const out: string[] = [
    tree.title,
    `Exported ${exportedOn} · ${plural(folders, 'folder')} · ${plural(decks, 'deck')} · ${plural(cards, 'card')}`,
    '',
  ]

  const writeDeck = (deck: ExportDeck, depth: number) => {
    out.push(`${INDENT.repeat(depth)}${deck.name}  [${plural(deck.cards.length, 'card')}]`)
    for (const c of deck.cards) {
      out.push(`${INDENT.repeat(depth + 1)}${displayText(c.front)} = ${displayText(c.back)}`)
    }
    out.push('')
  }

  const writeFolder = (folder: ExportFolder, depth: number) => {
    out.push(`${INDENT.repeat(depth)}${folder.name}/`)
    for (const d of folder.decks)  writeDeck(d, depth + 1)
    for (const f of folder.folders) writeFolder(f, depth + 1)
  }

  for (const f of tree.folders) writeFolder(f, 0)
  for (const d of tree.decks)   writeDeck(d, 0)

  if (folders === 0 && decks === 0) out.push('(empty)')
  return out.join('\n')
}

/** What to export. A deck exports itself; a folder exports its subtree; a pair exports everything. */
export type ExportScope =
  | { kind: 'pair';   sourceLanguage: string; targetLanguage: string }
  | { kind: 'folder'; folderId: string }
  | { kind: 'deck';   deckId: string }

/**
 * Assembles the tree for `scope` from the library's folders and decks.
 *
 * `allFolders`/`allDecks` are passed in because every caller already has them loaded — re-fetching
 * would double the page's queries just to export. Only the CARDS are fetched here, in one paged
 * query for the whole scope (`listForDecks`), which also skips the audio blobs.
 */
export async function buildLibraryExport(
  scope: ExportScope,
  allFolders: Folder[],
  allDecks: Deck[],
  _userId: UserId,
): Promise<ExportTree> {
  const deckById = new Map(allDecks.map(d => [d.id, d]))

  // Which decks and folders are in scope.
  let scopedDecks: Deck[]
  let rootFolders: Folder[]
  let title: string

  if (scope.kind === 'deck') {
    const deck = deckById.get(scope.deckId)
    scopedDecks = deck ? [deck] : []
    rootFolders = []
    title = deck ? deck.name : 'Deck'
  } else if (scope.kind === 'folder') {
    const folder = allFolders.find(f => f.id === scope.folderId)
    const ids = new Set(descendantDeckIds(scope.folderId, allFolders, allDecks))
    scopedDecks = allDecks.filter(d => ids.has(d.id))
    rootFolders = allFolders.filter(f => f.parentId === scope.folderId)
    title = folder ? folder.name : 'Folder'
  } else {
    scopedDecks = allDecks.filter(d =>
      d.sourceLanguage === scope.sourceLanguage && d.targetLanguage === scope.targetLanguage)
    const scopedDeckIds = new Set(scopedDecks.map(d => d.id))
    // A folder belongs to this pair if it says so, or if it holds any of the pair's decks — the same
    // permissive rule the library view uses, so the export matches what's on screen.
    const inPair = (f: Folder) =>
      (f.sourceLanguage === scope.sourceLanguage && f.targetLanguage === scope.targetLanguage) ||
      descendantDeckIds(f.id, allFolders, allDecks).some(id => scopedDeckIds.has(id))
    rootFolders = allFolders.filter(f => f.parentId === null && inPair(f))
    title = `${langName(scope.sourceLanguage)} → ${langName(scope.targetLanguage)}`
  }

  const cardsByDeck = await new SupabaseCardRepository().listForDecks(scopedDecks.map(d => d.id))
  const scopedIds = new Set(scopedDecks.map(d => d.id))
  const toExportDeck = (d: Deck): ExportDeck => ({
    name: d.name,
    cards: (cardsByDeck.get(d.id) ?? []).map((c: Card) => ({ front: c.front, back: c.back })),
  })
  const byPosition = (a: { position?: number; name: string }, b: { position?: number; name: string }) =>
    (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name)

  const buildFolder = (f: Folder): ExportFolder => ({
    name: f.name,
    decks: allDecks.filter(d => d.folderId === f.id && scopedIds.has(d.id)).sort(byPosition).map(toExportDeck),
    folders: allFolders.filter(c => c.parentId === f.id).sort(byPosition).map(buildFolder),
  })

  // Decks sitting directly at the scope's root (no folder for a pair; this folder for a folder scope).
  const rootDeckParent = scope.kind === 'folder' ? scope.folderId : null
  const decks = scope.kind === 'deck'
    ? scopedDecks.map(toExportDeck)
    : allDecks.filter(d => d.folderId === rootDeckParent && scopedIds.has(d.id)).sort(byPosition).map(toExportDeck)

  return { title, folders: rootFolders.sort(byPosition).map(buildFolder), decks }
}

/** Filesystem-safe filename from an arbitrary title. Non-Latin titles collapse to 'lexify'. */
export function exportFilename(title: string, on: string, ext: 'txt' | 'docx'): string {
  const stem = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lexify'
  return `${stem}-${on}.${ext}`
}

/** Triggers a browser download of `text`. No-op server-side. */
export function downloadTextFile(filename: string, text: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick — revoking synchronously can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// ─── Formats ─────────────────────────────────────────────────────────────────

export type ExportFormat = 'text' | 'clipboard' | 'docx' | 'pdf'

/**
 * The tree as styled lines, shared by the .docx and PDF renderers.
 *
 * Sizes DESCEND with depth and names are bold — which is exactly the heading signal
 * `parseDeckPlan` looks for in a document with no Word heading styles, so an exported library
 * re-imports as the same tree through batch import. Keep names bold and cards plain if you change
 * this, or that round-trip silently breaks.
 */
export function renderLibraryLines(tree: ExportTree, exportedOn: string): DocxLine[] {
  const { folders, decks, cards } = countTree(tree)
  const lines: DocxLine[] = [
    { text: tree.title, bold: true, size: 20 },
    { text: `Exported ${exportedOn} · ${plural(folders, 'folder')} · ${plural(decks, 'deck')} · ${plural(cards, 'card')}`, size: 9 },
    { text: '' },
  ]
  // Deck/card sizes are flat; only FOLDER depth steps down, so a deep tree can't reach 0pt.
  const folderSize = (depth: number) => Math.max(12, 17 - depth * 2)

  const writeDeck = (deck: ExportDeck, depth: number) => {
    // The deck NAME stays clean — the count goes on its own line. Appending "[12 cards]" to the name
    // made a re-imported deck literally called "School  [12 cards]" (caught by the round-trip test),
    // and the count line is ignored on re-import because it has no `=` separator.
    lines.push({ text: deck.name, bold: true, size: 11.5, indent: depth })
    lines.push({ text: plural(deck.cards.length, 'card'), size: 8.5, indent: depth })
    for (const c of deck.cards) {
      lines.push({ text: `${displayText(c.front)} = ${displayText(c.back)}`, size: 10.5, indent: depth + 1 })
    }
    lines.push({ text: '' })
  }
  const writeFolder = (folder: ExportFolder, depth: number) => {
    lines.push({ text: folder.name, bold: true, size: folderSize(depth), indent: depth })
    for (const d of folder.decks)   writeDeck(d, depth + 1)
    for (const f of folder.folders) writeFolder(f, depth + 1)
  }
  for (const f of tree.folders) writeFolder(f, 0)
  for (const d of tree.decks)   writeDeck(d, 0)
  return lines
}

/** The .docx blob for a tree. */
export function buildLibraryDocx(tree: ExportTree, exportedOn: string): Promise<Blob> {
  return buildDocx(renderLibraryLines(tree, exportedOn))
}

/** Triggers a download of an already-built Blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const escHtml = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Opens the export in a print window so the browser can save it as PDF.
 *
 * **Deliberately not a hand-written PDF.** A PDF built without an embedded font can only use the
 * base-14 fonts, which are Latin-1 — Korean, Greek, Cyrillic and Chinese would all render as
 * garbage, and this library is mostly those. Embedding a CJK-capable font would mean shipping
 * megabytes of font data. Printing hands the job to the OS, which already has the right fonts, and
 * the user picks "Save as PDF" in the dialog they already know.
 *
 * Returns false if the popup was blocked, so the caller can say so instead of appearing to do nothing.
 */
export function openLibraryPdf(tree: ExportTree, exportedOn: string): boolean {
  if (typeof window === 'undefined') return false
  const win = window.open('', '_blank')
  if (!win) return false

  const body = renderLibraryLines(tree, exportedOn).map(l => {
    if (!l.text) return '<div class="sp"></div>'
    const style = `margin-left:${(l.indent ?? 0) * 1.25}em;font-size:${l.size ?? 11}pt;${l.bold ? 'font-weight:600;' : ''}`
    return `<div style="${style}">${escHtml(l.text)}</div>`
  }).join('')

  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(tree.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #111; margin: 2.5em; line-height: 1.45; }
  .sp { height: .6em; }
  @page { margin: 1.6cm; }
</style></head><body>${body}</body></html>`)
  win.document.close()
  // Let layout settle before the dialog opens, or the first page can print blank.
  win.setTimeout(() => { win.focus(); win.print() }, 250)
  return true
}
