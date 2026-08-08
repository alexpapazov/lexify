import { generatePracticeExercises, toPracticeTargets } from '@/lib/practiceGenerate'
import { buildLibraryIndex } from '@/engine/practice'
import type { Card, CardState, PartOfSpeech } from '@/domain'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let nextId = 0
function card(front: string, pos: PartOfSpeech | null, lemma: string | null): Card {
  return {
    id: `card-${nextId++}`,
    ownerId: 'user-1',
    sourceLanguage: 'fr',
    targetLanguage: 'en',
    front, back: 'gloss', hints: [], choices: null, position: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null,
    pos, lemma,
  }
}

function graduatedState(cardId: string): CardState {
  return { cardId, graduated: true, reviewDirection: 'forward' } as unknown as CardState
}

/** A library with enough of every essential class that coverage reads 'ok'. */
function library(extra: [string, PartOfSpeech, string][] = []) {
  const entries: [string, PartOfSpeech, string][] = []
  for (let i = 0; i < 6; i++) {
    entries.push([`nom${i}`, 'noun', `nom${i}`])
    entries.push([`verbe${i}`, 'verb', `verbe${i}`])
    entries.push([`adj${i}`, 'adjective', `adj${i}`])
  }
  const cards = [...entries, ...extra].map(([f, p, l]) => card(f, p, l))
  return buildLibraryIndex(cards, cards.map(c => graduatedState(c.id)))
}

function tok(text: string, lemma: string, pos: PartOfSpeech, isFunctionWord = false, gloss = 'g') {
  return { text, lemma, pos, isFunctionWord, gloss }
}

const TARGETS = [{ cardId: 'c1', front: 'se précipiter', back: 'to rush', lemma: 'se précipiter', pos: 'verb' }]

const BASE_OPTS = {
  targets: TARGETS,
  sourceLanguage: 'fr',
  targetLanguage: 'en',
  count: 1,
  minGraduatedPct: 80,
}

/** Queues JSON responses for successive fetch calls, and records the request bodies. */
function mockFetchSequence(responses: unknown[]) {
  const bodies: Record<string, unknown>[] = []
  const urls: string[] = []
  let i = 0
  global.fetch = jest.fn(async (url: unknown, init?: { body?: string }) => {
    urls.push(String(url))
    bodies.push(JSON.parse(init?.body ?? '{}'))
    const body = responses[Math.min(i++, responses.length - 1)]
    return { ok: true, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  return { bodies, urls }
}

afterEach(() => { jest.restoreAllMocks() })

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('toPracticeTargets', () => {
  it('keeps labeled single-word cards and drops phrases and unlabeled cards', () => {
    const targets = toPracticeTargets([
      card('se précipiter', 'verb', 'se précipiter'),
      card('il pleut des cordes', 'phrase', null),
      card('le vent', null, null),
      card('  ', 'noun', '   '),
    ])
    expect(targets.map(t => t.lemma)).toEqual(['se précipiter'])
  })
})

describe('generatePracticeExercises', () => {
  it('returns a clean sentence unrepaired, with nothing flagged', async () => {
    mockFetchSequence([{
      ok: true,
      exercises: [{
        targetLemma: 'se précipiter',
        sentence: 'Il se précipite vers nom0.',
        answer: 'précipite',
        translation: 'He rushes toward nom0.',
        tokens: [
          tok('Il', 'il', 'pronoun', true),
          tok('précipite', 'se précipiter', 'verb'),
          tok('nom0', 'nom0', 'noun'),
        ],
      }],
    }])

    const run = await generatePracticeExercises({ ...BASE_OPTS, index: library() })
    expect(run.exercises).toHaveLength(1)
    expect(run.missingCount).toBe(0)
    const prepared = run.exercises[0]!
    expect(prepared.score.passes).toBe(true)
    expect(prepared.flagged).toEqual([])
    expect(prepared.repaired).toBe(false)
    // One call only: no repair was needed.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1)
  })

  it('repairs a sentence containing an unknown word', async () => {
    const { urls } = mockFetchSequence([
      {
        ok: true,
        exercises: [{
          targetLemma: 'se précipiter',
          sentence: 'Il se précipite vers le tonnerre.',
          answer: 'précipite',
          translation: 'He rushes toward the thunder.',
          tokens: [
            tok('précipite', 'se précipiter', 'verb'),
            tok('tonnerre', 'tonnerre', 'noun', false, 'thunder'),
          ],
        }],
      },
      {
        ok: true,
        exercise: {
          targetLemma: 'se précipiter',
          sentence: 'Il se précipite vers nom0.',
          answer: 'précipite',
          translation: 'He rushes toward nom0.',
          tokens: [
            tok('précipite', 'se précipiter', 'verb'),
            tok('nom0', 'nom0', 'noun'),
          ],
        },
      },
    ])

    const run = await generatePracticeExercises({ ...BASE_OPTS, index: library() })
    const prepared = run.exercises[0]!
    expect(prepared.repaired).toBe(true)
    expect(prepared.exercise.sentence).toBe('Il se précipite vers nom0.')
    expect(prepared.flagged).toEqual([])
    expect(urls[1]).toContain('/api/practice/repair')
  })

  it('keeps and flags a word the repair could not replace, with its gloss', async () => {
    mockFetchSequence([
      {
        ok: true,
        exercises: [{
          targetLemma: 'se précipiter',
          sentence: 'Il se précipite vers le tonnerre.',
          answer: 'précipite',
          translation: 'He rushes toward the thunder.',
          tokens: [
            tok('précipite', 'se précipiter', 'verb'),
            tok('tonnerre', 'tonnerre', 'noun', false, 'thunder'),
          ],
        }],
      },
      { ok: false, reason: 'api-error' },
    ])

    const prepared = (await generatePracticeExercises({ ...BASE_OPTS, index: library() })).exercises[0]!
    expect(prepared.repaired).toBe(false)
    expect(prepared.flagged).toEqual([{ text: 'tonnerre', gloss: 'thunder' }])
    // The exercise survives — a red word with a translation beats no sentence at all.
    expect(prepared.exercise.sentence).toContain('tonnerre')
  })

  it('rejects a repair that trades one unknown word for another', async () => {
    mockFetchSequence([
      {
        ok: true,
        exercises: [{
          targetLemma: 'se précipiter',
          sentence: 'Il se précipite vers le tonnerre.',
          answer: 'précipite',
          translation: '…',
          tokens: [tok('précipite', 'se précipiter', 'verb'), tok('tonnerre', 'tonnerre', 'noun', false, 'thunder')],
        }],
      },
      {
        ok: true,
        exercise: {
          targetLemma: 'se précipiter',
          sentence: 'Il se précipite vers la foudre.',
          answer: 'précipite',
          translation: '…',
          tokens: [tok('précipite', 'se précipiter', 'verb'), tok('foudre', 'foudre', 'noun', false, 'lightning')],
        },
      },
    ])

    const prepared = (await generatePracticeExercises({ ...BASE_OPTS, index: library() })).exercises[0]!
    expect(prepared.repaired).toBe(false)
    expect(prepared.exercise.sentence).toContain('tonnerre')   // the original is kept
  })

  it('sends a helper-word sample and the narrow-vocabulary flag off for a healthy library', async () => {
    const { bodies } = mockFetchSequence([{ ok: true, exercises: [{
      targetLemma: 'se précipiter', sentence: 'Il se précipite.', answer: 'précipite',
      translation: 'He rushes.', tokens: [tok('précipite', 'se précipiter', 'verb')],
    }] }])

    await generatePracticeExercises({ ...BASE_OPTS, index: library() })
    const body = bodies[0]!
    expect(body.narrowVocabulary).toBe(false)
    expect(Array.isArray(body.helperWords)).toBe(true)
    expect((body.helperWords as string[]).length).toBeGreaterThan(0)
  })

  it('relaxes the percentage bar when the library is too narrow to build from', async () => {
    // One noun only: coverage is 'narrow', so a low-scoring sentence must not be failed for it.
    const narrowIndex = (() => {
      const c = card('la pluie', 'noun', 'pluie')
      return buildLibraryIndex([c], [graduatedState(c.id)])
    })()
    const { bodies } = mockFetchSequence([{ ok: true, exercises: [{
      targetLemma: 'se précipiter',
      sentence: 'Il se précipite sous la pluie.',
      answer: 'précipite',
      translation: 'He rushes in the rain.',
      tokens: [tok('précipite', 'se précipiter', 'verb'), tok('pluie', 'pluie', 'noun')],
    }] }])

    const prepared = (await generatePracticeExercises({
      ...BASE_OPTS, index: narrowIndex, minGraduatedPct: 100,
    })).exercises[0]!
    expect(bodies[0]!.narrowVocabulary).toBe(true)
    expect(prepared.score.passes).toBe(true)
  })

  it('reports exercises the model failed to return', async () => {
    mockFetchSequence([{ ok: true, exercises: [{
      targetLemma: 'se précipiter', sentence: 'Il se précipite.', answer: 'précipite',
      translation: 'He rushes.', tokens: [tok('précipite', 'se précipiter', 'verb')],
    }] }])

    const run = await generatePracticeExercises({ ...BASE_OPTS, index: library(), count: 3 })
    expect(run.exercises).toHaveLength(1)
    expect(run.missingCount).toBe(2)
  })

  it('throws when generation itself fails', async () => {
    mockFetchSequence([{ ok: false, reason: 'no-api-key' }])
    await expect(generatePracticeExercises({ ...BASE_OPTS, index: library() }))
      .rejects.toThrow('no-api-key')
  })

  it('makes no request at all with no targets', async () => {
    mockFetchSequence([{ ok: true, exercises: [] }])
    const run = await generatePracticeExercises({ ...BASE_OPTS, index: library(), targets: [] })
    expect(run.exercises).toEqual([])
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(0)
  })

  it('does not exempt OTHER session targets appearing in a sentence', async () => {
    // Two words are being drilled this session. 'tonnerre' is a target of its own exercise, but in
    // THIS sentence it is ordinary vocabulary the learner doesn't know — so it must be flagged.
    mockFetchSequence([
      {
        ok: true,
        exercises: [{
          targetLemma: 'se précipiter',
          sentence: 'Il se précipite vers le tonnerre.',
          answer: 'précipite',
          translation: '…',
          tokens: [tok('précipite', 'se précipiter', 'verb'), tok('tonnerre', 'tonnerre', 'noun', false, 'thunder')],
        }],
      },
      { ok: false, reason: 'api-error' },
    ])

    const run = await generatePracticeExercises({
      ...BASE_OPTS,
      index: library(),
      targets: [
        ...TARGETS,
        { cardId: 'c2', front: 'le tonnerre', back: 'thunder', lemma: 'tonnerre', pos: 'noun' },
      ],
    })
    expect(run.exercises[0]!.flagged.map(f => f.text)).toEqual(['tonnerre'])
  })
})
