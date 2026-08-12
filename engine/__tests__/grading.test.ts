import { gradeTyping, normalizeAnswer, isDifferentWordMistake, leadingArticle, stripLeadingArticle, sameWording } from '../grading'
import type { GradingSettings } from '@/domain'

// A minimal strict-mode base (no leniency)
const STRICT: GradingSettings = {
  gradingMode: 'strict',
  ignoreAccents: false, ignoreCapitalization: false, ignoreMinorTypos: false,
  ignoreDefiniteArticles: false, requireParentheticalContent: true,
  commaAlternativesMode: 'split_into_cards',
  autoPlayAudio: false,
}

// A flexible base with all toggles OFF
const FLEX_BASE: GradingSettings = {
  gradingMode: 'flexible',
  ignoreAccents: false, ignoreCapitalization: false, ignoreMinorTypos: false,
  ignoreDefiniteArticles: false, requireParentheticalContent: true,
  commaAlternativesMode: 'split_into_cards',
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
  it('accepts slash alternative in strict mode on the NATIVE side', () => {
    expect(gradeTyping('drug dealer', 'camel / drug dealer', { ...STRICT, isNativeAnswer: true }).status).toBe('correct')
  })
  it('requires the full string in strict mode on the TARGET side', () => {
    expect(gradeTyping('drug dealer', 'camel / drug dealer', STRICT).status).toBe('incorrect')
    expect(gradeTyping('camel / drug dealer', 'camel / drug dealer', STRICT).status).toBe('correct')
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

describe('gradeTyping — slash/comma/semicolon alternatives are decided by SIDE', () => {
  const native: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true, isNativeAnswer: true }
  const target: GradingSettings = { ...FLEX_BASE, ignoreCapitalization: true }

  it('NATIVE side: accepts either alternative', () => {
    expect(gradeTyping('camel', 'camel / drug dealer', native).correct).toBe(true)
    expect(gradeTyping('drug dealer', 'camel / drug dealer', native).correct).toBe(true)
  })
  it('NATIVE side: typing EVERYTHING is also correct (user-reported: it used to fail)', () => {
    // Dictation showed "to visit/tour" typed verbatim graded wrong — splitting produced only the
    // parts, never the whole string. The whole string must always be a candidate.
    expect(gradeTyping('to visit/tour', 'to visit/tour', native).correct).toBe(true)
    expect(gradeTyping('camel / drug dealer', 'camel / drug dealer', native).correct).toBe(true)
  })
  it('NATIVE side: rejects an unrelated answer', () => {
    expect(gradeTyping('horse', 'camel / drug dealer', native).correct).toBe(false)
  })
  it('NATIVE side: splits on comma and semicolon too', () => {
    expect(gradeTyping('quick', 'quick, fast; rapid', native).correct).toBe(true)
    expect(gradeTyping('rapid', 'quick, fast; rapid', native).correct).toBe(true)
  })
  it('TARGET side: one alternative alone is NOT enough — type everything', () => {
    expect(gradeTyping('견학하다', '견학하다/방문하다', target).correct).toBe(false)
    expect(gradeTyping('견학하다/방문하다', '견학하다/방문하다', target).correct).toBe(true)
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

describe('elided articles are not mistaken for article errors', () => {
  // FLEX_BASE has every leniency OFF, so a near-miss surfaces as 'almost' with its issueType rather
  // than being silently accepted — which is what these assertions are about.
  const italian: GradingSettings = { ...FLEX_BASE, answerLanguage: 'it' }

  it('a misspelling inside an elided-article word is a SPELLING error, not an article one', () => {
    // The reported bug: "l'attezzo" (missing r) vs "l'attrezzo (m)" was blamed on the article,
    // because whitespace splitting never saw the elided "l'" and so the "same article ⇒ just a
    // typo" guard could not fire.
    const r = gradeTyping("l'attezzo", "l'attrezzo (m)", italian)
    expect(r.status).toBe('almost')
    expect(r.issueType).not.toBe('article')
    expect(r.issueType).toBe('typo')
  })

  it('still calls it an article error when the article really differs', () => {
    const r = gradeTyping('lo attrezzo', "l'attrezzo", italian)
    expect(r.issueType).toBe('article')
  })

  it('still calls it an article error when the article is missing entirely', () => {
    const r = gradeTyping('attrezzo', "l'attrezzo", italian)
    expect(r.issueType).toBe('article')
  })

  it('an exact match with the elided article is simply correct', () => {
    expect(gradeTyping("l'attrezzo", "l'attrezzo (m)", italian).status).toBe('correct')
  })

  it('same behaviour in French', () => {
    const fr = { ...italian, answerLanguage: 'fr' }
    expect(gradeTyping("l'eua", "l'eeau", fr).issueType).toBe('typo')
    expect(gradeTyping("le eau", "l'eau", fr).issueType).toBe('article')
  })

  it('space-separated articles are unaffected', () => {
    const es = { ...italian, answerLanguage: 'es' }
    expect(gradeTyping('el pingüno', 'el pingüino', es).issueType).toBe('typo')
    expect(gradeTyping('la pingüino', 'el pingüino', es).issueType).toBe('article')
    expect(gradeTyping('pengüino', 'el pingüino', es).issueType).toBe('article')
  })
})

describe('leadingArticle', () => {
  it('finds a space-separated article', () => {
    expect(leadingArticle('el pan', 'es')).toBe('el')
  })
  it('finds an elided article, straight or curly', () => {
    expect(leadingArticle("l'attrezzo", 'it')).toBe("l'")
    expect(leadingArticle('l’attrezzo', 'it')).toBe("l'")
  })
  it("is '' when there is no article", () => {
    expect(leadingArticle('attrezzo', 'it')).toBe('')
    expect(leadingArticle('pan', 'es')).toBe('')
  })
  it("is '' for a lone article with nothing after it", () => {
    expect(leadingArticle('el', 'es')).toBe('')
  })
  it('agrees with stripLeadingArticle about whether an article was there', () => {
    for (const [s, lang] of [["l'attrezzo", 'it'], ['el pan', 'es'], ['attrezzo', 'it'], ['pan', 'es']] as const) {
      const stripped = stripLeadingArticle(s, lang)
      expect(leadingArticle(s, lang) !== '').toBe(stripped !== s)
    }
  })
})

describe('sameWording — gates the "Card says" note', () => {
  it('treats apostrophe styles as the same wording', () => {
    expect(sameWording("l'agnello", 'l’agnello')).toBe(true)
    expect(sameWording('l’agnello', "l'agnello")).toBe(true)
    expect(sameWording("d'accordo", 'd´accordo')).toBe(true)
  })

  it('ignores unicode composition and spacing', () => {
    expect(sameWording('más', 'más')).toBe(true)
    expect(sameWording('  el   pan ', 'el pan')).toBe(true)
  })

  it('still reports a genuinely different wording', () => {
    expect(sameWording("l'agnello", 'agnello')).toBe(false)
    expect(sameWording('el pan', 'la barra de pan')).toBe(false)
  })

  it('keeps capitalisation significant — it carries meaning in some languages', () => {
    expect(sameWording('hund', 'Hund')).toBe(false)
  })
})
