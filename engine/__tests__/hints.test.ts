import { hintPlan, hintGrowthFactor } from '@/lib/hints'

describe('hintPlan — alphabetic', () => {
  it('reveals first then first-two letters for a normal word', () => {
    const p = hintPlan('generalizando', 'es')
    expect(p.maxLevel).toBe(2)
    expect(p.isShortWord).toBe(false)
    expect(p.levelText).toEqual(['g', 'ge'])
  })

  it('includes a leading article but counts letters from the content word', () => {
    const p = hintPlan('el codo', 'es')
    expect(p.levelText).toEqual(['el c', 'el co'])
    expect(p.isShortWord).toBe(false)
  })

  it('works for Cyrillic', () => {
    const p = hintPlan('обобщаване', 'bg')
    expect(p.levelText[0]).toBe('о')
    expect(p.levelText[1]).toBe('об')
  })

  it('Italian space-separated article "il cane" reveals il c, il ca', () => {
    const p = hintPlan('il cane', 'it')
    expect(p.levelText).toEqual(['il c', 'il ca'])
  })

  it('Italian elided article "l\'acqua" reveals l\'a, l\'ac (not just l)', () => {
    const p = hintPlan("l'acqua", 'it')
    expect(p.levelText).toEqual(["l'a", "l'ac"])
  })

  it('two-letter word gets a single (short) hint', () => {
    const p = hintPlan('tú', 'es')
    expect(p.maxLevel).toBe(1)
    expect(p.isShortWord).toBe(true)
    expect(p.levelText).toEqual(['t'])
  })

  it('one-letter word has no hint', () => {
    expect(hintPlan('a', 'es').maxLevel).toBe(0)
  })

  it('English infinitive "to pray" skips "to" → reveals p, pr', () => {
    const p = hintPlan('to pray', 'en')
    expect(p.levelText).toEqual(['p', 'pr'])
  })

  it('"to be creepy/disgusting" skips "to be" → reveals c, cr', () => {
    const p = hintPlan('to be creepy/disgusting', 'en')
    expect(p.levelText).toEqual(['c', 'cr'])
  })

  it('quoted phrase reveals the first real letter, not the quote', () => {
    const p = hintPlan('"to crumble / fall apart"', 'en')
    expect(p.levelText[0]).toBe('c')
  })

  it('"to" is only stripped for English answers', () => {
    // In a non-English answer, a leading "to" is a real word and stays.
    expect(hintPlan('to casa', 'es').levelText[0]).toBe('t')
  })

  it('French reflexive "se laver" keeps "se " and reveals the verb → "se l", "se la"', () => {
    const p = hintPlan('se laver', 'fr')
    expect(p.maxLevel).toBe(2)
    expect(p.levelText).toEqual(['se l', 'se la'])
  })

  it('French elided reflexive "s\'appeler" keeps "s\'" → "s\'a", "s\'ap"', () => {
    const p = hintPlan("s'appeler", 'fr')
    expect(p.levelText).toEqual(["s'a", "s'ap"])
  })

  it('a French word merely starting with "se" (no space) is NOT treated as reflexive', () => {
    // "semaine" → normal reveal from the first letter, "se " prefix logic must not fire.
    const p = hintPlan('semaine', 'fr')
    expect(p.levelText).toEqual(['s', 'se'])
  })

  it('reflexive handling is French-only', () => {
    // Same string in another language reveals normally (no reflexive marker).
    expect(hintPlan('se laver', 'es').levelText[0]).toBe('s')
  })
})

describe('hintPlan — Korean (full first syllable, one level only)', () => {
  it('안락 → reveals the full first syllable 안, one level', () => {
    const p = hintPlan('안락', 'ko')
    expect(p.maxLevel).toBe(1)
    expect(p.levelText).toEqual(['안'])
  })

  it('각시 → reveals 각 (full first syllable), one level', () => {
    const p = hintPlan('각시', 'ko')
    expect(p.maxLevel).toBe(1)
    expect(p.levelText).toEqual(['각'])
  })

  it('two-syllable word → one hint, isShortWord true (bigger penalty)', () => {
    const p = hintPlan('가방', 'ko')
    expect(p.maxLevel).toBe(1)
    expect(p.isShortWord).toBe(true)
    expect(p.levelText).toEqual(['가'])
  })

  it('three-syllable word → one hint, isShortWord false', () => {
    const p = hintPlan('사용자', 'ko')
    expect(p.maxLevel).toBe(1)
    expect(p.isShortWord).toBe(false)
    expect(p.levelText).toEqual(['사'])
  })

  it('single-syllable word (with final consonant) → NO hint', () => {
    expect(hintPlan('손', 'ko').maxLevel).toBe(0)
  })

  it('single-syllable word (no final consonant) → NO hint', () => {
    expect(hintPlan('차', 'ko').maxLevel).toBe(0)
  })
})

describe('hintGrowthFactor', () => {
  it('normal word: 0.65 then 0.40', () => {
    expect(hintGrowthFactor(1, false)).toBeCloseTo(0.65)
    expect(hintGrowthFactor(2, false)).toBeCloseTo(0.40)
  })
  it('short word: always 0.35', () => {
    expect(hintGrowthFactor(1, true)).toBeCloseTo(0.35)
  })
  it('no hint: 1 (no dampening)', () => {
    expect(hintGrowthFactor(0, false)).toBe(1)
  })
})
