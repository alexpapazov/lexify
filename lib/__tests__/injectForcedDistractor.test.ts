import { injectForcedDistractor, OPTIONS_NEEDED } from '@/lib/distractors'
import type { Card } from '@/domain'

const card = (front: string, frontChoices: string[]): Card => ({
  id: 'a', front, back: 'artisan',
  choices: { front: frontChoices, back: [] },
} as unknown as Card)

describe('injectForcedDistractor', () => {
  const need = OPTIONS_NEEDED - 1   // distractors per MCQ (3)

  it('swaps the word into the last slot when the pool is full', () => {
    const c = card('занаятчия', ['куче', 'котка', 'риба'])   // full pool (3)
    const out = injectForcedDistractor(c, 'front', 'занаятчийка')!
    expect(out.front).toHaveLength(need)
    expect(out.front).toContain('занаятчийка')
    expect(out.front[out.front.length - 1]).toBe('занаятчийка')
  })

  it('appends when the pool is not yet full', () => {
    const out = injectForcedDistractor(card('gato', ['perro']), 'front', 'pato')!
    expect(out.front).toEqual(['perro', 'pato'])
  })

  it('is a no-op when the word is already a distractor', () => {
    expect(injectForcedDistractor(card('gato', ['pato', 'perro', 'lobo']), 'front', 'pato')).toBeNull()
  })

  it('never injects the correct answer or a blank', () => {
    expect(injectForcedDistractor(card('gato', ['perro']), 'front', 'gato')).toBeNull()
    expect(injectForcedDistractor(card('gato', ['perro']), 'front', '   ')).toBeNull()
  })
})
