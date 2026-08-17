import {
  plannedTotal, planGenerationBatches, pickBankExercises,
  type SentencePlan, type BankCandidate,
} from '../practiceBank'
import type { PracticeTarget } from '../practice'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function target(lemma: string): PracticeTarget {
  return { cardId: `c-${lemma}`, front: lemma, back: `gloss of ${lemma}`, lemma, pos: 'noun' }
}

/** A stored sentence for `lemma`. */
function stored(id: string, lemma: string, useCount = 0): BankCandidate {
  return { id, targetLemma: lemma, useCount }
}

// ─── plannedTotal ─────────────────────────────────────────────────────────────

describe('plannedTotal', () => {
  it('is the count itself in total mode, regardless of how many words are chosen', () => {
    expect(plannedTotal({ mode: 'total', count: 5 }, 20)).toBe(5)
  })

  it('scales with the word count in per-word mode', () => {
    expect(plannedTotal({ mode: 'perWord', perWord: 2 }, 7)).toBe(14)
  })

  it('never goes negative', () => {
    expect(plannedTotal({ mode: 'total', count: -3 }, 5)).toBe(0)
    expect(plannedTotal({ mode: 'perWord', perWord: -1 }, 5)).toBe(0)
  })
})

// ─── planGenerationBatches ────────────────────────────────────────────────────

describe('planGenerationBatches', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map(target)

  it('total mode: every batch sees all the words, so the model spreads over them', () => {
    const batches = planGenerationBatches(five, { mode: 'total', count: 3 }, 10)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.count).toBe(3)
    expect(batches[0]!.targets).toHaveLength(5)
  })

  it('total mode: splits a large request into cap-sized batches', () => {
    const batches = planGenerationBatches(five, { mode: 'total', count: 25 }, 10)
    expect(batches.map(b => b.count)).toEqual([10, 10, 5])
  })

  it('per-word mode: groups words so each batch fits the cap', () => {
    // cap 10, 2 per word → 5 words per batch.
    const ten = Array.from({ length: 10 }, (_, i) => target(`w${i}`))
    const batches = planGenerationBatches(ten, { mode: 'perWord', perWord: 2 }, 10)
    expect(batches).toHaveLength(2)
    expect(batches.every(b => b.targets.length === 5 && b.count === 10)).toBe(true)
  })

  it('per-word mode: covers every word exactly once across the batches', () => {
    const seven = Array.from({ length: 7 }, (_, i) => target(`w${i}`))
    const batches = planGenerationBatches(seven, { mode: 'perWord', perWord: 3 }, 10)
    const covered = batches.flatMap(b => b.targets.map(t => t.lemma))
    expect(covered.sort()).toEqual(seven.map(t => t.lemma).sort())
  })

  it('per-word mode: never asks for more than the cap, even when one word wants more', () => {
    const batches = planGenerationBatches([target('a')], { mode: 'perWord', perWord: 25 }, 10)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.count).toBe(10)
  })

  it('returns nothing for no words, a zero cap, or a zero request', () => {
    expect(planGenerationBatches([], { mode: 'total', count: 5 }, 10)).toEqual([])
    expect(planGenerationBatches(five, { mode: 'total', count: 5 }, 0)).toEqual([])
    expect(planGenerationBatches(five, { mode: 'total', count: 0 }, 10)).toEqual([])
    expect(planGenerationBatches(five, { mode: 'perWord', perWord: 0 }, 10)).toEqual([])
  })
})

// ─── pickBankExercises ────────────────────────────────────────────────────────

describe('pickBankExercises', () => {
  const targets = [target('pluie'), target('vent')]

  it('reuses any stored sentence for a requested word — no re-scoring, sentences are unconstrained', () => {
    const bank = [stored('s1', 'pluie')]
    const { reuse } = pickBankExercises(bank, targets, { mode: 'total', count: 5 })
    expect(reuse.map(r => r.id)).toEqual(['s1'])
  })

  it('ignores stored sentences for words this session did not ask for', () => {
    const bank = [stored('s1', 'orage')]
    const { reuse } = pickBankExercises(bank, targets, { mode: 'total', count: 5 })
    expect(reuse).toEqual([])
  })

  it('serves least-used sentences first', () => {
    const bank = [stored('used', 'pluie', 4), stored('fresh', 'pluie', 0)]
    const { reuse } = pickBankExercises(bank, [target('pluie')], { mode: 'total', count: 1 })
    expect(reuse.map(r => r.id)).toEqual(['fresh'])
  })

  it('round-robins across words instead of draining one word’s bank', () => {
    const bank = [
      stored('p1', 'pluie'), stored('p2', 'pluie'), stored('p3', 'pluie'),
      stored('v1', 'vent'),
    ]
    const { reuse } = pickBankExercises(bank, targets, { mode: 'total', count: 2 })
    expect(reuse.map(r => r.targetLemma)).toEqual(['pluie', 'vent'])
  })

  it('stops at the requested total', () => {
    const bank = Array.from({ length: 10 }, (_, i) => stored(`s${i}`, 'pluie'))
    const { reuse } = pickBankExercises(bank, [target('pluie')], { mode: 'total', count: 3 })
    expect(reuse).toHaveLength(3)
  })

  it('per-word mode: caps each word at its quota', () => {
    const bank = [
      stored('p1', 'pluie'), stored('p2', 'pluie'), stored('p3', 'pluie'),
      stored('v1', 'vent'),
    ]
    const { reuse } = pickBankExercises(bank, targets, { mode: 'perWord', perWord: 2 })
    const byLemma = reuse.reduce<Record<string, number>>((acc, r) => {
      acc[r.targetLemma] = (acc[r.targetLemma] ?? 0) + 1; return acc
    }, {})
    expect(byLemma).toEqual({ pluie: 2, vent: 1 })
  })

  it('per-word mode: reports what each word still needs', () => {
    const bank = [stored('p1', 'pluie')]
    const { shortfallByLemma } = pickBankExercises(bank, targets, { mode: 'perWord', perWord: 2 })
    expect(shortfallByLemma.get('pluie')).toBe(1)
    expect(shortfallByLemma.get('vent')).toBe(2)
  })

  it('per-word mode: reports no shortfall when the bank covers everything', () => {
    const bank = [stored('p1', 'pluie'), stored('v1', 'vent')]
    const { shortfallByLemma } = pickBankExercises(bank, targets, { mode: 'perWord', perWord: 1 })
    expect(shortfallByLemma.size).toBe(0)
  })

  it('handles an empty bank', () => {
    const { reuse, shortfallByLemma } = pickBankExercises([], targets, { mode: 'perWord', perWord: 2 })
    expect(reuse).toEqual([])
    expect(shortfallByLemma.get('vent')).toBe(2)
  })

  it('matches lemmas case- and whitespace-insensitively', () => {
    const bank = [{ id: 's1', targetLemma: '  Pluie ', useCount: 0 }]
    const { reuse } = pickBankExercises(bank, [target('pluie')], { mode: 'total', count: 1 })
    expect(reuse.map(r => r.id)).toEqual(['s1'])
  })
})
