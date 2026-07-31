import { normalizeFrontKey, partitionExistingFronts } from '../duplicates'
import type { Card } from '@/domain'

function card(front: string, back = 'gloss'): Card {
  return { front, back, id: front, ownerId: 'u', sourceLanguage: 'es', targetLanguage: 'en',
    hints: [], choices: null, position: 0, createdAt: '', updatedAt: '', deletedAt: null } as Card
}

describe('normalizeFrontKey', () => {
  it('is case-insensitive and whitespace-collapsed', () => {
    expect(normalizeFrontKey('  El   Pan ', 'es')).toBe(normalizeFrontKey('el pan', 'es'))
  })

  it('strips one leading article', () => {
    expect(normalizeFrontKey('el pan', 'es')).toBe(normalizeFrontKey('pan', 'es'))
    expect(normalizeFrontKey("l'eau", 'fr')).toBe(normalizeFrontKey('eau', 'fr'))
    expect(normalizeFrontKey('το απόγευμα', 'el')).toBe(normalizeFrontKey('απόγευμα', 'el'))
  })

  it('strips grammatical gender/number tags', () => {
    expect(normalizeFrontKey('la miel (f)', 'es')).toBe(normalizeFrontKey('la miel', 'es'))
    expect(normalizeFrontKey('gafas (pl)', 'es')).toBe(normalizeFrontKey('gafas', 'es'))
  })

  it('keeps genuinely different words apart', () => {
    expect(normalizeFrontKey('pan', 'es')).not.toBe(normalizeFrontKey('pana', 'es'))
  })

  it('does not strip a meaningful parenthetical', () => {
    expect(normalizeFrontKey('(el) camello', 'es')).not.toBe(normalizeFrontKey('camello', 'es'))
  })
})

describe('partitionExistingFronts', () => {
  it('drops candidates already in the library, ignoring the gloss', () => {
    const existing = [card('el pan', 'bread')]
    const { fresh, skipped } = partitionExistingFronts(
      [{ front: 'el pan', back: 'loaf' }, { front: 'la leche', back: 'milk' }], existing, 'es')
    expect(fresh.map(c => c.front)).toEqual(['la leche'])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.existing.back).toBe('bread')
  })

  it('matches across article, case and tag differences', () => {
    const existing = [card('El Pan'), card('la miel (f)')]
    const { fresh, skipped } = partitionExistingFronts(
      [{ front: 'pan', back: 'bread' }, { front: 'miel', back: 'honey' }], existing, 'es')
    expect(fresh).toHaveLength(0)
    expect(skipped).toHaveLength(2)
  })

  it('de-dupes within the candidate list too, first occurrence winning', () => {
    const { fresh, skipped } = partitionExistingFronts(
      [{ front: 'el pan', back: 'bread' }, { front: 'pan', back: 'loaf' }, { front: 'PAN', back: 'x' }],
      [], 'es')
    expect(fresh.map(c => c.back)).toEqual(['bread'])
    expect(skipped).toHaveLength(2)
  })

  it('passes everything through when the library is empty', () => {
    const items = [{ front: 'uno', back: 'one' }, { front: 'dos', back: 'two' }]
    expect(partitionExistingFronts(items, [], 'es').fresh).toHaveLength(2)
  })

  it('preserves candidate order', () => {
    const existing = [card('dos')]
    const { fresh } = partitionExistingFronts(
      [{ front: 'uno', back: '1' }, { front: 'dos', back: '2' }, { front: 'tres', back: '3' }], existing, 'es')
    expect(fresh.map(c => c.front)).toEqual(['uno', 'tres'])
  })
})
