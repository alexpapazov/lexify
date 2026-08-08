import {
  buildLibraryIndex, vocabularyCoverage, scoreSentence, sampleHelperWords, repairCandidates,
  toPracticeTargets, targetRejection,
  ESSENTIAL_POS, MIN_POS_COUNT, UNDRILLABLE_POS,
  type AnnotatedToken,
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

function token(text: string, lemma: string, pos: PartOfSpeech, isFunctionWord = false): AnnotatedToken {
  return { text, lemma, pos, isFunctionWord }
}

/** A library with enough of every essential class to pass coverage. */
function healthyLibrary() {
  const entries: [string, PartOfSpeech, string][] = []
  for (let i = 0; i < MIN_POS_COUNT; i++) {
    entries.push([`nom${i}`, 'noun', `nom${i}`])
    entries.push([`verbe${i}`, 'verb', `verbe${i}`])
    entries.push([`adj${i}`, 'adjective', `adj${i}`])
  }
  return graduatedLibrary(entries)
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
    expect(index.graduatedByPos.get('phrase')).toBeUndefined()
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
    expect(index.graduatedByPos.get('noun')).toBe(1)
    expect(index.graduatedWords.get('noun')).toHaveLength(1)
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

// ─── vocabularyCoverage ───────────────────────────────────────────────────────

describe('vocabularyCoverage', () => {
  it('passes a library with enough of every essential class', () => {
    const report = vocabularyCoverage(healthyLibrary())
    expect(report.verdict).toBe('ok')
    expect(report.missing).toEqual([])
    expect(report.graduatedCount).toBe(MIN_POS_COUNT * 3)
  })

  it('flags the "1000 nouns, no verbs" library and names what is missing', () => {
    const entries: [string, PartOfSpeech, string][] = []
    for (let i = 0; i < 50; i++) entries.push([`nom${i}`, 'noun', `nom${i}`])
    const report = vocabularyCoverage(graduatedLibrary(entries))
    expect(report.verdict).toBe('narrow')
    expect(report.missing).toEqual(['verb', 'adjective'])
    expect(report.graduatedCount).toBe(50)
  })

  it('is narrow when a class is one card short of the minimum', () => {
    const entries: [string, PartOfSpeech, string][] = []
    for (let i = 0; i < MIN_POS_COUNT; i++) {
      entries.push([`nom${i}`, 'noun', `nom${i}`])
      entries.push([`adj${i}`, 'adjective', `adj${i}`])
    }
    for (let i = 0; i < MIN_POS_COUNT - 1; i++) entries.push([`verbe${i}`, 'verb', `verbe${i}`])
    expect(vocabularyCoverage(graduatedLibrary(entries)).missing).toEqual(['verb'])
  })

  it('reports every essential class missing for an empty library', () => {
    expect(vocabularyCoverage(buildLibraryIndex([], [])).missing).toEqual(ESSENTIAL_POS)
  })

  it('ignores non-graduated cards — practice draws on what is known', () => {
    const cards = Array.from({ length: 20 }, (_, i) => card(`verbe${i}`, 'verb', `verbe${i}`))
    const index = buildLibraryIndex(cards, cards.map(c => forwardState(c.id, false)))
    expect(vocabularyCoverage(index).verdict).toBe('narrow')
  })
})

// ─── scoreSentence ────────────────────────────────────────────────────────────

describe('scoreSentence', () => {
  const index = graduatedLibrary([
    ['la pluie', 'noun', 'pluie'],
    ['écraser', 'verb', 'écraser'],
    ['fort', 'adjective', 'fort'],
  ])

  it('scores an all-graduated sentence at 100 and passes', () => {
    const tokens = [
      token('la', 'le', 'determiner', true),
      token('pluie', 'pluie', 'noun'),
      token('écrase', 'écraser', 'verb'),
    ]
    const score = scoreSentence(tokens, index, [], 80)
    expect(score.graduatedPct).toBe(100)
    expect(score.countedCount).toBe(2)
    expect(score.offenders).toEqual([])
    expect(score.passes).toBe(true)
  })

  it('excludes function words from the count, by flag or by class', () => {
    const tokens = [
      token('la', 'le', 'determiner'),           // structural class, flag not set
      token('sous', 'sous', 'preposition'),
      token('vraiment', 'vraiment', 'adverb', true), // model marked it structural
      token('pluie', 'pluie', 'noun'),
    ]
    const score = scoreSentence(tokens, index, [], 50)
    expect(score.countedCount).toBe(1)
    expect(score.graduatedPct).toBe(100)
  })

  it('flags a word that is nowhere in the library', () => {
    const tokens = [token('pluie', 'pluie', 'noun'), token('tonnerre', 'tonnerre', 'noun')]
    const score = scoreSentence(tokens, index, [], 50)
    expect(score.offenders.map(o => o.lemma)).toEqual(['tonnerre'])
    expect(score.graduatedPct).toBe(50)
    expect(score.passes).toBe(false)   // an unresolved unknown word fails regardless of the score
  })

  it('does not flag a known-but-not-graduated word, though it lowers the score', () => {
    const pluie    = card('la pluie', 'noun', 'pluie')
    const learning = card('interposer', 'verb', 'interposer')
    const idx = buildLibraryIndex([pluie, learning], [
      forwardState(pluie.id, true), forwardState(learning.id, false),
    ])

    const tokens = [token('pluie', 'pluie', 'noun'), token('interpose', 'interposer', 'verb')]
    const score = scoreSentence(tokens, idx, [], 50)
    expect(score.offenders).toEqual([])          // met before — not unknown
    expect(score.graduatedPct).toBe(50)          // but not graduated either
    expect(score.passes).toBe(true)              // 50 >= 50, and nothing flagged
  })

  it('exempts target words even when they are absent from the library', () => {
    const tokens = [
      token('pluie', 'pluie', 'noun'),
      token('précipite', 'se précipiter', 'verb'),   // the brand-new word being drilled
    ]
    const score = scoreSentence(tokens, index, ['se précipiter'], 100)
    expect(score.tokens.find(t => t.lemma === 'se précipiter')!.isTarget).toBe(true)
    expect(score.offenders).toEqual([])
    expect(score.countedCount).toBe(1)             // the target is not judged
    expect(score.graduatedPct).toBe(100)
    expect(score.passes).toBe(true)
  })

  it('matches targets case- and whitespace-insensitively', () => {
    const tokens = [token('Précipite', 'Se Précipiter', 'verb')]
    const score = scoreSentence(tokens, index, ['  se précipiter  '], 100)
    expect(score.offenders).toEqual([])
  })

  it('applies the slider: the same sentence passes at 50 and fails at 80', () => {
    const half = [
      token('pluie', 'pluie', 'noun'),
      token('interpose', 'interposer', 'verb'),
    ]
    const idxWithLearning = (() => {
      const pluie = card('la pluie', 'noun', 'pluie')
      const learning = card('interposer', 'verb', 'interposer')
      return buildLibraryIndex([pluie, learning], [
        forwardState(pluie.id, true), forwardState(learning.id, false),
      ])
    })()
    expect(scoreSentence(half, idxWithLearning, [], 50).passes).toBe(true)
    expect(scoreSentence(half, idxWithLearning, [], 80).passes).toBe(false)
  })

  it('scores a sentence of only function and target words as 100', () => {
    const tokens = [
      token('la', 'le', 'determiner'),
      token('précipite', 'se précipiter', 'verb'),
    ]
    const score = scoreSentence(tokens, index, ['se précipiter'], 100)
    expect(score.countedCount).toBe(0)
    expect(score.graduatedPct).toBe(100)
    expect(score.passes).toBe(true)
  })

  it('rounds the percentage', () => {
    const idx = graduatedLibrary([['un', 'noun', 'un'], ['deux', 'noun', 'deux']])
    const tokens = [
      token('un', 'un', 'noun'),
      token('deux', 'deux', 'noun'),
      token('trois', 'trois', 'noun'),
    ]
    // 2 of 3 graduated → 66.67 → 67. 'trois' is unknown, so it is also flagged.
    const score = scoreSentence(tokens, idx, [], 0)
    expect(score.graduatedPct).toBe(67)
    expect(score.passes).toBe(false)
  })

  it('returns every token, annotated, in order', () => {
    const tokens = [token('la', 'le', 'determiner'), token('pluie', 'pluie', 'noun')]
    const score = scoreSentence(tokens, index, [], 0)
    expect(score.tokens.map(t => t.text)).toEqual(['la', 'pluie'])
  })
})

// ─── Helper-word sampling and repair candidates ───────────────────────────────

describe('sampleHelperWords', () => {
  it('caps the sample at the limit', () => {
    const entries: [string, PartOfSpeech, string][] = []
    for (let i = 0; i < 200; i++) entries.push([`nom${i}`, 'noun', `nom${i}`])
    expect(sampleHelperWords(graduatedLibrary(entries), 30)).toHaveLength(30)
  })

  it('balances across word classes rather than draining the biggest one', () => {
    const entries: [string, PartOfSpeech, string][] = []
    for (let i = 0; i < 100; i++) entries.push([`nom${i}`, 'noun', `nom${i}`])
    for (let i = 0; i < 10; i++) entries.push([`verbe${i}`, 'verb', `verbe${i}`])
    const sample = sampleHelperWords(graduatedLibrary(entries), 12)
    expect(sample.filter(w => w.startsWith('verbe')).length).toBeGreaterThanOrEqual(5)
  })

  it('returns everything available when the library is smaller than the limit', () => {
    const index = graduatedLibrary([['la pluie', 'noun', 'pluie'], ['écraser', 'verb', 'écraser']])
    expect(sampleHelperWords(index, 50).sort()).toEqual(['pluie', 'écraser'].sort())
  })

  it('is deterministic for a given seed and varies across seeds', () => {
    const entries: [string, PartOfSpeech, string][] = []
    for (let i = 0; i < 20; i++) entries.push([`nom${i}`, 'noun', `nom${i}`])
    const index = graduatedLibrary(entries)
    expect(sampleHelperWords(index, 5, 3)).toEqual(sampleHelperWords(index, 5, 3))
    expect(sampleHelperWords(index, 5, 0)).not.toEqual(sampleHelperWords(index, 5, 7))
  })

  it('returns nothing for an empty library or a non-positive limit', () => {
    expect(sampleHelperWords(buildLibraryIndex([], []), 10)).toEqual([])
    expect(sampleHelperWords(healthyLibrary(), 0)).toEqual([])
  })
})

describe('repairCandidates', () => {
  it('offers only words of the requested class', () => {
    const index = graduatedLibrary([
      ['la pluie', 'noun', 'pluie'],
      ['écraser', 'verb', 'écraser'],
      ['interposer', 'verb', 'interposer'],
    ])
    expect(repairCandidates(index, 'verb', 10).sort()).toEqual(['interposer', 'écraser'].sort())
    expect(repairCandidates(index, 'noun', 10)).toEqual(['pluie'])
  })

  it('respects the limit and copes with a class the library lacks', () => {
    const index = graduatedLibrary([['la pluie', 'noun', 'pluie'], ['le vent', 'noun', 'vent']])
    expect(repairCandidates(index, 'noun', 1)).toHaveLength(1)
    expect(repairCandidates(index, 'adverb', 10)).toEqual([])
  })
})
