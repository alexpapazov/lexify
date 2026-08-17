import {
  buildLibraryIndex, toPracticeTargets, targetRejection, UNDRILLABLE_POS,
} from '../practice'
import type { Card, CardState, PartOfSpeech } from '@/domain'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let nextId = 0
function card(front: string, pos: PartOfSpeech | null, lemma: string | null): Card {
  return {
    id: `card-${nextId++}`,
    ownerId: 'user-1',
    sourceLanguage: 'fr',
    targetLanguage: 'en',
    front,
    back: 'gloss',
    hints: [],
    choices: null,
    position: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    pos,
    lemma,
  }
}

function forwardState(cardId: string, graduated: boolean): CardState {
  return { cardId, graduated, reviewDirection: 'forward' } as unknown as CardState
}

function reverseState(cardId: string, graduated: boolean): CardState {
  return { cardId, graduated, reviewDirection: 'reverse' } as unknown as CardState
}

/** Builds a library where every card is graduated, for the common case. */
function graduatedLibrary(entries: [string, PartOfSpeech, string][]) {
  const cards = entries.map(([front, pos, lemma]) => card(front, pos, lemma))
  const states = cards.map(c => forwardState(c.id, true))
  return buildLibraryIndex(cards, states)
}

// ─── buildLibraryIndex ────────────────────────────────────────────────────────

describe('buildLibraryIndex', () => {
  it('indexes labeled cards by lemma, lowercased', () => {
    const index = graduatedLibrary([['Le Pou', 'noun', 'Pou']])
    expect(index.all.has('pou')).toBe(true)
    expect(index.graduated.has('pou')).toBe(true)
  })

  it('separates graduated from merely-present lemmas', () => {
    const known = card('écraser', 'verb', 'écraser')
    const learning = card('interposer', 'verb', 'interposer')
    const index = buildLibraryIndex([known, learning], [
      forwardState(known.id, true),
      forwardState(learning.id, false),
    ])
    expect(index.all.has('écraser')).toBe(true)
    expect(index.all.has('interposer')).toBe(true)
    expect(index.graduated.has('écraser')).toBe(true)
    expect(index.graduated.has('interposer')).toBe(false)
  })

  it('reads graduation from the FORWARD row only', () => {
    // Recognition graduated, production did not — practice is production, so this is not graduated.
    const c = card('le fléau', 'noun', 'fléau')
    const index = buildLibraryIndex([c], [forwardState(c.id, false), reverseState(c.id, true)])
    expect(index.graduated.has('fléau')).toBe(false)
  })

  it('excludes phrase cards from the vocabulary (they are not single words)', () => {
    const index = graduatedLibrary([
      ['il pleut des cordes', 'phrase', null as unknown as string],
      ['la pluie', 'noun', 'pluie'],
    ])
    expect(index.all.has('pluie')).toBe(true)
    expect(index.graduated.size).toBe(1)
  })

  it('counts unlabeled cards instead of indexing them', () => {
    const labeled   = card('la pluie', 'noun', 'pluie')
    const unlabeled = card('le vent', null, null)
    const index = buildLibraryIndex([labeled, unlabeled], [
      forwardState(labeled.id, true), forwardState(unlabeled.id, true),
    ])
    expect(index.unlabeledCount).toBe(1)
    expect(index.all.size).toBe(1)
  })

  it('counts GRADUATED unlabeled cards separately — the "my library looks empty" explanation', () => {
    // A learner with plenty of graduated words that were never labeled: coverage reads as an empty
    // library, and the UI must say "label these" rather than "you know nothing".
    const graduatedUnlabeled = Array.from({ length: 3 }, () => card('дума', null, null))
    const newUnlabeled       = card('нова', null, null)
    const index = buildLibraryIndex([...graduatedUnlabeled, newUnlabeled], [
      ...graduatedUnlabeled.map(c => forwardState(c.id, true)),
      forwardState(newUnlabeled.id, false),
    ])
    expect(index.unlabeledCount).toBe(4)
    expect(index.graduatedUnlabeledCount).toBe(3)
    expect(index.graduated.size).toBe(0)          // nothing usable yet — the reported symptom
  })

  it('reports no graduated-unlabeled cards once everything is labeled', () => {
    const c = card('la pluie', 'noun', 'pluie')
    const index = buildLibraryIndex([c], [forwardState(c.id, true)])
    expect(index.graduatedUnlabeledCount).toBe(0)
  })

  it('counts a duplicated lemma once', () => {
    const index = graduatedLibrary([['la pluie', 'noun', 'pluie'], ['pluie', 'noun', 'pluie']])
    expect(index.graduated.size).toBe(1)
  })

  it('handles an empty library', () => {
    const index = buildLibraryIndex([], [])
    expect(index.all.size).toBe(0)
    expect(index.graduated.size).toBe(0)
    expect(index.unlabeledCount).toBe(0)
  })
})

// ─── The drillable-target gate ────────────────────────────────────────────────

describe('targetRejection / toPracticeTargets', () => {
  it('accepts a labeled content word', () => {
    expect(targetRejection(card('se précipiter', 'verb', 'se précipiter'))).toBeNull()
  })

  it('rejects an unlabeled card, or one whose lemma is blank', () => {
    expect(targetRejection(card('le vent', null, null))).toBe('unlabeled')
    expect(targetRejection(card('le vent', 'noun', '   '))).toBe('unlabeled')
  })

  it('rejects phrases and function words as undrillable', () => {
    expect(targetRejection(card('il pleut des cordes', 'phrase', null))).toBe('undrillable')
    for (const pos of UNDRILLABLE_POS) {
      expect(targetRejection(card('mot', pos, 'mot'))).toBe('undrillable')
    }
  })

  it('keeps only the drillable cards, trimming lemmas', () => {
    const targets = toPracticeTargets([
      card('se précipiter', 'verb', '  se précipiter '),
      card('il pleut des cordes', 'phrase', null),
      card('le vent', null, null),
      card('le', 'determiner', 'le'),
    ])
    expect(targets.map(t => t.lemma)).toEqual(['se précipiter'])
  })
})
