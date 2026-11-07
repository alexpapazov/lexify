import type { Card } from '@/domain'
import { windowPages, collapseOccurrences, compareWithLexicon, parseOccurrences, parseAllLemmas, unmarkedLemmas, splitUnmarkedLemmas, type PageOccurrence } from '@/lib/mediaIntake'

function occ(over: Partial<PageOccurrence>): PageOccurrence {
  return { text: 'sentier', lemma: 'sentier', kind: 'word', gloss: 'path', sentence: 'Le sentier est fermé.', marker: 'underlined', ...over }
}

function card(id: string, front: string, back: string, over: Partial<Card> = {}): Card {
  return {
    id, ownerId: 'u1', sourceLanguage: 'fr', targetLanguage: 'en',
    front, back, hints: [], choices: null, position: 0,
    createdAt: '', updatedAt: '', deletedAt: null,
    pos: 'noun', lemma: front.replace(/^(le|la|l')\s*/i, ''),
    ...over,
  }
}

describe('windowPages', () => {
  it('slides in pairs so a sentence crossing a page break is always seen whole', () => {
    expect(windowPages(['a', 'b', 'c', 'd'])).toEqual([['a', 'b'], ['b', 'c'], ['c', 'd']])
    expect(windowPages(['a'])).toEqual([['a']])
    expect(windowPages([])).toEqual([])
  })
})

describe('collapseOccurrences — stage B', () => {
  it('drops the same occurrence seen by two overlapping windows, keeps true re-marks with a count', () => {
    const out = collapseOccurrences([
      occ({}),                                                        // window 1+2
      occ({}),                                                        // window 2+3 sees the same marking
      occ({ text: 'sentiers', sentence: 'Les sentiers montent.' }),   // genuinely re-marked later
      occ({ lemma: 'Sentier', sentence: 'Le sentier est fermé.' }),   // case difference, same sentence
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.count).toBe(2)
    expect(out[0]!.sentences).toEqual([
      { sentence: 'Le sentier est fermé.', answer: 'sentier' },
      { sentence: 'Les sentiers montent.', answer: 'sentiers' },
    ])
  })

  it('keeps different lemmas apart and preserves reading order', () => {
    const out = collapseOccurrences([occ({}), occ({ text: 'fourré', lemma: 'fourré', gloss: 'thicket', sentence: 'Dans le fourré.' })])
    expect(out.map(c => c.lemma)).toEqual(['sentier', 'fourré'])
  })
})

describe('compareWithLexicon — stage C', () => {
  const cards = [
    card('a', 'le sentier', 'path'),
    card('b', 'marcher', 'to walk', { pos: 'verb', lemma: 'marcher' }),
    // Legacy unlabeled card — only its bare front can match.
    card('c', 'la clairière', 'clearing', { pos: null, lemma: null }),
    // Other pair — must never match.
    card('d', 'sentier', 'path', { sourceLanguage: 'es' }),
  ]

  it('matches by lemma, falls back to the bare front for unlabeled cards, scopes to the pair', () => {
    const [sentier, clairiere, torrent] = compareWithLexicon(
      collapseOccurrences([
        occ({}),
        occ({ text: 'clairière', lemma: 'clairière', gloss: 'clearing', sentence: 'Une clairière.' }),
        occ({ text: 'torrent', lemma: 'torrent', gloss: 'torrent', sentence: 'Le torrent.' }),
      ]),
      cards, 'fr', 'en',
    )
    expect(sentier!.existing?.id).toBe('a')      // lemma vs bare front of "le sentier"
    expect(clairiere!.existing?.id).toBe('c')    // unlabeled legacy card, bare-front match
    expect(torrent!.existing).toBeNull()
  })
})

describe('stage D — unmarked lemmas', () => {
  it('parseAllLemmas keeps strings, trims, dedupes case-insensitively, drops junk', () => {
    const out = parseAllLemmas({ allLemmas: ['Sentier', ' berge ', 'sentier', '', 42, null] })
    expect(out).toEqual(['Sentier', 'berge'])
    expect(parseAllLemmas({ occurrences: [] })).toEqual([])
    expect(parseAllLemmas(null)).toEqual([])
  })

  it('unmarkedLemmas merges overlapping windows and subtracts the marked candidates', () => {
    const candidates = collapseOccurrences([occ({})])   // "sentier" was marked
    const out = unmarkedLemmas([
      ['sentier', 'berge', 'mousse'],      // window 1+2
      ['Mousse', 'torrent'],               // window 2+3 re-sees mousse
    ], candidates)
    expect(out).toEqual(['berge', 'mousse', 'torrent'])
  })

  it('splitUnmarkedLemmas uses the same lemma/bare-front matching, pair-scoped', () => {
    const cards = [
      card('a', 'le sentier', 'path'),
      card('c', 'la clairière', 'clearing', { pos: null, lemma: null }),   // legacy unlabeled
      card('d', 'berge', 'bank', { sourceLanguage: 'es' }),                // other pair
    ]
    const { known, unknown } = splitUnmarkedLemmas(['sentier', 'clairière', 'berge'], cards, 'fr', 'en')
    expect(known.map(k => [k.lemma, k.card.id])).toEqual([['sentier', 'a'], ['clairière', 'c']])
    expect(unknown).toEqual(['berge'])
  })
})

describe('parseOccurrences', () => {
  it('keeps well-formed entries, drops the rest, defaults lemma to the text', () => {
    const out = parseOccurrences({ occurrences: [
      { text: 'berge', lemma: 'berge', kind: 'word', gloss: 'bank', sentence: 'Sur la berge.', marker: 'circled' },
      { text: 'mousse', gloss: 'moss' },                   // no lemma → defaults to text
      { text: '', gloss: 'x' }, { text: 'y' }, 'junk',     // malformed
    ] })
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ text: 'mousse', lemma: 'mousse', kind: 'word' })
    expect(parseOccurrences(null)).toEqual([])
  })
})
