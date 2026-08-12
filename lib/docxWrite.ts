/**
 * lib/docxWrite.ts — write a minimal, valid .docx. The mirror of `lib/docx.ts` (which reads one).
 *
 * **No dependency**, for the same reason the reader has none: a `.docx` is a ZIP of XML, and the
 * platform ships both halves — `CompressionStream('deflate-raw')` to compress and a small CRC32 to
 * satisfy the ZIP format. Adding a document library to emit three XML parts would be the larger cost.
 *
 * The output is deliberately shaped so it can be read BACK by `parseDeckPlan`: folder and deck names
 * are **bold with descending font sizes** (which is exactly the heading signal the batch importer
 * looks for when a document carries no Word heading styles), and cards are plain `front = back`
 * lines. So an exported library re-imports as the same tree.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xFF]! ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw')
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

interface ZipEntry { name: string; data: Uint8Array; deflated: Uint8Array; crc: number }

/** Builds a ZIP archive (deflate-raw, no directory entries, no zip64 — ample for a text export). */
async function makeZip(files: { name: string; text: string }[]): Promise<Blob> {
  const enc = new TextEncoder()
  const entries: ZipEntry[] = []
  for (const f of files) {
    const data = enc.encode(f.text)
    entries.push({ name: f.name, data, deflated: await deflateRaw(data), crc: crc32(data) })
  }

  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  const u16 = (v: number) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF])
  const u32 = (v: number) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF])
  const concat = (parts: Uint8Array[]) => {
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const p of parts) { out.set(p, at); at += p.length }
    return out
  }

  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(8),      // sig, version, flags, method=deflate
      u16(0), u16(0),                                 // mod time/date (zeroed — not meaningful here)
      u32(e.crc), u32(e.deflated.length), u32(e.data.length),
      u16(nameBytes.length), u16(0), nameBytes, e.deflated,
    ])
    chunks.push(local)
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8),
      u16(0), u16(0),
      u32(e.crc), u32(e.deflated.length), u32(e.data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBytes,
    ]))
    offset += local.length
  }

  const centralBytes = concat(central)
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ])
  return new Blob([concat(chunks) as BlobPart, centralBytes as BlobPart, eocd as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One paragraph. `size` is in POINTS; `indent` in nesting levels. */
export interface DocxLine { text: string; bold?: boolean; size?: number; indent?: number }

function paragraph(line: DocxLine): string {
  const halfPoints = Math.round((line.size ?? 11) * 2)
  const indentTwips = (line.indent ?? 0) * 360   // 360 twips = 0.25"
  const props = [
    indentTwips ? `<w:ind w:left="${indentTwips}"/>` : '',
    `<w:spacing w:after="${line.bold ? 80 : 0}"/>`,
  ].join('')
  const runProps = `<w:rPr>${line.bold ? '<w:b/>' : ''}<w:sz w:val="${halfPoints}"/></w:rPr>`
  // xml:space="preserve" keeps an empty spacer paragraph from collapsing.
  return `<w:p><w:pPr>${props}</w:pPr><w:r>${runProps}<w:t xml:space="preserve">${esc(line.text)}</w:t></w:r></w:p>`
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

/** Assembles the three required parts into a .docx blob. */
export async function buildDocx(lines: DocxLine[]): Promise<Blob> {
  const body = lines.map(paragraph).join('')
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`
  return makeZip([
    { name: '[Content_Types].xml', text: CONTENT_TYPES },
    { name: '_rels/.rels',         text: ROOT_RELS },
    { name: 'word/document.xml',   text: document },
  ])
}
