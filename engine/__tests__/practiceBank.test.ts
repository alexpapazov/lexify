import {
  plannedTotal, planGenerationBatches,
  type SentencePlan,
} from '../practiceBank'
import type { PracticeTarget } from '../practice'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function target(lemma: string): PracticeTarget {
  return { cardId: `c-${lemma}`, front: lemma, back: `gloss of ${lemma}`, lemma, pos: 'noun' }
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

