import { extractDocxParagraphs, parseDeckPlan, unzipEntry, type DocxParagraph } from '../docx'

// Minimal WordprocessingML builders — enough to exercise the real parser paths.
const run = (text: string, opts: { bold?: boolean; size?: number } = {}) => {
  const rPr = (opts.bold || opts.size)
    ? `<w:rPr>${opts.bold ? '<w:b/>' : ''}${opts.size ? `<w:sz w:val="${opts.size}"/>` : ''}</w:rPr>`
    : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`
}
const para = (text: string, opts: { bold?: boolean; size?: number; style?: string } = {}) => {
  const pPr = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : ''
  return `<w:p>${pPr}${run(text, opts)}</w:p>`
}
const doc = (...ps: string[]) => `<w:document><w:body>${ps.join('')}</w:body></w:document>`

describe('extractDocxParagraphs', () => {
  it('reads text, bold and size', () => {
    const ps = extractDocxParagraphs(doc(
      para('First 200', { bold: true, size: 32 }),
      para('el = the'),
    ))
    expect(ps).toHaveLength(2)
    expect(ps[0]).toMatchObject({ text: 'First 200', bold: true, sizeHalfPoints: 32 })
    expect(ps[1]).toMatchObject({ text: 'el = the', bold: false, sizeHalfPoints: null })
  })

  it('decodes XML entities', () => {
    const ps = extractDocxParagraphs(doc(para('m&#225;s &amp; menos = more &amp; less')))
    expect(ps[0]!.text).toBe('más & menos = more & less')
  })

  it('joins split runs into one paragraph', () => {
    const ps = extractDocxParagraphs(doc(`<w:p>${run('el ')}${run('= ')}${run('the')}</w:p>`))
    expect(ps[0]!.text).toBe('el = the')
  })

  it('treats a mixed-boldness paragraph as not bold', () => {
    const ps = extractDocxParagraphs(doc(`<w:p>${run('el', { bold: true })}${run(' = the')}</w:p>`))
    expect(ps[0]!.bold).toBe(false)
  })

  it('honours an explicit w:val="0" bold toggle', () => {
    const ps = extractDocxParagraphs(doc('<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>plain</w:t></w:r></w:p>'))
    expect(ps[0]!.bold).toBe(false)
  })

  it('reads heading styles and outline levels', () => {
    const ps = extractDocxParagraphs(doc(
      para('Title', { style: 'Title' }),
      para('Section', { style: 'Heading2' }),
      para('Spaced', { style: 'Heading 3' }),
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Outlined</w:t></w:r></w:p>',
    ))
    expect(ps.map(p => p.outlineLevel)).toEqual([1, 2, 3, 1])
  })

  it('inherits bold from paragraph-level run properties', () => {
    const ps = extractDocxParagraphs(doc(
      '<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>Pronouns</w:t></w:r></w:p>',
    ))
    expect(ps[0]!.bold).toBe(true)
  })

  it('ignores empty paragraphs', () => {
    const ps = extractDocxParagraphs(doc('<w:p/>', '<w:p></w:p>', para('el = the')))
    expect(ps.filter(p => p.text).map(p => p.text)).toEqual(['el = the'])
  })
})

describe('parseDeckPlan', () => {
  const p = (text: string, bold = false, size: number | null = null): DocxParagraph =>
    ({ text, bold, sizeHalfPoints: size, outlineLevel: null })

  it('makes a folder of the title and decks of the sections', () => {
    const plan = parseDeckPlan([
      p('First 200', true, 32),
      p('Articles', true),
      p('el = the'), p('la = the'),
      p('Pronouns', true),
      p('yo = I'),
    ])
    expect(plan.decks).toEqual([
      { path: ['First 200'], name: 'Articles', cards: [{ front: 'el', back: 'the' }, { front: 'la', back: 'the' }] },
      { path: ['First 200'], name: 'Pronouns', cards: [{ front: 'yo', back: 'I' }] },
    ])
  })

  it('nests three levels: folder, subfolder, deck', () => {
    const plan = parseDeckPlan([
      p('Spanish', true, 36),
      p('First 200', true, 32),
      p('Articles', true),
      p('el = the'),
    ])
    expect(plan.decks).toEqual([
      { path: ['Spanish', 'First 200'], name: 'Articles', cards: [{ front: 'el', back: 'the' }] },
    ])
  })

  it('puts a heading that has BOTH words and sub-headings in a folder of its own name', () => {
    const plan = parseDeckPlan([
      p('Verbs', true, 32),
      p('ser = to be'),
      p('Irregular', true),
      p('ir = to go'),
    ])
    expect(plan.decks).toEqual([
      { path: ['Verbs'], name: 'Verbs',      cards: [{ front: 'ser', back: 'to be' }] },
      { path: ['Verbs'], name: 'Irregular',  cards: [{ front: 'ir',  back: 'to go' }] },
    ])
  })

  it('uses real heading styles when the document has them, ignoring bold emphasis', () => {
    const plan = parseDeckPlan([
      { text: 'First 200', bold: false, sizeHalfPoints: null, outlineLevel: 1 },
      { text: 'Articles',  bold: false, sizeHalfPoints: null, outlineLevel: 2 },
      { text: 'el = the',  bold: true,  sizeHalfPoints: null, outlineLevel: null },
    ])
    expect(plan.decks).toEqual([
      { path: ['First 200'], name: 'Articles', cards: [{ front: 'el', back: 'the' }] },
    ])
  })

  it('treats a bold line that parses as a word as vocabulary, not a heading', () => {
    const plan = parseDeckPlan([p('Articles', true, 32), p('el = the', true)])
    expect(plan.decks[0]!.cards).toEqual([{ front: 'el', back: 'the' }])
  })

  it('puts words before any heading into a fallback deck at the root', () => {
    const plan = parseDeckPlan([p('el = the'), p('Articles', true), p('la = the')], { fallbackDeckName: 'Loose' })
    expect(plan.decks[0]).toEqual({ path: [], name: 'Loose', cards: [{ front: 'el', back: 'the' }] })
    expect(plan.decks[1]!.name).toBe('Articles')
  })

  it('reports lines with no separator instead of dropping them', () => {
    const plan = parseDeckPlan([p('Articles', true), p('el = the'), p('this line is prose')])
    expect(plan.unparsed).toEqual(['this line is prose'])
    expect(plan.decks[0]!.cards).toHaveLength(1)
  })

  it('splits on the FIRST separator, so the gloss may contain one', () => {
    const plan = parseDeckPlan([p('Verbs', true), p('ser = to be = exist')])
    expect(plan.decks[0]!.cards).toEqual([{ front: 'ser', back: 'to be = exist' }])
  })

  it('accepts a custom separator and always accepts a tab', () => {
    expect(parseDeckPlan([p('A', true), p('el - the')], { separator: '-' }).decks[0]!.cards)
      .toEqual([{ front: 'el', back: 'the' }])
    expect(parseDeckPlan([p('A', true), p('el\tthe')]).decks[0]!.cards)
      .toEqual([{ front: 'el', back: 'the' }])
  })

  it('skips half-empty lines', () => {
    const plan = parseDeckPlan([p('A', true), p('el ='), p('= the'), p('ok = fine')])
    expect(plan.decks[0]!.cards).toEqual([{ front: 'ok', back: 'fine' }])
    expect(plan.unparsed).toHaveLength(2)
  })

  it('produces nothing for a document with no word lines', () => {
    expect(parseDeckPlan([p('Just a title', true, 32)]).decks).toEqual([])
  })

  it('puts every deck at the root when no heading carries a distinct size', () => {
    const plan = parseDeckPlan([p('Articles', true), p('el = the'), p('Pronouns', true), p('yo = I')])
    expect(plan.decks.map(d => d.path)).toEqual([[], []])
    expect(plan.decks.map(d => d.name)).toEqual(['Articles', 'Pronouns'])
  })
})

describe('unzipEntry', () => {
  // Builds a real single-entry ZIP so the reader is exercised end to end, no binary fixture needed.
  async function makeZip(name: string, content: string, deflate: boolean): Promise<ArrayBuffer> {
    const nameBytes = new TextEncoder().encode(name)
    const raw = new TextEncoder().encode(content)
    const body = deflate
      ? new Uint8Array(await new Response(
          new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw')),
        ).arrayBuffer())
      : raw

    const local = new Uint8Array(30 + nameBytes.length + body.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, deflate ? 8 : 0, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(body, 30 + nameBytes.length)

    const cdir = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cdir.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, deflate ? 8 : 0, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, 0, true)
    cdir.set(nameBytes, 46)

    const eocd = new Uint8Array(22)
    const ev = new DataView(eocd.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(8, 1, true)
    ev.setUint16(10, 1, true)
    ev.setUint32(12, cdir.length, true)
    ev.setUint32(16, local.length, true)

    const out = new Uint8Array(local.length + cdir.length + eocd.length)
    out.set(local, 0)
    out.set(cdir, local.length)
    out.set(eocd, local.length + cdir.length)
    return out.buffer
  }

  it('reads a deflated entry', async () => {
    const zip = await makeZip('word/document.xml', '<w:document>hello</w:document>', true)
    expect(new TextDecoder().decode(await unzipEntry(zip, 'word/document.xml')))
      .toBe('<w:document>hello</w:document>')
  })

  it('reads a stored (uncompressed) entry', async () => {
    const zip = await makeZip('word/document.xml', 'plain', false)
    expect(new TextDecoder().decode(await unzipEntry(zip, 'word/document.xml'))).toBe('plain')
  })

  it('gives a clear error for a missing entry', async () => {
    const zip = await makeZip('other.xml', 'x', true)
    await expect(unzipEntry(zip, 'word/document.xml')).rejects.toThrow(/Word document/)
  })

  it('gives a clear error for a non-ZIP file', async () => {
    await expect(unzipEntry(new TextEncoder().encode('not a zip at all').buffer as ArrayBuffer, 'x'))
      .rejects.toThrow(/valid \.docx/)
  })
})
