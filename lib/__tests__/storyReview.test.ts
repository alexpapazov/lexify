import type { Card, CardState } from '@/domain'
import { initialCardState } from '@/engine/pipeline'
import { buildStoryPool, batchStories, locateTargets, parseStory, parseStoryTokens, storyTargets } from '@/lib/storyReview'
import type { ExpressCandidate } from '@/lib/expressReview'

const TZ = 'UTC'
const TODAY = '2026-10-04'
const PAST = '2026-10-01T00:00:00.000Z'

function card(id: string, front: string, back: string, over: Partial<Card> = {}): Card {
  return {
    id, ownerId: 'u1', sourceLanguage: 'es', targetLanguage: 'en',
    front, back, hints: [], choices: null, position: 0,
    createdAt: '', updatedAt: '', deletedAt: null,
    pos: 'noun', lemma: front.replace(/^(el|la)\s+/, ''),
    ...over,
  }
}

function state(cardId: string, over: Partial<CardState>): CardState {
  return { ...initialCardState('u1', cardId, 'p1'), ...over }
}

function duePair(cardId: string): CardState[] {
  return [
    state(cardId, { graduated: true }),
    state(cardId, { graduated: true, reviewDirection: 'reverse', recallDueAt: PAST, recallIntervalDays: 10, lastReviewedAt: '2026-09-20T00:00:00.000Z', difficulty: 5, stability: 10, reps: 3 }),
  ]
}

const poolOpts = { source: null, target: null, tracksByPair: new Map(), tz: TZ, today: TODAY }
const cand = (c: Card): ExpressCandidate => ({ card: c, state: state(c.id, { reviewDirection: 'reverse' }) })

describe('buildStoryPool', () => {
  it('drops function words on top of the express exclusions — reading cannot test them', () => {
    const cards = [
      card('a', 'el perro', 'dog'),
      card('b', 'hasta', 'until', { pos: 'preposition', lemma: 'hasta' }),
      card('c', 'mío', 'mine', { pos: 'pronoun', lemma: 'mío' }),
    ]
    const states = [...duePair('a'), ...duePair('b'), ...duePair('c')]
    const p = buildStoryPool(cards, states, poolOpts)
    expect(p.pool.map(x => x.card.id)).toEqual(['a'])
    expect(p.skippedFunctionWords).toBe(2)
  })

  it('keeps unlabeled cards (no pos) — the span anchor needs only the front text', () => {
    const cards = [card('a', 'el perro', 'dog', { pos: null, lemma: null })]
    const p = buildStoryPool(cards, [...duePair('a')], poolOpts)
    expect(p.pool.map(x => x.card.id)).toEqual(['a'])
  })
})

describe('batchStories', () => {
  it('chunks the pool with deck-mates adjacent', () => {
    const cands = [cand(card('a1', 'uno', '1')), cand(card('b1', 'dos', '2')), cand(card('a2', 'tres', '3'))]
    const deckOf = new Map([['a1', 'deckA'], ['a2', 'deckA'], ['b1', 'deckB']])
    const batches = batchStories(cands, deckOf, 2)
    expect(batches.map(b => b.map(x => x.card.id))).toEqual([['a1', 'a2'], ['b1']])
  })
})

describe('locateTargets', () => {
  const story = 'El caballo tozudo trepaba la montaña. Las ovejas lo miraban desde la valla.'

  it('finds the reported surface form and grows the span to the whole word', () => {
    const batch = [cand(card('h', 'el caballo', 'horse')), cand(card('t', 'trepar', 'to climb', { pos: 'verb', lemma: 'trepar' }))]
    const spans = locateTargets(story, [
      { lemma: 'caballo', surface: 'caballo' },
      // Reported surface is a stem of the actual word — whole-word expansion covers "trepaba".
      { lemma: 'trepar', surface: 'trepa' },
    ], batch)
    expect(spans.map(s => s.surface)).toEqual(['caballo', 'trepaba'])
    expect(spans.map(s => s.cardId)).toEqual(['h', 't'])
  })

  it('falls back to the bare front when the model reported no usage, and omits unlocatable targets', () => {
    const batch = [cand(card('o', 'la oveja', 'sheep')), cand(card('x', 'el fregadero', 'sink'))]
    const spans = locateTargets(story, [], batch)
    expect(spans.map(s => s.cardId)).toEqual(['o'])   // "ovejas" via whole-word growth; fregadero absent
    expect(spans[0]!.surface).toBe('ovejas')
  })

  it('claims each position once — two targets can never share a span', () => {
    const batch = [cand(card('m', 'la montaña', 'mountain')), cand(card('m2', 'montaña rusa', 'roller coaster', { lemma: 'montaña rusa' }))]
    const spans = locateTargets(story, [
      { lemma: 'montaña', surface: 'montaña' },
      { lemma: 'montaña rusa', surface: 'montaña' },
    ], batch)
    expect(spans).toHaveLength(1)
  })
})

describe('parseStory / storyTargets', () => {
  it('parses a well-formed story and drops malformed usages/tokens individually', () => {
    const parsed = parseStory({
      title: 'El día', story: 'El perro duerme.',
      usages: [{ lemma: 'Perro', surface: 'perro' }, { lemma: 42 }],
      tokens: [{ text: 'perro', gloss: 'dog' }, { nope: true }],
    })!
    expect(parsed.usages).toEqual([{ lemma: 'perro', surface: 'perro' }])
    expect(parsed.tokens).toEqual([{ text: 'perro', gloss: 'dog' }])
  })

  it('parseStoryTokens keeps only well-formed glossed tokens', () => {
    expect(parseStoryTokens({ tokens: [{ text: 'perro', gloss: 'dog' }, { text: 'el', gloss: '' }, { text: 7 }] }))
      .toEqual([{ text: 'perro', gloss: 'dog' }])
    expect(parseStoryTokens(null)).toEqual([])
  })

  it('rejects a storyless payload', () => {
    expect(parseStory({ title: 'x', usages: [], tokens: [] })).toBeNull()
    expect(parseStory(null)).toBeNull()
  })

  it('storyTargets sends one sense and a usable lemma even for unlabeled cards', () => {
    const t = storyTargets([cand(card('a', 'el perro', 'dog, hound; mutt', { lemma: null, pos: null }))])
    expect(t[0]!.gloss).toBe('dog')
    expect(t[0]!.lemma).toBe('perro')
  })
})
