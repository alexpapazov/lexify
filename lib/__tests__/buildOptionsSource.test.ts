import { buildOptions } from '../distractors'
import type { Card } from '@/domain'

/** Minimal card; only the fields buildOptions reads matter. */
function card(id: string, front: string, back: string, choices: Card['choices'] = null): Card {
  return {
    id, ownerId: 'u1', front, back, position: 0, choices,
    sourceLanguage: 'es', targetLanguage: 'en',
  } as unknown as Card
}

const AI = ['ai-one', 'ai-two', 'ai-three']
const subject = card('c1', 'gato', 'cat', { front: [], back: AI } as unknown as Card['choices'])
// Enough siblings to fill the option set from the deck alone.
const deck = [
  subject,
  card('c2', 'perro', 'dog'),
  card('c3', 'pájaro', 'bird'),
  card('c4', 'caballo', 'horse'),
  card('c5', 'ratón', 'mouse'),
]

describe('buildOptions — distractorSource', () => {
  it("uses the AI pool by default ('smart')", () => {
    const opts = buildOptions(subject, 'back', deck)
    expect(opts).toContain('cat')
    expect(opts.filter(o => AI.includes(o)).length).toBeGreaterThan(0)
  })

  it("IGNORES cached AI distractors when the rung asks for 'deck'", () => {
    // The regression: AI distractors are generated in the background regardless of this setting, and
    // were preferred the moment they landed — so "other cards in the deck" silently stopped applying.
    const opts = buildOptions(subject, 'back', deck, undefined, 'deck')
    expect(opts).toContain('cat')
    expect(opts.filter(o => AI.includes(o))).toEqual([])
    for (const o of opts.filter(o => o !== 'cat')) {
      expect(['dog', 'bird', 'horse', 'mouse']).toContain(o)
    }
  })

  it("falls back to AI distractors when the deck is too small to fill the options", () => {
    // An unanswerable two-option question is worse than borrowing from the wrong pool.
    const tiny = [subject, card('c2', 'perro', 'dog')]
    const opts = buildOptions(subject, 'back', tiny, undefined, 'deck')
    expect(opts).toHaveLength(4)
    expect(opts).toContain('cat')
    expect(opts).toContain('dog')
    expect(opts.filter(o => AI.includes(o)).length).toBe(2)
  })

  it("still respects excluded texts under 'deck'", () => {
    const opts = buildOptions(subject, 'back', deck, ['dog'], 'deck')
    expect(opts).not.toContain('dog')
  })
})
