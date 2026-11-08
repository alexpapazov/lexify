import type { Card } from '@/domain'
import { compareWithLexicon, parseOccurrences, parseAllLemmas, parseGlosses, CHIP_WINDOWS, CHIP_SEED_RATING, type IntakeCandidate } from '@/lib/mediaIntake'
import { LONG_TERM_THRESHOLD_DAYS } from '@/engine/implicitCredit'

function card(id: string, front: string, back: string, over: Partial<Card> = {}): Card {
  return {
    id, ownerId: 'u1', sourceLanguage: 'fr', targetLanguage: 'en',
    front, back, hints: [], choices: null, position: 0,
    createdAt: '', updatedAt: '', deletedAt: null,
    pos: 'noun', lemma: front.replace(/^(le|la|l')\s*/i, ''),
    ...over,
  }
}

describe('compareWithLexicon — stage C', () => {
  const cards = [
    card('a', 'le sentier', 'path'),
    card('b', 'marcher', 'to walk', { pos: 'verb', lemma: 'marcher' }),
    // Legacy unlabeled card — only its bare front can match.
    card('c', 'la clairière', 'clearing', { pos: null, lemma: null }),
    // Other pair — must never match.
    card('d', 'sentier', 'path', { sourceLanguage: 'es' }),
  ]

  const cand = (text: string, lemma: string): IntakeCandidate =>
    ({ text, lemma, kind: 'word', gloss: 'g', sentences: [], count: 1, markers: [] })

  it('matches by lemma, falls back to the bare front for unlabeled cards, scopes to the pair', () => {
    const [sentier, clairiere, torrent] = compareWithLexicon(
      [cand('sentier', 'sentier'), cand('clairière', 'clairière'), cand('torrent', 'torrent')],
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
      { text: 'berge', lemma: 'berge', kind: 'word', gloss: 'bank', sentence: 'Sur la berge.', marker: 'circled', display: 'la berge' },
      { text: 'mousse', gloss: 'moss' },                   // no lemma → defaults to text
      { text: '', gloss: 'x' }, { text: 'y' }, 'junk',     // malformed
    ] })
    expect(out).toHaveLength(2)
    expect(out[0]!.display).toBe('la berge')          // the flashcard form rides along
    expect(out[1]).toMatchObject({ text: 'mousse', lemma: 'mousse', kind: 'word' })
    expect(out[1]!.display).toBeUndefined()
    expect(parseOccurrences(null)).toEqual([])
  })
})
