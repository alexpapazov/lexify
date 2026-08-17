import { generatePracticeExercises } from '@/lib/practiceGenerate'
import type { PracticeTarget } from '@/engine/practice'
import type { PartOfSpeech } from '@/domain'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function tok(text: string, lemma: string, pos: PartOfSpeech, isFunctionWord = false, gloss = 'g') {
  return { text, lemma, pos, isFunctionWord, gloss }
}

const TARGETS: PracticeTarget[] = [
  { cardId: 'c1', front: 'se précipiter', back: 'to rush', lemma: 'se précipiter', pos: 'verb' },
]

const BASE_OPTS = {
  targets: TARGETS,
  sourceLanguage: 'fr',
  targetLanguage: 'en',
  count: 1,
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

const EXERCISE = {
  targetLemma: 'se précipiter',
  sentence: 'Il se précipite vers la porte.',
  answer: 'précipite',
  translation: 'He rushes toward the door.',
  tokens: [
    tok('Il', 'il', 'pronoun', true, 'he'),
    tok('précipite', 'se précipiter', 'verb', false, 'rushes'),
    tok('porte', 'porte', 'noun', false, 'door'),
  ],
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generatePracticeExercises', () => {
  it('is ONE generation call — no repair, no verify, no helper words in the request', async () => {
    const { bodies, urls } = mockFetchSequence([{ ok: true, exercises: [EXERCISE] }])

    const run = await generatePracticeExercises(BASE_OPTS)
    expect(run.exercises).toHaveLength(1)
    expect(run.missingCount).toBe(0)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/api/practice/generate')
    // The known-words steering is gone: nothing about the library travels with the request.
    expect(bodies[0]).not.toHaveProperty('helperWords')
    expect(bodies[0]).not.toHaveProperty('restrictVocabulary')
    expect(bodies[0]).not.toHaveProperty('minGraduatedPct')
  })

  it('prefers the in-context gloss of the answer for the blank prompt', async () => {
    mockFetchSequence([{ ok: true, exercises: [EXERCISE] }])
    const run = await generatePracticeExercises(BASE_OPTS)
    expect(run.exercises[0]!.targetGloss).toBe('rushes')
  })

  it('falls back to the card gloss when the answer has no token', async () => {
    mockFetchSequence([{
      ok: true,
      exercises: [{ ...EXERCISE, tokens: [tok('porte', 'porte', 'noun', false, 'door')] }],
    }])
    const run = await generatePracticeExercises(BASE_OPTS)
    expect(run.exercises[0]!.targetGloss).toBe('to rush')
  })

  it('reports exercises the model failed to return', async () => {
    mockFetchSequence([{ ok: true, exercises: [EXERCISE] }])
    const run = await generatePracticeExercises({ ...BASE_OPTS, count: 3 })
    expect(run.exercises).toHaveLength(1)
    expect(run.missingCount).toBe(2)
  })

  it('throws the underlying reason when nothing comes back at all', async () => {
    mockFetchSequence([{ ok: false, reason: 'no-api-key' }])
    await expect(generatePracticeExercises(BASE_OPTS)).rejects.toThrow('no-api-key')
  })

  it('passes the cloze mode through', async () => {
    const { bodies } = mockFetchSequence([{ ok: true, exercises: [EXERCISE] }])
    await generatePracticeExercises({ ...BASE_OPTS, mode: 'native' })
    expect(bodies[0]!.mode).toBe('native')
  })

  it('returns empty for no targets without calling anything', async () => {
    const { urls } = mockFetchSequence([])
    const run = await generatePracticeExercises({ ...BASE_OPTS, targets: [] })
    expect(run).toEqual({ exercises: [], missingCount: 0 })
    expect(urls).toHaveLength(0)
  })
})
