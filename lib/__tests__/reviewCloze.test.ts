import type { Card } from '@/domain'
import type { PreparedExercise } from '@/lib/practiceGenerate'
import { buildReviewCloze, clozeEligible, clozeStrictness, sameWordFamily, appendStoredCloze, storedToReviewCloze, MAX_STORED_CLOZES } from '@/lib/reviewCloze'

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

describe('sameWordFamily', () => {
  it('accepts inflections and rejects synonyms', () => {
    expect(sameWordFamily('chapotean', 'chapotear')).toBe(true)
    expect(sameWordFamily('perros', 'perro')).toBe(true)
    expect(sameWordFamily('corrió', 'correr')).toBe(true)
    expect(sameWordFamily('먹어요', '먹다')).toBe(true)          // short-stem agglutinative form
    expect(sameWordFamily('създавам', 'сътворявам')).toBe(false) // synonym, near-zero shared stem
    expect(sameWordFamily('comió', 'correr')).toBe(false)
    expect(sameWordFamily('fue', 'ser')).toBe(false)             // suppletive → safe fallback
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

  it('accepts a STEM-CHANGING inflection via the answer token annotation', () => {
    // "pienso"/"pensar" share almost no prefix — the stem check alone rejected every Spanish
    // stem-changer ("cards that used to work fine don't anymore"). The token annotation labels
    // what's actually in the sentence, and it says pienso IS pensar.
    const c = card({ front: 'pensar', lemma: 'pensar', pos: 'verb' })
    const ex = prepared('Pienso en ti todos los días.', 'Pienso')
    ex.exercise.targetLemma = 'pensar'
    ex.exercise.tokens = [{ text: 'Pienso', lemma: 'pensar', pos: 'verb', isFunctionWord: false, gloss: 'I think' }]
    const cz = buildReviewCloze(ex, c)
    expect(cz).not.toBeNull()
    expect(cz!.answer).toBe('Pienso')
  })

  it('REJECTS a SYNONYM even when the copied label lies — the token annotation tells the truth', () => {
    // The real failure: card "сътворявам", sentence used the synonym "създавам", and targetLemma
    // was dutifully copied from the request. The token annotation labels the sentence honestly
    // ("създавам"), which is not the card's word — and the stem fallback rejects it too.
    const c = card({ front: 'сътворявам', lemma: 'сътворявам', pos: 'verb', sourceLanguage: 'bg' })
    const swapped = prepared('Всеки ден създавам нови идеи за работата.', 'създавам')
    swapped.exercise.targetLemma = 'сътворявам'
    swapped.exercise.tokens = [{ text: 'създавам', lemma: 'създавам', pos: 'verb', isFunctionWord: false, gloss: 'I create' }]
    expect(buildReviewCloze(swapped, c)).toBeNull()
  })

  it('accepts a reflexive/multiword lemma reported as the bare verb', () => {
    // Card lemma "посвещавам се"; the model reports "посвещавам" — strict lemma equality rejected
    // EVERY sentence for reflexive cards, which read as "cloze never generates".
    const c = card({ front: 'посвещавам се', lemma: 'посвещавам се', pos: 'verb', sourceLanguage: 'bg' })
    const ex = prepared('Тя се посвещава на музиката.', 'посвещава')
    ex.exercise.targetLemma = 'посвещавам'
    const cz = buildReviewCloze(ex, c)
    expect(cz).not.toBeNull()
    expect(cz!.answer).toBe('посвещава')
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
    // Re-adding an existing sentence moves it to the front instead of duplicating.
    const again = appendStoredCloze(choices, stored('Dos perro.'))
    expect(again.clozeSentences!.map(s => s.sentence)).toEqual(['Dos perro.', 'Cuatro perro.', 'Tres perro.'])
  })

  it('a stored stem-changing sentence re-validates through its saved lemma', () => {
    const c = card({ front: 'pensar', lemma: 'pensar', pos: 'verb' })
    const cz = storedToReviewCloze(
      { sentence: 'Pienso en ti todos los días.', answer: 'Pienso', lemma: 'pensar', translation: 'I think of you every day.', gloss: 'I think' }, c)
    expect(cz).not.toBeNull()
    expect(cz!.answer).toBe('Pienso')
  })

  it('storedToReviewCloze re-validates against the card as it is NOW', () => {
    const ok = storedToReviewCloze(stored('Vi el perro ayer.'), card())
    expect(ok).not.toBeNull()
    expect(ok!.before).toBe('Vi ')
    expect(ok!.answer).toBe('el perro')
    // The card's front/lemma changed since the sentence was saved → the sentence must fall away.
    const edited = card({ front: 'el gato', lemma: 'gato' })
    expect(storedToReviewCloze(stored('Vi el perro ayer.'), edited)).toBeNull()
  })
})
