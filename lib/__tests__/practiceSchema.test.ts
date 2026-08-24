import { parseExercise, parseExercises, leaksTargetScript } from '@/lib/practiceSchema'

const goodToken = { text: 'pluie', lemma: 'pluie', pos: 'noun', isFunctionWord: false, gloss: 'rain' }

const goodExercise = {
  targetLemma: 'pluie',
  sentence: 'La pluie tombe fort.',
  answer: 'pluie',
  translation: 'The rain is falling hard.',
  tokens: [goodToken],
}

describe('parseExercise', () => {
  it('parses a well-formed exercise', () => {
    const parsed = parseExercise(goodExercise)!
    expect(parsed.sentence).toBe('La pluie tombe fort.')
    expect(parsed.answer).toBe('pluie')
    expect(parsed.tokens).toHaveLength(1)
    expect(parsed.tokens[0]!.gloss).toBe('rain')
  })

  it('lowercases the target lemma so scoring can match it', () => {
    expect(parseExercise({ ...goodExercise, targetLemma: 'Pluie' })!.targetLemma).toBe('pluie')
  })

  it('rejects an answer that does not occur in the sentence (the blank would be unrenderable)', () => {
    expect(parseExercise({ ...goodExercise, answer: 'neige' })).toBeNull()
  })

  it('rejects an exercise with no sentence, no answer, or no usable tokens', () => {
    expect(parseExercise({ ...goodExercise, sentence: '' })).toBeNull()
    expect(parseExercise({ ...goodExercise, answer: '' })).toBeNull()
    expect(parseExercise({ ...goodExercise, tokens: [] })).toBeNull()
    expect(parseExercise({ ...goodExercise, tokens: 'nope' })).toBeNull()
  })

  it('rejects non-objects', () => {
    expect(parseExercise(null)).toBeNull()
    expect(parseExercise('a sentence')).toBeNull()
  })

  it('drops malformed tokens but keeps the exercise', () => {
    const parsed = parseExercise({
      ...goodExercise,
      tokens: [goodToken, { lemma: 'x', pos: 'noun' }, null, 'nope'],
    })!
    expect(parsed.tokens).toHaveLength(1)
  })

  it('falls back to the surface form when a lemma is missing', () => {
    const parsed = parseExercise({
      ...goodExercise,
      tokens: [{ text: 'tombe', pos: 'verb', isFunctionWord: false, gloss: 'falls' }],
    })!
    expect(parsed.tokens[0]!.lemma).toBe('tombe')
  })

  it('coerces an unknown part of speech to "other" rather than dropping the word', () => {
    const parsed = parseExercise({
      ...goodExercise,
      tokens: [{ ...goodToken, pos: 'substantive' }],
    })!
    // 'other' is a content class, so the word can still be flagged — never silently exempt.
    expect(parsed.tokens[0]!.pos).toBe('other')
  })

  it('treats isFunctionWord as false unless it is exactly true', () => {
    const parsed = parseExercise({
      ...goodExercise,
      tokens: [{ ...goodToken, isFunctionWord: 'yes' }],
    })!
    expect(parsed.tokens[0]!.isFunctionWord).toBe(false)
  })

  it('trims whitespace around strings', () => {
    const parsed = parseExercise({ ...goodExercise, answer: '  pluie  ' })!
    expect(parsed.answer).toBe('pluie')
  })
})

describe('parseExercises', () => {
  it('keeps the well-formed entries and drops the rest', () => {
    const parsed = parseExercises({
      exercises: [goodExercise, { ...goodExercise, answer: 'absent' }, null],
    })
    expect(parsed).toHaveLength(1)
  })

  it('returns an empty list for a missing or malformed payload', () => {
    expect(parseExercises(null)).toEqual([])
    expect(parseExercises({})).toEqual([])
    expect(parseExercises({ exercises: 'nope' })).toEqual([])
  })
})

describe('leaksTargetScript — native-mode single-word guarantee', () => {
  it('flags the reported failure: Greek grammar words dragged along with the answer', () => {
    expect(leaksTargetScript('It ενδέχεται να βρέξει αύριο, so bring an umbrella.', 'ενδέχεται')).toBe(true)
  })

  it('passes a clean native sentence with exactly one Greek word', () => {
    expect(leaksTargetScript('Strange things συμβαίνουν in this house at night.', 'συμβαίνουν')).toBe(false)
  })

  it('works for Cyrillic and Hangul answers too', () => {
    expect(leaksTargetScript('The крепост was built on a hill.', 'крепост')).toBe(false)
    expect(leaksTargetScript('Той built the крепост on a hill.', 'крепост')).toBe(true)
    expect(leaksTargetScript('I ate 김치 with dinner yesterday.', '김치')).toBe(false)
  })

  it('handles a multi-word answer as one unit', () => {
    expect(leaksTargetScript('He tried to се приближи quietly.', 'се приближи')).toBe(false)
  })

  it('is inert for same-script pairs — a Latin check would need a dictionary, not a regex', () => {
    expect(leaksTargetScript('The cremallera se desprendió while running.', 'cremallera')).toBe(false)
  })
})
