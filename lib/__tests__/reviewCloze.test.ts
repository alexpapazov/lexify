import type { Card } from '@/domain'
import type { PreparedExercise } from '@/lib/practiceGenerate'
import { buildReviewCloze, clozeEligible, clozeStrictness, appendStoredCloze, chooseStoredCloze, storedToReviewCloze, MAX_STORED_CLOZES } from '@/lib/reviewCloze'

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
  it('blanks ONLY the word — the sentence keeps its own article visible', () => {
    // Card "el perro", sentence "El perro duerme…" → "El ___ duerme…", type just "perro".
    const cz = buildReviewCloze(prepared('El perro duerme en el jardín.', 'perro'), card())
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('El ')
    expect(cz!.after).toBe(' duerme en el jardín.')
    expect(cz!.answer).toBe('perro')
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

  it('grows the blank to the WHOLE inflected word when the front matches inside it', () => {
    // Bulgarian screenshot 2026-09-09: front "озаглавен" matched inside "озаглавена", leaving the
    // "-а" visible and grading against the stem. The blank must cover the entire word, and the
    // answer is the full inflected form the learner has to type.
    const c = card({ front: 'озаглавен', lemma: 'озаглавен', pos: 'adjective', sourceLanguage: 'bg' })
    const cz = buildReviewCloze(prepared('Статията е озаглавена „Промени“.', 'озаглавена'), c)
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('Статията е ')
    expect(cz!.answer).toBe('озаглавена')
    expect(cz!.after).toBe(' „Промени“.')
  })

  it('keeps an elided article visible too', () => {
    const c = card({ front: "l'attrezzo", lemma: 'attrezzo', sourceLanguage: 'it' })
    const cz = buildReviewCloze(prepared('Ho comprato l’attrezzo nuovo.', 'attrezzo'), c)
    expect(cz).not.toBeNull()
    expect(cz!.before).toBe('Ho comprato l’')
    expect(cz!.answer).toBe('attrezzo')
  })

  it('carries the per-word token glosses through for the tap-a-word panel', () => {
    const ex = prepared('El perro duerme.', 'perro')
    ex.exercise.tokens = [
      { text: 'El', lemma: 'el', pos: 'determiner', isFunctionWord: true, gloss: 'the' },
      { text: 'perro', lemma: 'perro', pos: 'noun', isFunctionWord: false, gloss: 'dog' },
      { text: 'duerme', lemma: 'dormir', pos: 'verb', isFunctionWord: false, gloss: 'sleeps' },
    ]
    const cz = buildReviewCloze(ex, card())
    expect(cz!.tokens).toEqual([
      { text: 'El', gloss: 'the' }, { text: 'perro', gloss: 'dog' }, { text: 'duerme', gloss: 'sleeps' },
    ])
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

  it('chooseStoredCloze moves the picked sentence to the front — the ACTIVE slot reviews use', () => {
    let choices = appendStoredCloze(null, stored('Uno perro.'))
    choices = appendStoredCloze(choices, stored('Dos perro.'))
    choices = appendStoredCloze(choices, stored('Tres perro.'))   // list: Tres, Dos, Uno
    const picked = chooseStoredCloze(choices, 2)
    expect(picked.clozeSentences!.map(s => s.sentence)).toEqual(['Uno perro.', 'Tres perro.', 'Dos perro.'])
    // Already-active and out-of-range picks are no-ops (same object back).
    expect(chooseStoredCloze(picked, 0)).toBe(picked)
    expect(chooseStoredCloze(picked, 9)).toBe(picked)
  })

  it('storedToReviewCloze anchors a stored sentence, and drops one whose word is gone', () => {
    const ok = storedToReviewCloze(stored('Vi el perro ayer.'), card())
    expect(ok).not.toBeNull()
    expect(ok!.before).toBe('Vi el ')
    expect(ok!.answer).toBe('perro')
    // Stored token glosses round-trip into the rebuilt cloze.
    const withTokens = storedToReviewCloze(
      { sentence: 'Vi el perro ayer.', answer: 'perro', translation: 'x', gloss: 'dog',
        tokens: [{ text: 'ayer', gloss: 'yesterday' }] }, card())
    expect(withTokens!.tokens).toEqual([{ text: 'ayer', gloss: 'yesterday' }])
    // Stored inflected form still anchors (bare-bones: locating the answer is all it takes).
    const inflected = storedToReviewCloze(
      { sentence: 'Pienso en ti.', answer: 'Pienso', translation: 'I think of you.', gloss: 'I think' },
      card({ front: 'pensar', lemma: 'pensar', pos: 'verb' }))
    expect(inflected).not.toBeNull()
    // A sentence that no longer contains its own answer text has nothing to blank.
    expect(storedToReviewCloze({ sentence: 'El gato duerme.', answer: 'perro', translation: 'x', gloss: 'dog' }, card())).toBeNull()
  })
})
