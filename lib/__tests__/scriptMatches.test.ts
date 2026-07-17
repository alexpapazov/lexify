import { scriptMatches } from '@/lib/distractors'

describe('scriptMatches — distractor must share the answer script', () => {
  it('rejects a CJK distractor for a Cyrillic answer (the reported bug)', () => {
    expect(scriptMatches('стопанство (n)', '状態 (n)')).toBe(false)
  })
  it('accepts same-script Cyrillic distractors', () => {
    expect(scriptMatches('стопанство (n)', 'занаятчия (m)')).toBe(true)
    expect(scriptMatches('стопанство (n)', 'укрепление (n)')).toBe(true)
  })
  it('accepts Latin-among-Latin and rejects cross-script for Latin answers', () => {
    expect(scriptMatches('la casa', 'el perro')).toBe(true)
    expect(scriptMatches('la casa', '状態')).toBe(false)
    expect(scriptMatches('la casa', 'стопанство')).toBe(false)
  })
  it('ignores parenthetical annotations when judging script', () => {
    expect(scriptMatches('стопанство (n)', 'явление (n)')).toBe(true)   // (n) is Latin but ignored
  })
  it('keeps Korean vs Japanese distinct (different scripts)', () => {
    expect(scriptMatches('상태', '状態')).toBe(false)   // Hangul vs CJK
  })
})
