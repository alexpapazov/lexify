import { splitForBlank, segmentFlagged } from '@/lib/practiceRender'

describe('splitForBlank', () => {
  it('splits around the first occurrence of the answer', () => {
    expect(splitForBlank('Il se précipite vers la porte.', 'précipite'))
      .toEqual({ before: 'Il se ', after: ' vers la porte.' })
  })

  it('handles an answer at the start or end', () => {
    expect(splitForBlank('Pluie partout.', 'Pluie')).toEqual({ before: '', after: ' partout.' })
    expect(splitForBlank('Voici la pluie', 'pluie')).toEqual({ before: 'Voici la ', after: '' })
  })

  it('returns null when the answer is absent', () => {
    expect(splitForBlank('Il se précipite.', 'neige')).toBeNull()
  })
})

describe('segmentFlagged', () => {
  it('returns one plain run when nothing is flagged', () => {
    expect(segmentFlagged('Il se précipite.', [])).toEqual([{ text: 'Il se précipite.', flagged: false }])
  })

  it('marks a flagged word and carries its gloss', () => {
    const segments = segmentFlagged('Vers le tonnerre.', [{ text: 'tonnerre', gloss: 'thunder' }])
    expect(segments.filter(s => s.flagged)).toEqual([{ text: 'tonnerre', flagged: true, gloss: 'thunder' }])
  })

  it('preserves punctuation and spacing exactly', () => {
    const segments = segmentFlagged('Vers le tonnerre, oui.', [{ text: 'tonnerre', gloss: 'thunder' }])
    expect(segments.map(s => s.text).join('')).toBe('Vers le tonnerre, oui.')
  })

  it('matches a sentence-initial flagged word despite the capital', () => {
    const segments = segmentFlagged('Tonnerre partout.', [{ text: 'tonnerre', gloss: 'thunder' }])
    expect(segments.find(s => s.flagged)?.text).toBe('Tonnerre')
  })

  it('does not flag a word that merely contains the flagged one', () => {
    const segments = segmentFlagged('Le pou est là.', [{ text: 'ou', gloss: 'or' }])
    expect(segments.some(s => s.flagged)).toBe(false)
  })

  it('keeps accented and apostrophised words whole', () => {
    const segments = segmentFlagged("L'extase était forte.", [{ text: 'était', gloss: 'was' }])
    expect(segments.find(s => s.flagged)?.text).toBe('était')
    expect(segments.map(s => s.text).join('')).toBe("L'extase était forte.")
  })

  it('flags every occurrence of the same word', () => {
    const segments = segmentFlagged('Tonnerre et tonnerre.', [{ text: 'tonnerre', gloss: 'thunder' }])
    expect(segments.filter(s => s.flagged)).toHaveLength(2)
  })

  it('returns nothing for empty text', () => {
    expect(segmentFlagged('', [])).toEqual([])
  })
})
