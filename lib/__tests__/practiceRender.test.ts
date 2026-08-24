import { splitForBlank, segmentWords, gradeClozeInput } from '@/lib/practiceRender'
import { DEFAULT_GRADING_SETTINGS } from '@/domain'

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

describe('segmentWords', () => {
  it('marks word runs and passes punctuation through', () => {
    const runs = segmentWords('Vers le tonnerre, oui.')
    expect(runs.filter(r => r.isWord).map(r => r.text)).toEqual(['Vers', 'le', 'tonnerre', 'oui'])
  })

  it('preserves every character when rejoined', () => {
    const text = 'Vers le tonnerre, oui.'
    expect(segmentWords(text).map(r => r.text).join('')).toBe(text)
  })

  it('keeps accented, apostrophised and hyphenated words whole', () => {
    const runs = segmentWords("L'extase était porte-clés.")
    expect(runs.filter(r => r.isWord).map(r => r.text)).toEqual(["L'extase", 'était', 'porte-clés'])
  })

  it('handles non-Latin scripts', () => {
    const runs = segmentWords('το σημείο είναι εδώ.')
    expect(runs.filter(r => r.isWord).map(r => r.text)).toEqual(['το', 'σημείο', 'είναι', 'εδώ'])
  })

  it('returns nothing for empty text', () => {
    expect(segmentWords('')).toEqual([])
  })
})

describe('gradeClozeInput — every grammatical form of the word is accepted', () => {
  const settings = {
    ...DEFAULT_GRADING_SETTINGS,
    gradingMode: 'flexible' as const,
    ignoreCapitalization: true,
    answerLanguage: 'el',
  }
  const grade = (input: string) => gradeClozeInput(input, 'συμβαίνουν', 'συμβαίνω', settings)

  it('accepts the sentence\'s inflected form as plain correct', () => {
    expect(grade('συμβαίνουν')).toBe('correct')
  })

  it('accepts the citation form as "form" — right word, wrong grammar', () => {
    expect(grade('συμβαίνω')).toBe('form')
  })

  it('extends the same typo tolerance to the citation form', () => {
    // The reported case verbatim: "σημβαίνω" is a one-letter slip on the lemma, not a different word.
    expect(grade('σημβαίνω')).toBe('form')
  })

  it('still rejects a different word outright', () => {
    expect(grade('πηγαίνουν')).toBe('wrong')
  })

  it('never reports "form" when answer and lemma coincide', () => {
    expect(gradeClozeInput('σπίτι', 'σπίτι', 'σπίτι', settings)).toBe('correct')
  })

  it('survives a blank lemma (phrase cards carry none)', () => {
    expect(gradeClozeInput('συμβαίνω', 'συμβαίνουν', '', settings)).toBe('wrong')
  })
})
