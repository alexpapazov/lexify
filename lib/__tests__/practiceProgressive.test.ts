import type { PracticeTarget } from '@/engine/practice'

import { preparePracticeSessionProgressive, preparePracticeSession } from '@/lib/practiceBank'

function target(front: string): PracticeTarget {
  return { cardId: `c-${front}`, front, back: 'gloss', lemma: front, pos: 'noun' }
}

function apiExercise(lemma: string, n = 0) {
  return {
    targetLemma: lemma,
    sentence: `Une phrase avec ${lemma} ${n}.`,
    answer: lemma,
    translation: 'A sentence.',
    tokens: [{ text: lemma, lemma, pos: 'noun', isFunctionWord: false, gloss: 'g' }],
  }
}

/** Queues responses; each `exercises` array answers one generate call, in call order. */
function mockGenerate(batches: Array<{ exercises?: unknown[]; ok?: boolean; reason?: string; delayMs?: number }>) {
  const bodies: Record<string, unknown>[] = []
  let i = 0
  global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? '{}'))
    const b = batches[Math.min(i++, batches.length - 1)]!
    if (b.delayMs) await new Promise(r => setTimeout(r, b.delayMs))
    return {
      ok: true,
      json: async () => (b.ok === false ? { ok: false, reason: b.reason ?? 'boom' } : { ok: true, exercises: b.exercises ?? [] }),
    } as unknown as Response
  }) as unknown as typeof fetch
  return bodies
}

const OPTS = {
  userId: 'u1', sourceLanguage: 'fr', targetLanguage: 'en',
  plan: { mode: 'perWord', perWord: 1 } as const,
}

afterEach(() => { jest.restoreAllMocks() })

describe('preparePracticeSessionProgressive', () => {
  it('with an empty bank, the learner waits for exactly ONE starter sentence', async () => {
    const bodies = mockGenerate([
      { exercises: [apiExercise('un')] },
      { exercises: [apiExercise('deux'), apiExercise('trois')] },
    ])
    const ready: number[] = []
    const appended: number[] = []
    const run = await preparePracticeSessionProgressive(
      { ...OPTS, targets: [target('un'), target('deux'), target('trois')] },
      { onReady: f => ready.push(f.length), onAppend: m => appended.push(m.length) },
    )
    // First call is the starter: one sentence, one word — that's the whole wait.
    expect(bodies[0]!.count).toBe(1)
    expect(ready).toEqual([1])
    expect(appended).toEqual([2])
    expect(run.missingCount).toBe(0)
  })

  it('a dead starter does not kill the session — the next batch opens it instead', async () => {
    mockGenerate([
      { ok: false, reason: 'api-error' },                       // starter dies
      { exercises: [apiExercise('deux'), apiExercise('trois')] }, // background batch opens the session
    ])
    const ready: number[] = []
    const appended: number[] = []
    const run = await preparePracticeSessionProgressive(
      { ...OPTS, targets: [target('un'), target('deux'), target('trois')] },
      { onReady: f => ready.push(f.length), onAppend: m => appended.push(m.length) },
    )
    expect(ready).toEqual([2])
    expect(appended).toEqual([])
    expect(run.missingCount).toBe(1)      // the starter's sentence never materialised
  })

  it('rejects only when nothing at all became playable', async () => {
    mockGenerate([{ ok: false, reason: 'no-api-key' }])
    await expect(preparePracticeSessionProgressive(
      { ...OPTS, targets: [target('un')] },
      { onReady: () => {}, onAppend: () => {} },
    )).rejects.toThrow('no-api-key')
  })

})

describe('preparePracticeSessionProgressive — onReady fires once', () => {
  it('is the starter batch and only the starter batch', async () => {
    mockGenerate([
      { exercises: [apiExercise('un')] },
      { exercises: [apiExercise('deux')] },
      { exercises: [apiExercise('trois')] },
    ])
    let readyCalls = 0
    await preparePracticeSessionProgressive(
      { ...OPTS, targets: [target('un'), target('deux'), target('trois')] },
      { onReady: () => { readyCalls++ }, onAppend: () => {} },
    )
    expect(readyCalls).toBe(1)
  })
})

describe('preparePracticeSession (all-at-once wrapper)', () => {
  it('collects the whole stream into one array', async () => {
    mockGenerate([
      { exercises: [apiExercise('un')] },
      { exercises: [apiExercise('deux'), apiExercise('trois')] },
    ])
    const run = await preparePracticeSession({ ...OPTS, targets: [target('un'), target('deux'), target('trois')] })
    expect(run.exercises).toHaveLength(3)
    expect(run.missingCount).toBe(0)
  })
})
