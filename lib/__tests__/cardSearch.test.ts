import { cardMatchesSearch } from '@/lib/cardSearch'

describe('cardMatchesSearch', () => {
  it('matches word prefixes on the front', () => {
    expect(cardMatchesSearch('se', 'se précipiter', 'to rush')).toBe(true)
    expect(cardMatchesSearch('préc', 'se précipiter', 'to rush')).toBe(true)
    expect(cardMatchesSearch('sent', 'sentir', 'to feel')).toBe(true)
  })

  it('matches word prefixes on the back', () => {
    expect(cardMatchesSearch('rush', 'se précipiter', 'to rush')).toBe(true)
  })

  it('does NOT match mid-word substrings (the "se" noise from the library search)', () => {
    expect(cardMatchesSearch('se', 'le pou', 'louse')).toBe(false)
    expect(cardMatchesSearch('se', 'écraser', 'to crush')).toBe(false)
    expect(cardMatchesSearch('se', "l'accusateur (m)", 'accuser')).toBe(false)
    expect(cardMatchesSearch('se', 'interposer', 'to interpose')).toBe(false)
    // A word that genuinely STARTS with the query still matches — that's the rule, not noise.
    expect(cardMatchesSearch('se', 'le fléau', 'scourge (severe hardship)')).toBe(true)
  })

  it('is accent-insensitive in both directions', () => {
    expect(cardMatchesSearch('ecras', 'écraser', 'to crush')).toBe(true)
    expect(cardMatchesSearch('écras', 'ecraser', 'to crush')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(cardMatchesSearch('SE', 'se précipiter', 'to rush')).toBe(true)
  })

  it('splits on apostrophes, parentheses and hyphens', () => {
    expect(cardMatchesSearch('extase', "l'extase (f)", 'ecstasy')).toBe(true)
    expect(cardMatchesSearch('l', "l'extase (f)", 'ecstasy')).toBe(true)
    expect(cardMatchesSearch('etre', 'peut-être', 'maybe')).toBe(true)
  })

  it('requires every query token to prefix some word', () => {
    expect(cardMatchesSearch('se pre', 'se précipiter', 'to rush')).toBe(true)
    expect(cardMatchesSearch('se laver', 'se précipiter', 'to rush')).toBe(false)
  })

  it('matches nothing on an empty or whitespace query', () => {
    expect(cardMatchesSearch('', 'se précipiter', 'to rush')).toBe(false)
    expect(cardMatchesSearch('   ', 'se précipiter', 'to rush')).toBe(false)
  })
})
