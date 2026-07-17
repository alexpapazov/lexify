import { assignLanguageColors, LANG_COLOR_PALETTE } from '@/lib/languages'

describe('assignLanguageColors', () => {
  it('gives every language a distinct color when the set fits the palette', () => {
    const codes = ['ko', 'es', 'fr', 'it', 'bg', 'el']
    const map = assignLanguageColors(codes)
    const colors = codes.map(c => map[c])
    expect(new Set(colors).size).toBe(codes.length)   // all distinct
    colors.forEach(c => expect(LANG_COLOR_PALETTE).toContain(c))
  })

  it('honors a valid override and never reuses its color for another language', () => {
    const codes = ['ko', 'es', 'fr']
    const map = assignLanguageColors(codes, { es: '#7c6af7' })
    expect(map.es).toBe('#7c6af7')
    expect(map.ko).not.toBe('#7c6af7')
    expect(map.fr).not.toBe('#7c6af7')
    expect(map.ko).not.toBe(map.fr)
  })

  it('is deterministic for the same set + overrides', () => {
    const a = assignLanguageColors(['fr', 'es', 'ko'])
    const b = assignLanguageColors(['ko', 'fr', 'es'])   // order-independent (sorted internally)
    expect(a).toEqual(b)
  })

  it('ignores an invalid override hex and falls back to a distinct default', () => {
    const map = assignLanguageColors(['ko', 'es'], { ko: 'not-a-color' })
    expect(LANG_COLOR_PALETTE).toContain(map.ko)
    expect(map.ko).not.toBe(map.es)
  })
})
