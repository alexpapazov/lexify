import type { Card } from '@/domain'
import { collapseOccurrences, compareWithLexicon, parseOccurrences, parseAllLemmas, unmarkedLemmas, splitUnmarkedLemmas, parseGlosses, parsePageNumbers, orderPages, windowOrderedPages, CHIP_WINDOWS, CHIP_SEED_RATING, type PageOccurrence } from '@/lib/mediaIntake'
import { LONG_TERM_THRESHOLD_DAYS } from '@/engine/implicitCredit'

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

describe('ordering pass — printed page numbers decide reading order', () => {
  it('a run of consecutive pages slides in pairs, single and empty inputs behave', () => {
    const run = windowOrderedPages([
      { item: 'a', pageNumber: 10 }, { item: 'b', pageNumber: 11 }, { item: 'c', pageNumber: 12 },
    ])
    expect(run).toEqual([['a', 'b'], ['b', 'c']])
    expect(windowOrderedPages([{ item: 'a', pageNumber: null }])).toEqual([['a']])
    expect(windowOrderedPages([])).toEqual([])
  })

  it('orderPages sorts by page number, unknowns keep upload order after the known ones', () => {
    const ordered = orderPages(['c', 'a', 'x', 'b', 'y'], [44, 42, null, 43, null])
    expect(ordered.map(o => o.item)).toEqual(['a', 'b', 'c', 'x', 'y'])
    expect(ordered.map(o => o.pageNumber)).toEqual([42, 43, 44, null, null])
  })

  it('windowOrderedPages pairs only genuinely consecutive pages; gapped pages parse alone', () => {
    const w = windowOrderedPages([
      { item: 'p42', pageNumber: 42 }, { item: 'p43', pageNumber: 43 },
      { item: 'p50', pageNumber: 50 }, { item: 'p51', pageNumber: 51 },
    ])
    expect(w).toEqual([['p42', 'p43'], ['p50', 'p51']])

    const gapped = windowOrderedPages([{ item: 'p42', pageNumber: 42 }, { item: 'p50', pageNumber: 50 }])
    expect(gapped).toEqual([['p42'], ['p50']])
  })

  it('an unknown page number gets the benefit of the doubt (paired with its neighbor)', () => {
    const w = windowOrderedPages([{ item: 'p42', pageNumber: 42 }, { item: 'x', pageNumber: null }])
    expect(w).toEqual([['p42', 'x']])
  })

  it('parsePageNumbers keeps valid entries, nulls junk values', () => {
    const out = parsePageNumbers({ pages: [
      { index: 0, pageNumber: 42 }, { index: 1, pageNumber: null },
      { index: 2, pageNumber: -3 }, { index: -1, pageNumber: 5 }, 'junk',
    ] })
    expect([...out.entries()]).toEqual([[0, 42], [1, null], [2, null]])
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

describe('stage E — chip constants + gloss parsing', () => {
  it('the long bucket lands entirely past the long-term threshold (credit-eligible on day one)', () => {
    expect(CHIP_WINDOWS.long.min).toBeGreaterThanOrEqual(LONG_TERM_THRESHOLD_DAYS)
    expect(CHIP_WINDOWS.short.max).toBeLessThan(LONG_TERM_THRESHOLD_DAYS)   // short stays short-term
    expect(CHIP_SEED_RATING.short).toBe('hard')
    expect(CHIP_SEED_RATING.long).toBe('easy')
  })

  it('parseGlosses keeps valid index/gloss pairs, drops junk', () => {
    const out = parseGlosses({ glosses: [
      { index: 0, gloss: ' path ' }, { index: 2, gloss: 'moss' },
      { index: -1, gloss: 'x' }, { index: 1, gloss: '' }, { index: 1.5, gloss: 'y' }, 'junk', null,
    ] })
    expect([...out.entries()]).toEqual([[0, 'path'], [2, 'moss']])
    expect(parseGlosses(null).size).toBe(0)
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
