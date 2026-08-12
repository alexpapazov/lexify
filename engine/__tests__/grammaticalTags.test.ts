import { gradeTyping, stripGrammaticalTags } from '@/engine/grading'
import type { GradingSettings } from '@/domain'

const settings = (over: Partial<GradingSettings> = {}): GradingSettings => ({
  gradingMode: 'flexible', ignoreAccents: false, ignoreCapitalization: true, ignoreMinorTypos: false,
  ignoreDefiniteArticles: false, requireParentheticalContent: true,
  commaAlternativesMode: 'split_into_cards',
  autoPlayAudio: false, answerLanguage: 'bg', ...over,
})

describe('grammatical gender/number tags are not graded content', () => {
  it('accepts an answer that omits the "(f)" gender tag (required-parenthetical ON)', () => {
    expect(gradeTyping('особеност', 'особеност (f)', settings()).status).toBe('correct')
  })
  it('accepts it with required-parenthetical OFF too', () => {
    expect(gradeTyping('особеност', 'особеност (f)', settings({ requireParentheticalContent: false })).status).toBe('correct')
  })
  it('handles (m), (pl), (masc.) markers', () => {
    expect(gradeTyping('perro', 'perro (m)', settings()).status).toBe('correct')
    expect(gradeTyping('gatos', 'gatos (pl)', settings()).status).toBe('correct')
    expect(gradeTyping('niño', 'niño (masc.)', settings()).status).toBe('correct')
  })
  it('leaves a REQUIRED word parenthetical like "(el)" intact', () => {
    expect(stripGrammaticalTags('(el) camello')).toBe('(el) camello')
  })
})
