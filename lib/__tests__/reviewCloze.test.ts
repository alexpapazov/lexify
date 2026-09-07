import type { Card } from '@/domain'
import type { PreparedExercise } from '@/lib/practiceGenerate'
import { buildReviewCloze, clozeEligible, clozeStrictness, appendStoredCloze, storedToReviewCloze, MAX_STORED_CLOZES } from '@/lib/reviewCloze'

function card(over: Partial<Card> = {}): Card {
  return {
    id: 'c1', ownerId: 'u1', sourceLanguage: 'es', targetLanguage: 'en',
    front: 'el perro', back: 'dog', hints: [], choices: null, position: 0,
    createdAt: '', updatedAt: '', deletedAt: null,
    pos: 'noun', lemma: 'perro',
    ...over,
  }
}

function prepared(sentence: string, answer: string, over: Partial<PreparedExercise> = {}): PreparedExercise {
  return {
    exercise: {
      sentence, answer, targetLemma: 'perro', translation: 'The dog sleeps in the garden.',
      tokens: [],
    },
    targetCardId: 'c1',
    targetGloss: 'dog',
    ...over,
  } as PreparedExercise
}

describe('clozeEligible', () => {
  it('requires labels and excludes phrases', () => {
    expect(clozeEligible(card())).toBe(true)
    expect(clozeEligible(card({ pos: null, lemma: null }))).toBe(false)
    expect(clozeEligible(card({ lemma: null }))).toBe(false)
    expect(clozeEligible(card({ pos: 'phrase' }))).toBe(false)
  })
})

describe('clozeStrictness', () => {
  it('auto-accepts articles and keeps the other categories as configured', () => {
    expect(clozeStrictness({ spelling: 'penalize', accents: 'retype', articles: 'penalize' }))
      .toEqual({ spelling: 'penalize', accents: 'retype', articles: 'accept' })
  })
})

describe('buildReviewCloze — bare bones: the only rejection is "nothing to blank"', () => {
  it('blanks the FULL stored front, leading article included, when the sentence carries it', () => {
    const cz = buildReviewCloze(prepared('El perro duerme en el jardín.', 'perro'), card())
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('')
    expect(cz!.after).toBe(' duerme en el jardín.')
    expect(cz!.answer).toBe('El perro')          // the sentence's own casing, for the filled reveal
    expect(cz!.gloss).toBe('dog')
  })

  it('otherwise blanks the reported answer — inflections, other articles, whatever the sentence used', () => {
    const c = card({ front: 'chapotear', lemma: 'chapotear', pos: 'verb' })
    const cz = buildReviewCloze(prepared('Los niños chapotean en la piscina.', 'chapotean'), c)
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('Los niños ')
    expect(cz!.answer).toBe('chapotean')

    const stem = buildReviewCloze(prepared('Pienso en ti todos los días.', 'Pienso'), card({ front: 'pensar', lemma: 'pensar', pos: 'verb' }))
    expect(stem).not.toBeNull()
    expect(stem!.answer).toBe('Pienso')
  })

  it('matches an elided article across apostrophe styles', () => {
    const c = card({ front: "l'attrezzo", lemma: 'attrezzo', sourceLanguage: 'it' })
    const cz = buildReviewCloze(prepared('Ho comprato l’attrezzo nuovo.', 'attrezzo'), c)
    expect(cz).not.toBeNull()
    expect(cz!.answer).toBe('l’attrezzo')
  })

  it('a missing translation does NOT reject — the sentence renders without the line', () => {
    const noTranslation = prepared('El perro duerme.', 'perro')
    noTranslation.exercise.translation = '  '
    expect(buildReviewCloze(noTranslation, card())).not.toBeNull()
  })

  it('rejects only when neither the front nor the answer can be located', () => {
    expect(buildReviewCloze(prepared('El gato duerme.', 'perro'), card())).toBeNull()
    expect(buildReviewCloze(prepared('El gato duerme.', ''), card())).toBeNull()
  })
})

describe('stored cloze sentences', () => {
  const stored = (sentence: string, answer = 'perro') =>
    ({ sentence, answer, translation: 'A translation.', gloss: 'dog' })

  it('appendStoredCloze keeps newest first, dedupes by sentence, caps the set', () => {
    let choices = appendStoredCloze(null, stored('Uno perro.'))
    choices = appendStoredCloze(choices, stored('Dos perro.'))
    choices = appendStoredCloze(choices, stored('Tres perro.'))
    choices = appendStoredCloze(choices, stored('Cuatro perro.'))
    expect(choices.clozeSentences!.map(s => s.sentence)).toEqual(['Cuatro perro.', 'Tres perro.', 'Dos perro.'])
    expect(choices.clozeSentences!.length).toBe(MAX_STORED_CLOZES)
    const again = appendStoredCloze(choices, stored('Dos perro.'))
    expect(again.clozeSentences!.map(s => s.sentence)).toEqual(['Dos perro.', 'Cuatro perro.', 'Tres perro.'])
  })

  it('storedToReviewCloze anchors a stored sentence, and drops one whose word is gone', () => {
    const ok = storedToReviewCloze(stored('Vi el perro ayer.'), card())
    expect(ok).not.toBeNull()
    expect(ok!.before).toBe('Vi ')
    expect(ok!.answer).toBe('el perro')
    // Stored inflected form still anchors (bare-bones: locating the answer is all it takes).
    const inflected = storedToReviewCloze(
      { sentence: 'Pienso en ti.', answer: 'Pienso', translation: 'I think of you.', gloss: 'I think' },
      card({ front: 'pensar', lemma: 'pensar', pos: 'verb' }))
    expect(inflected).not.toBeNull()
    // A sentence that no longer contains its own answer text has nothing to blank.
    expect(storedToReviewCloze({ sentence: 'El gato duerme.', answer: 'perro', translation: 'x', gloss: 'dog' }, card())).toBeNull()
  })
})
