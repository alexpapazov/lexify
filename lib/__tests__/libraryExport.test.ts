import { renderLibraryText, renderLibraryLines, exportFilename, type ExportTree } from '../libraryExport'
import { buildDocx } from '../docxWrite'
import { unzipEntry, extractDocxParagraphs, parseDeckPlan } from '../docx'

const TREE: ExportTree = {
  title: 'Italian → English',
  folders: [
    {
      name: 'Nouns',
      decks: [{ name: 'School', cards: [{ front: 'il voto', back: 'grade' }, { front: 'il banco', back: "student's desk" }] }],
      folders: [
        { name: 'Food', decks: [{ name: 'Fruit', cards: [{ front: 'la mela', back: 'apple' }] }], folders: [] },
      ],
    },
  ],
  decks: [{ name: 'Loose cards', cards: [{ front: 'ciao', back: 'hello' }] }],
}

describe('renderLibraryText', () => {
  const text = renderLibraryText(TREE, '2026-08-11')

  it('leads with the title and a count summary', () => {
    const [first, second] = text.split('\n')
    expect(first).toBe('Italian → English')
    expect(second).toBe('Exported 2026-08-11 · 2 folders · 3 decks · 4 cards')
  })

  it('nests folders, decks and cards by indentation', () => {
    expect(text).toContain('Nouns/')
    expect(text).toContain('    School  [2 cards]')
    expect(text).toContain('        il voto = grade')
    // A subfolder sits one level deeper than its parent, and its deck one deeper again.
    expect(text).toContain('    Food/')
    expect(text).toContain('        Fruit  [1 card]')
    expect(text).toContain('            la mela = apple')
  })

  it('marks folders with a trailing slash and decks with a card count', () => {
    // The two are otherwise just indented names — this is what keeps them distinguishable.
    expect(text).toMatch(/^Nouns\/$/m)
    expect(text).toMatch(/^Loose cards {2}\[1 card]$/m)
  })

  it('renders an empty scope explicitly rather than as a blank file', () => {
    expect(renderLibraryText({ title: 'Empty', folders: [], decks: [] }, '2026-08-11')).toContain('(empty)')
  })

  it('strips quoted-literal backs like the study screens do', () => {
    const t: ExportTree = { title: 'T', folders: [], decks: [{ name: 'D', cards: [{ front: 'estrarre', back: '"to extract/draw (from)"' }] }] }
    expect(renderLibraryText(t, '2026-08-11')).toContain('estrarre = to extract/draw (from)')
  })
})

describe('exportFilename', () => {
  it('slugifies the title and appends the date + extension', () => {
    expect(exportFilename('Italian → English', '2026-08-11', 'txt')).toBe('Italian-English-2026-08-11.txt')
    expect(exportFilename('Italian → English', '2026-08-11', 'docx')).toBe('Italian-English-2026-08-11.docx')
  })
  it('falls back when a title has no filename-safe characters', () => {
    expect(exportFilename('→ ···', '2026-08-11', 'txt')).toBe('lexify-2026-08-11.txt')
  })
  it('keeps non-Latin scripts rather than blanking the name', () => {
    expect(exportFilename('한국어', '2026-08-11', 'txt')).toBe('한국어-2026-08-11.txt')
  })
})

describe('renderLibraryLines', () => {
  const lines = renderLibraryLines(TREE, '2026-08-11')

  it('makes folder and deck names bold and card lines plain', () => {
    expect(lines.find(l => l.text === 'Nouns')?.bold).toBe(true)
    expect(lines.find(l => l.text.startsWith('School'))?.bold).toBe(true)
    expect(lines.find(l => l.text === 'il voto = grade')?.bold).toBeUndefined()
  })

  it('never lets a deeply nested folder reach a zero font size', () => {
    let deep: ExportTree['folders'][number] = { name: 'L8', decks: [], folders: [] }
    for (let i = 7; i >= 0; i--) deep = { name: `L${i}`, decks: [], folders: [deep] }
    for (const l of renderLibraryLines({ title: 'T', folders: [deep], decks: [] }, '2026-08-11')) {
      expect(l.size ?? 11).toBeGreaterThan(0)
    }
  })
})

describe('buildDocx — a real .docx the app can read back', () => {
  it('round-trips through the repo’s own docx reader', async () => {
    const blob = await buildDocx(renderLibraryLines(TREE, '2026-08-11'))
    const xml = new TextDecoder().decode(await unzipEntry(await blob.arrayBuffer(), 'word/document.xml'))
    const paras = extractDocxParagraphs(xml)
    const texts = paras.map(p => p.text)

    expect(texts).toContain('Italian → English')
    expect(texts).toContain('Nouns')
    expect(texts).toContain('il voto = grade')
    // Names carry the bold flag the importer keys off.
    expect(paras.find(p => p.text === 'Nouns')?.bold).toBe(true)
  })

  it('escapes XML metacharacters instead of producing a corrupt part', async () => {
    const t: ExportTree = { title: 'A & B', folders: [], decks: [{ name: '<deck>', cards: [{ front: 'a<b', back: 'x & y' }] }] }
    const blob = await buildDocx(renderLibraryLines(t, '2026-08-11'))
    const xml = new TextDecoder().decode(await unzipEntry(await blob.arrayBuffer(), 'word/document.xml'))
    expect(extractDocxParagraphs(xml).map(p => p.text)).toContain('a<b = x & y')
  })

  it('re-imports as the same tree through batch import', async () => {
    // The export is written so the batch importer can read it: bold names with descending sizes are
    // its heading signal, and cards are `front = back` lines.
    const blob = await buildDocx(renderLibraryLines(TREE, '2026-08-11'))
    const xml = new TextDecoder().decode(await unzipEntry(await blob.arrayBuffer(), 'word/document.xml'))
    const plan = parseDeckPlan(extractDocxParagraphs(xml))
    const named = plan.decks.map(d => d.name)
    expect(named).toEqual(expect.arrayContaining(['School', 'Fruit', 'Loose cards']))
    const school = plan.decks.find(d => d.name === 'School')!
    expect(school.cards).toEqual([
      { front: 'il voto', back: 'grade' },
      { front: 'il banco', back: "student's desk" },
    ])
  })
})
