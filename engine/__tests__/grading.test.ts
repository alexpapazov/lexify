import { gradeTyping, normalizeAnswer, isDifferentWordMistake } from '../grading'
import type { GradingSettings } from '@/domain'

const BASE: GradingSettings = {
  accentInsensitive: false, articleOptional: false, caseInsensitive: false,
  allowOneTypo: false, acceptSlashAlternatives: false, ignoreParentheticals: false,
}

describe('normalizeAnswer', () => {
  it('strips accents when accentInsensitive is true', () => {
    expect(normalizeAnswer('corazón', { ...BASE, accentInsensitive: true })).toBe('corazon')
  })
  it('lowercases when caseInsensitive is true', () => {
    expect(normalizeAnswer('Colchón', { ...BASE, caseInsensitive: true })).toBe('colchón')
  })
  it('strips leading article when articleOptional is true', () => {
    expect(normalizeAnswer('el colchón', { ...BASE, articleOptional: true })).toBe('colchón')
  })
})

describe('gradeTyping — exact match', () => {
  it('accepts an exact match', () => {
    expect(gradeTyping('mattress', 'mattress', BASE).correct).toBe(true)
  })
  it('rejects a wrong answer', () => {
    expect(gradeTyping('pillow', 'mattress', BASE).correct).toBe(false)
  })
})

describe('gradeTyping — accent insensitivity', () => {
  const s: GradingSettings = { ...BASE, accentInsensitive: true, caseInsensitive: true }
  it('accepts "corazon" for "corazón"', () => {
    expect(gradeTyping('corazon', 'corazón', s).correct).toBe(true)
  })
  it('rejects a wrong word', () => {
    expect(gradeTyping('cabeza', 'corazón', s).correct).toBe(false)
  })
})

describe('gradeTyping — slash alternatives', () => {
  const s: GradingSettings = { ...BASE, caseInsensitive: true, acceptSlashAlternatives: true }
  it('accepts first alternative', () => {
    expect(gradeTyping('camel', 'camel / drug dealer', s).correct).toBe(true)
  })
  it('accepts second alternative', () => {
    expect(gradeTyping('drug dealer', 'camel / drug dealer', s).correct).toBe(true)
  })
  it('rejects unrelated answer', () => {
    expect(gradeTyping('horse', 'camel / drug dealer', s).correct).toBe(false)
  })
})

describe('gradeTyping — parentheticals', () => {
  const s: GradingSettings = { ...BASE, caseInsensitive: true, ignoreParentheticals: true }
  it('accepts answer without the parenthetical portion', () => {
    expect(gradeTyping('camello', '(el) camello', s).correct).toBe(true)
  })
  it('accepts answer with the parenthetical portion', () => {
    expect(gradeTyping('el camello', '(el) camello', s).correct).toBe(true)
  })
})

describe('gradeTyping — one-typo tolerance', () => {
  const s: GradingSettings = { ...BASE, caseInsensitive: true, allowOneTypo: true }
  it('accepts one-character insertion', () => {
    expect(gradeTyping('mattresss', 'mattress', s).correct).toBe(true)
  })
  it('rejects two-character difference', () => {
    expect(gradeTyping('matres', 'mattress', s).correct).toBe(false)
  })
})

describe('isDifferentWordMistake', () => {
  const s: GradingSettings = { ...BASE, caseInsensitive: true, accentInsensitive: true }
  it('is false for a blank answer', () => {
    expect(isDifferentWordMistake('', 'mattress', s)).toBe(false)
  })
  it('is false for a close typo', () => {
    expect(isDifferentWordMistake('matress', 'mattress', s)).toBe(false)
  })
  it('is false for an accent-only slip', () => {
    expect(isDifferentWordMistake('corazon', 'corazón', { ...s, accentInsensitive: false })).toBe(false)
  })
  it('is false for an article/gender-only slip', () => {
    expect(isDifferentWordMistake('la casa', 'el casa', { ...s, articleOptional: true })).toBe(false)
  })
  it('is true for a totally different word', () => {
    expect(isDifferentWordMistake('pillow', 'mattress', s)).toBe(true)
  })
})
