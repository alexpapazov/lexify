import type { Card } from '@/domain'
import type { PreparedExercise } from '@/lib/practiceGenerate'
import { buildReviewCloze, clozeEligible } from '@/lib/reviewCloze'

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

describe('buildReviewCloze', () => {
  it('splits the sentence around the exact stored form', () => {
    const cz = buildReviewCloze(prepared('El perro duerme en el jardín.', 'perro'), card())
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('El ')
    expect(cz!.after).toBe(' duerme en el jardín.')
    expect(cz!.answer).toBe('perro')
    expect(cz!.gloss).toBe('dog')
    expect(cz!.translation).toBe('The dog sleeps in the garden.')
  })

  it('accepts article and case differences between the surface form and the stored front', () => {
    // Front stores "el perro"; the sentence's bare, capitalized "Perro" is the same word
    // (normalizeFrontKey strips one leading article and case-folds).
    const cz = buildReviewCloze(prepared('Perro grande ladra fuerte.', 'Perro'), card())
    expect(cz).not.toBeNull()
  })

  it('REJECTS a sentence that inflected the word — grading would mislead', () => {
    // Card front "correr"; the model wrote "corrió" despite exactForm. gradeTyping compares against
    // the stored front, so showing this cloze would mark the sentence's own answer wrong.
    const c = card({ front: 'correr', lemma: 'correr', pos: 'verb' })
    expect(buildReviewCloze(prepared('Ayer corrió cinco kilómetros.', 'corrió'), c)).toBeNull()
  })

  it('rejects when the answer cannot be located in the sentence, or the translation is missing', () => {
    expect(buildReviewCloze(prepared('El gato duerme.', 'perro'), card())).toBeNull()
    const noTranslation = prepared('El perro duerme.', 'perro')
    noTranslation.exercise.translation = '  '
    expect(buildReviewCloze(noTranslation, card())).toBeNull()
  })
})
