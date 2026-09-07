import type { Card } from '@/domain'
import type { PreparedExercise } from '@/lib/practiceGenerate'
import { buildReviewCloze, clozeEligible, clozeStrictness } from '@/lib/reviewCloze'

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

describe('buildReviewCloze', () => {
  it('blanks the FULL stored front, leading article included', () => {
    // Front "el perro"; the sentence's own capitalized "El perro" is the span the blank must
    // swallow — leaving "El" outside made typing the article double and omitting it an
    // article error ("El [el proceso]" in the field).
    const cz = buildReviewCloze(prepared('El perro duerme en el jardín.', 'perro'), card())
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('')
    expect(cz!.after).toBe(' duerme en el jardín.')
    expect(cz!.answer).toBe('El perro')          // the sentence's own casing, for the filled reveal
    expect(cz!.gloss).toBe('dog')
    expect(cz!.translation).toBe('The dog sleeps in the garden.')
  })

  it('finds the front mid-sentence, case-insensitively', () => {
    const cz = buildReviewCloze(prepared('Vi el perro ayer.', 'perro'), card())
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('Vi ')
    expect(cz!.after).toBe(' ayer.')
    expect(cz!.answer).toBe('el perro')
  })

  it('works for article-less fronts at a capitalized sentence start', () => {
    const cz = buildReviewCloze(prepared('Perro grande ladra fuerte.', 'Perro'), card({ front: 'perro' }))
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('')
    expect(cz!.answer).toBe('Perro')
  })

  it('matches an elided article across apostrophe styles', () => {
    const c = card({ front: "l'attrezzo", lemma: 'attrezzo', sourceLanguage: 'it' })
    const cz = buildReviewCloze(prepared('Ho comprato l’attrezzo nuovo.', 'attrezzo'), c)
    expect(cz).not.toBeNull()
    expect(cz!.answer).toBe('l’attrezzo')
  })

  it('falls back to the surface form when the sentence carries a different article', () => {
    // Front "el perro", sentence "un perro": the full front isn't there, but the bare surface form
    // is a lemma-verified form of the word — blank it, leaving the sentence's own article visible.
    const cz = buildReviewCloze(prepared('Vi un perro ayer.', 'perro'), card())
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('Vi un ')
    expect(cz!.answer).toBe('perro')
  })

  it('accepts an INFLECTED surface form when the reported lemma is this word', () => {
    // "chapotear" card, sentence uses "chapotean" — natural sentences inflect; the blank covers the
    // sentence's form and typed grading accepts both (viaClozeForm in TypingMode).
    const c = card({ front: 'chapotear', lemma: 'chapotear', pos: 'verb' })
    const ok = prepared('Los niños chapotean en la piscina.', 'chapotean')
    ok.exercise.targetLemma = 'chapotear'
    const cz = buildReviewCloze(ok, c)
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('Los niños ')
    expect(cz!.after).toBe(' en la piscina.')
    expect(cz!.answer).toBe('chapotean')
  })

  it('REJECTS a surface form whose reported lemma is a DIFFERENT word', () => {
    // Guard against the model writing about another word entirely: without the lemma check, any
    // reported answer found in the sentence would be blanked and mis-graded.
    const c = card({ front: 'correr', lemma: 'correr', pos: 'verb' })
    const other = prepared('Ayer comió cinco tapas.', 'comió')
    other.exercise.targetLemma = 'comer'
    expect(buildReviewCloze(other, c)).toBeNull()
  })

  it('rejects when the word is absent or the translation is missing', () => {
    expect(buildReviewCloze(prepared('El gato duerme.', 'perro'), card())).toBeNull()
    const noTranslation = prepared('El perro duerme.', 'perro')
    noTranslation.exercise.translation = '  '
    expect(buildReviewCloze(noTranslation, card())).toBeNull()
  })
})
