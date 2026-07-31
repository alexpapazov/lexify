/**
 * lib/docx.ts — reading a .docx word list into a folder/deck plan. NO AI, no network.
 *
 * The point: you (or an assistant) write a vocabulary document with headings, and Lexify turns the
 * heading structure into folders and decks and the plain lines into cards. A heading that directly
 * holds word lines becomes a DECK; a heading that only holds other headings becomes a FOLDER.
 *
 * Three layers, separated so the interesting one is testable without a binary fixture:
 *   1. `unzipEntry`            — a .docx is a ZIP; pull out `word/document.xml`. Uses the platform's
 *                                DecompressionStream, so there's no zip dependency.
 *   2. `extractDocxParagraphs` — WordprocessingML → {text, bold, size, outlineLevel}. Pure.
 *   3. `parseDeckPlan`         — paragraphs → decks with folder paths. Pure, and where all the
 *                                structural rules live.
 */

// ─── 1. Minimal ZIP reader ───────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50
const CDIR_SIG = 0x02014b50

/**
 * Extracts one entry from a ZIP archive by exact name.
 *
 * Reads the End-of-Central-Directory record (scanned backwards, since it may be followed by a
 * comment), walks the central directory to find the entry, then inflates its bytes. Only the two
 * compression methods a .docx actually uses are supported: stored (0) and deflate (8).
 */
export async function unzipEntry(zip: ArrayBuffer, name: string): Promise<Uint8Array> {
  const view = new DataView(zip)
  const bytes = new Uint8Array(zip)

  // The EOCD is at least 22 bytes and sits within the last 64KB + 22 (max comment length).
  let eocd = -1
  const scanFrom = Math.max(0, bytes.length - 22 - 0xffff)
  for (let i = bytes.length - 22; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a valid .docx file (no ZIP directory found).')

  const entryCount = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(p, true) !== CDIR_SIG) break
    const method       = view.getUint16(p + 10, true)
    const compressedSz = view.getUint32(p + 20, true)
    const nameLen      = view.getUint16(p + 28, true)
    const extraLen     = view.getUint16(p + 30, true)
    const commentLen   = view.getUint16(p + 32, true)
    const localOffset  = view.getUint32(p + 42, true)
    const entryName    = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))

    if (entryName === name) {
      // The local header repeats the name and may carry a DIFFERENT extra-field length than the
      // central directory's — always re-read it here, or the data offset lands mid-stream.
      const lNameLen  = view.getUint16(localOffset + 26, true)
      const lExtraLen = view.getUint16(localOffset + 28, true)
      const start = localOffset + 30 + lNameLen + lExtraLen
      const data = bytes.subarray(start, start + compressedSz)
      if (method === 0) return data
      if (method !== 8) throw new Error(`Unsupported compression in .docx (method ${method}).`)
      return inflateRaw(data)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`This file doesn't look like a Word document (${name} is missing).`)
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// ─── 2. WordprocessingML → paragraphs ────────────────────────────────────────

export interface DocxParagraph {
  text: string
  /** True when every text-bearing run in the paragraph is bold. */
  bold: boolean
  /** Font size in half-points (`w:sz`), or null when the paragraph uses the document default. */
  sizeHalfPoints: number | null
  /** 1-based heading depth from a Heading style or `w:outlineLvl`; null when neither is present. */
  outlineLevel: number | null
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16))
    if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10))
    return XML_ENTITIES[code] ?? whole
  })
}

/** `<w:b/>` and `<w:b w:val="1"/>` are bold; `w:val="0"|"false"|"none"` explicitly is not. */
function hasToggle(xml: string, tag: string): boolean {
  const m = new RegExp(`<w:${tag}(\\s[^>]*)?/?>`).exec(xml)
  if (!m) return false
  const val = /w:val="([^"]*)"/.exec(m[1] ?? '')
  return !val || !['0', 'false', 'off', 'none'].includes(val[1]!)
}

/**
 * Parses the narrow, well-formed subset of WordprocessingML we need. Paragraphs never nest (table
 * cells contain them, they don't contain each other), so a flat scan is safe — and it means word
 * lines inside a table are picked up in document order too.
 */
export function extractDocxParagraphs(xml: string): DocxParagraph[] {
  const out: DocxParagraph[] = []
  for (const m of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const body = m[1]!
    const pPr  = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(body)?.[1] ?? ''

    // Heading depth: an explicit style ("Heading2", "Heading 2", "Title") or w:outlineLvl (0-based).
    let outlineLevel: number | null = null
    const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(pPr)?.[1]
    if (style) {
      const h = /^heading\s*(\d+)$/i.exec(style.trim())
      if (h) outlineLevel = Number(h[1])
      else if (/^title$/i.test(style.trim())) outlineLevel = 1
    }
    const lvl = /<w:outlineLvl\s+w:val="(\d+)"/.exec(pPr)?.[1]
    if (outlineLevel == null && lvl != null) outlineLevel = Number(lvl) + 1

    // Paragraph-level run defaults (inherited by every run that doesn't override them).
    const pRPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(pPr)?.[1] ?? ''
    const paraBold = hasToggle(pRPr, 'b')
    const paraSize = /<w:sz\s+w:val="(\d+)"/.exec(pRPr)?.[1]

    let text = ''
    let sawTextRun = false
    let allBold = true
    let size: number | null = paraSize != null ? Number(paraSize) : null

    for (const r of body.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
      const run  = r[1]!
      const rPr  = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? ''
      let runText = ''
      for (const t of run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) runText += decodeXml(t[1]!)
      // Tabs and breaks carry meaning here — a tab may be the front/back separator.
      runText = runText || ''
      const withBreaks = run.replace(/<w:tab\s*\/>/g, '\t').replace(/<w:br\s*\/>/g, '\n')
      if (/<w:tab\s*\/>/.test(run)) runText = withBreaks.includes('\t') ? `\t${runText}` : runText

      text += runText
      if (runText.trim()) {
        sawTextRun = true
        if (!hasToggle(rPr, 'b') && !paraBold) allBold = false
        const rSize = /<w:sz\s+w:val="(\d+)"/.exec(rPr)?.[1]
        if (rSize != null && size == null) size = Number(rSize)
      }
    }

    out.push({
      text: text.replace(/ /g, ' ').trim(),
      bold: sawTextRun && allBold,
      sizeHalfPoints: size,
      outlineLevel,
    })
  }
  return out
}

// ─── 3. Paragraphs → folder/deck plan ────────────────────────────────────────

export interface PlannedCard { front: string; back: string }

export interface PlannedDeck {
  /** Folder names from the library root down to (but NOT including) the deck itself. */
  path:  string[]
  name:  string
  cards: PlannedCard[]
}

export interface DeckPlan {
  decks: PlannedDeck[]
  /** Content lines that carried no separator — surfaced so nothing disappears silently. */
  unparsed: string[]
}

export interface DeckPlanOptions {
  /** Front/back separator on a word line. Defaults to '='. A tab is always accepted as well. */
  separator?: string
  /** Deck name for word lines that appear before any heading. */
  fallbackDeckName?: string
}

interface PlanNode { name: string; words: PlannedCard[]; children: PlanNode[] }

/** Splits a word line on the first separator. Tab wins when present — it's unambiguous. */
function parseWordLine(text: string, separator: string): PlannedCard | null {
  const sep = text.includes('\t') ? '\t' : separator
  const idx = text.indexOf(sep)
  if (idx < 0) return null
  const front = text.slice(0, idx).trim()
  const back  = text.slice(idx + sep.length).trim()
  if (!front || !back) return null
  return { front, back }
}

/**
 * Assigns a depth to every heading paragraph.
 *
 * When the document uses real Word heading styles, ONLY those count as headings — bold text is
 * ordinary emphasis in such a document and must not be mistaken for structure. Otherwise headings are
 * inferred from bold, ranked by font size (largest = shallowest), which is how a hand-written or
 * assistant-generated list usually looks: a big bold title over bold section names.
 */
function headingLevels(paras: DocxParagraph[], separator: string): (number | null)[] {
  const usesStyles = paras.some(p => p.outlineLevel != null)
  if (usesStyles) return paras.map(p => p.outlineLevel)

  // A bold line that parses as a word line is treated as a WORD, not a heading — losing a heading
  // merges two decks, but losing a line loses vocabulary, and that's the worse failure.
  const isHeading = (p: DocxParagraph) => p.bold && !!p.text && parseWordLine(p.text, separator) === null
  const sizes = [...new Set(paras.filter(isHeading).map(p => p.sizeHalfPoints))]
  // Largest first; the document default (null) sorts last, since an explicit size is only ever set
  // on something the author wanted to stand out.
  sizes.sort((a, b) => (b ?? -1) - (a ?? -1))
  return paras.map(p => isHeading(p) ? sizes.indexOf(p.sizeHalfPoints) + 1 : null)
}

/**
 * Turns parsed paragraphs into the decks to create.
 *
 * A heading with word lines directly under it becomes a deck; a heading with only sub-headings
 * becomes a folder. A heading with BOTH is treated as a folder, with its loose words collected into a
 * deck of the same name inside it.
 */
export function parseDeckPlan(paras: DocxParagraph[], opts: DeckPlanOptions = {}): DeckPlan {
  const separator = opts.separator || '='
  const levels = headingLevels(paras, separator)
  const unparsed: string[] = []

  const root: PlanNode = { name: opts.fallbackDeckName || 'Imported', words: [], children: [] }
  const stack: { node: PlanNode; level: number }[] = [{ node: root, level: 0 }]

  paras.forEach((p, i) => {
    if (!p.text) return
    const level = levels[i]
    if (level != null) {
      while (stack.length > 1 && stack[stack.length - 1]!.level >= level) stack.pop()
      const node: PlanNode = { name: p.text, words: [], children: [] }
      stack[stack.length - 1]!.node.children.push(node)
      stack.push({ node, level })
      return
    }
    const card = parseWordLine(p.text, separator)
    if (card) stack[stack.length - 1]!.node.words.push(card)
    else unparsed.push(p.text)
  })

  const decks: PlannedDeck[] = []
  const emit = (node: PlanNode, ancestors: string[]) => {
    const isFolder = node.children.length > 0
    if (node.words.length > 0) {
      decks.push({ path: isFolder ? [...ancestors, node.name] : ancestors, name: node.name, cards: node.words })
    }
    for (const child of node.children) emit(child, [...ancestors, node.name])
  }
  // The synthetic root is never a folder: its own words (anything before the first heading) become a
  // deck at the library root, and its children start their paths empty.
  if (root.words.length > 0) decks.push({ path: [], name: root.name, cards: root.words })
  for (const child of root.children) emit(child, [])

  return { decks, unparsed }
}

// ─── Glue ────────────────────────────────────────────────────────────────────

/** Reads a .docx File straight into a deck plan. Everything is local — no upload, no AI. */
export async function readDeckPlanFromFile(file: File, opts: DeckPlanOptions = {}): Promise<DeckPlan> {
  const xml = new TextDecoder().decode(await unzipEntry(await file.arrayBuffer(), 'word/document.xml'))
  return parseDeckPlan(extractDocxParagraphs(xml), {
    fallbackDeckName: file.name.replace(/\.docx$/i, ''),
    ...opts,
  })
}
