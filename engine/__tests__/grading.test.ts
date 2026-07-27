import { gradeTyping, normalizeAnswer, isDifferentWordMistake } from '../grading'
import type { GradingSettings } from '@/domain'

// A minimal strict-mode base (no leniency)
const STRICT: GradingSettings = {
  gradingMode: 'strict',
  ignoreAccents: false, ignoreCapitalization: false, ignoreMinorTypos: false,
  ignoreDefiniteArticles: false, requireParentheticalContent: true,
  slashAlternativesMode: 'accept_any', commaAlternativesMode: 'split_into_cards',
  autoPlayAudio: false,
}

// A flexible base with all toggles OFF
const FLEX_BASE: GradingSettings = {
  gradingMode: 'flexible',
  ignoreAccents: false, ignoreCapitalization: false, ignoreMinorTypos: false,
  ignoreDefiniteArticles: false, requireParentheticalContent: true,
  slashAlternativesMode: 'accept_any', commaAlternativesMode: 'split_into_cards',
  autoPlayAudio: false,
}

describe('normalizeAnswer', () => {
  it('strips accents when ignoreAccents is true', () => {
    expect(normalizeAnswer('corazón', { ...FLEX_BASE, ignoreAccents: true })).toBe('corazon')
  })
  it('lowercases when ignoreCapitalization is true', () => {
    expect(normalizeAnswer('Colchón', { ...FLEX_BASE, ignoreCapitalization: true })).toBe('colchón')
  })
  it('strips leading article when ignoreDefiniteArticles is true', () => {
    expect(normalizeAnswer('el colchón', { ...FLEX_BASE, ignoreDefiniteArticles: true })).toBe('colchón')
  })
  it('strips a Greek definite article when ignoreDefiniteArticles is true', () => {
    const s = { ...FLEX_BASE, ignoreDefiniteArticles: true, answerLanguage: 'el' }
    expect(normalizeAnswer('το απόγευμα', s)).toBe('απόγευμα')
    expect(normalizeAnswer('η μέρα', s)).toBe('μέρα')
    // FLEX_BASE has ignoreCapitalization: false, so the capital survives the strip.
    expect(normalizeAnswer('της Ελλάδας', s)).toBe('Ελλάδας')
  })
  it('strips a Greek indefinite article with accents already removed', () => {
    // ignoreAccents runs BEFORE the article strip, so the bare form is what reaches the lookup —
    // this is why both 'ένα' and 'ενα' are listed for Greek.
    const s = { ...FLEX_BASE, ignoreAccents: true, ignoreDefiniteArticles: true, answerLanguage: 'el' }
    expect(normalizeAnswer('ένα βιβλίο', s)).toBe('βιβλιο')
  })
  it('strict mode only lowercases (no accent strip)', () => {
    expect(normalizeAnswer('Corazón', STRICT)).toBe('corazón')
  })
})

describe('gradeTyping — strict mode', () => {
  it('accepts exact match (case-insensitive)', () => {
    expect(gradeTyping('Mattress', 'mattress', STRICT).status).toBe('correct')
  })
  it('rejects wrong answer', () => {
    expect(gradeTyping('pillow', 'mattress', STRICT).status).toBe('incorrect')
  })
  it('accepts slash alternative in strict mode', () => {
    expect(gradeTyping('drug dealer', 'camel / drug dealer', STRICT).status).toBe('correct')
  })
  it('accent difference is incorrect in strict mode (no almost)', () => {
    expect(gradeTyping('corazon', 'corazón', STRICT).status).toBe('incorrect')
  })
})

describe('gradeTyping — flexible exact match', () => {
  const s: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true }
  it('accepts an exact match', () => {
    expect(gradeTyping('mattress', 'mattress', s).correct).toBe(true)
  })
  it('rejects a wrong answer', () => {
    expect(gradeTyping('pillow', 'mattress', s).correct).toBe(false)
  })
})

describe('gradeTyping — flexible accent handling', () => {
  it('returns correct when ignoreAccents=true', () => {
    const s: GradingSettings = { ...FLEX_BASE, ignoreAccents: true, ignoreCapitalization: true }
    expect(gradeTyping('corazon', 'corazón', s).status).toBe('correct')
  })
  it('returns almost when ignoreAccents=false', () => {
    const s: GradingSettings = { ...FLEX_BASE, ignoreAccents: false, ignoreCapitalization: true }
    expect(gradeTyping('corazon', 'corazón', s).status).toBe('almost')
    expect(gradeTyping('corazon', 'corazón', s).issueType).toBe('accent')
  })
})

describe('gradeTyping — slash alternatives (flexible)', () => {
  const s: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true, slashAlternativesMode: 'accept_any' }
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
  it('accepts without parens when requireParentheticalContent=false', () => {
    const s: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true, requireParentheticalContent: false }
    expect(gradeTyping('camello', '(el) camello', s).correct).toBe(true)
    expect(gradeTyping('el camello', '(el) camello', s).correct).toBe(true)
  })
  it('almost when parens required but user omits them', () => {
    const s: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true, requireParentheticalContent: true }
    expect(gradeTyping('camello', '(el) camello', s).status).toBe('almost')
    expect(gradeTyping('camello', '(el) camello', s).issueType).toBe('parenthetical')
  })
  it('correct when user includes paren content', () => {
    const s: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true, requireParentheticalContent: true }
    expect(gradeTyping('el camello', '(el) camello', s).status).toBe('correct')
  })
})

describe('gradeTyping — typo tolerance (flexible)', () => {
  it('returns correct when ignoreMinorTypos=true', () => {
    const s: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true, ignoreMinorTypos: true }
    expect(gradeTyping('mattresss', 'mattress', s).status).toBe('correct')
  })
  it('returns almost when ignoreMinorTypos=false and edit distance=1', () => {
    const s: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true, ignoreMinorTypos: false }
    expect(gradeTyping('mattresss', 'mattress', s).status).toBe('almost')
    expect(gradeTyping('mattresss', 'mattress', s).issueType).toBe('typo')
  })
  it('rejects two-character difference', () => {
    const s: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true, ignoreMinorTypos: false }
    expect(gradeTyping('matres', 'mattress', s).status).toBe('incorrect')
  })
})

describe('isDifferentWordMistake', () => {
  const s: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true, ignoreAccents: true }
  it('is false for a blank answer', () => {
    expect(isDifferentWordMistake('', 'mattress', s)).toBe(false)
  })
  it('is false for a close typo', () => {
    expect(isDifferentWordMistake('matress', 'mattress', s)).toBe(false)
  })
  it('is false for an accent-only slip', () => {
    expect(isDifferentWordMistake('corazon', 'corazón', { ...s, ignoreAccents: false })).toBe(false)
  })
  it('is false for an article-only slip', () => {
    expect(isDifferentWordMistake('la casa', 'el casa', { ...s, ignoreDefiniteArticles: true })).toBe(false)
  })
  it('is true for a totally different word', () => {
    expect(isDifferentWordMistake('pillow', 'mattress', s)).toBe(true)
  })
})
