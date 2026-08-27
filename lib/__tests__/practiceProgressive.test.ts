import type { PracticeTarget } from '@/engine/practice'

import { preparePracticeSessionProgressive, preparePracticeSession, buildSlotOrder, buildSlotJobs } from '@/lib/practiceBank'

function target(front: string): PracticeTarget {
  return { cardId: `c-${front}`, front, back: 'gloss', lemma: front, pos: 'noun' }
}

/**
 * Answers each generate call from its request body: `count` exercises for the (single) requested
 * word, every sentence unique via a running counter — the shape the per-word generator produces.
 * `override` can replace the response for specific calls (keyed by call index).
 */
function mockGenerateDynamic(override: Record<number, { ok?: boolean; reason?: string; sentence?: string }> = {}) {
  const bodies: Array<{ targets: Array<{ lemma: string }>; count: number }> = []
  let call = 0
  let serial = 0
  global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { targets: Array<{ lemma: string }>; count: number }
    bodies.push(body)
    const o = override[call++]
    if (o?.ok === false) {
      return { ok: true, json: async () => ({ ok: false, reason: o.reason ?? 'boom' }) } as unknown as Response
    }
    const lemma = body.targets[0]!.lemma
    const exercises = Array.from({ length: body.count }, () => ({
      targetLemma: lemma,
      sentence: o?.sentence ?? `Une phrase avec ${lemma} ${serial++}.`,
      answer: lemma,
      translation: 'A sentence.',
      tokens: [{ text: lemma, lemma, pos: 'noun', isFunctionWord: false, gloss: 'g' }],
    }))
    return { ok: true, json: async () => ({ ok: true, exercises }) } as unknown as Response
  }) as unknown as typeof fetch
  return bodies
}

const OPTS = {
  userId: 'u1', sourceLanguage: 'fr', targetLanguage: 'en',
  plan: { mode: 'perWord', perWord: 1 } as const,
}

afterEach(() => { jest.restoreAllMocks() })

describe('buildSlotOrder', () => {
  it('per-word: lays down full rounds — every word once before any word twice', () => {
    const words = [target('un'), target('deux'), target('trois')]
    for (let trial = 0; trial < 20; trial++) {
      const slots = buildSlotOrder(words, { mode: 'perWord', perWord: 2 })
      expect(slots).toHaveLength(6)
      expect(new Set(slots.slice(0, 3).map(t => t.cardId)).size).toBe(3)
      expect(new Set(slots.slice(3, 6).map(t => t.cardId)).size).toBe(3)
    }
  })

  it('never places the same word on both sides of a round boundary (when avoidable)', () => {
    const words = [target('un'), target('deux'), target('trois')]
    for (let trial = 0; trial < 50; trial++) {
      const slots = buildSlotOrder(words, { mode: 'perWord', perWord: 3 })
      for (let i = 1; i < slots.length; i++) expect(slots[i]!.cardId).not.toBe(slots[i - 1]!.cardId)
    }
  })

  it('total mode cycles rounds: 4 sentences over 2 words is 2 each, alternating', () => {
    const words = [target('un'), target('deux')]
    for (let trial = 0; trial < 20; trial++) {
      const slots = buildSlotOrder(words, { mode: 'total', count: 4 })
      expect(slots).toHaveLength(4)
      expect(slots.filter(t => t.cardId === 'c-un')).toHaveLength(2)
      for (let i = 1; i < slots.length; i++) expect(slots[i]!.cardId).not.toBe(slots[i - 1]!.cardId)
    }
  })

  it('total mode below the word count drills a random subset, one sentence each', () => {
    const words = [target('un'), target('deux'), target('trois'), target('quatre')]
    const slots = buildSlotOrder(words, { mode: 'total', count: 3 })
    expect(slots).toHaveLength(3)
    expect(new Set(slots.map(t => t.cardId)).size).toBe(3)
  })
})

describe('buildSlotJobs', () => {
  it('carves a single-sentence starter and keeps jobs in first-slot order', () => {
    const [a, b] = [target('un'), target('deux')]
    // Slot order a b a b — the starter is a's first slot alone; a's remainder sorts by its next slot.
    const jobs = buildSlotJobs([a, b, a, b])
    expect(jobs.map(j => j.slotIdxs)).toEqual([[0], [1, 3], [2]])
    expect(jobs[0]!.target).toBe(a)
    expect(jobs[2]!.target).toBe(a)
  })
})

describe('preparePracticeSessionProgressive', () => {
  it('the learner waits for exactly ONE starter sentence, then the rest stream in slot order', async () => {
    const bodies = mockGenerateDynamic()
    const ready: number[] = []
    let appendedCount = 0
    const run = await preparePracticeSessionProgressive(
      { ...OPTS, targets: [target('un'), target('deux'), target('trois')] },
      { onReady: f => ready.push(f.length), onAppend: m => { appendedCount += m.length } },
    )
    // First call is the starter: one sentence, one word — that's the whole wait.
    expect(bodies[0]!.count).toBe(1)
    expect(bodies[0]!.targets).toHaveLength(1)
    expect(ready).toEqual([1])
    expect(appendedCount).toBe(2)
    expect(run.missingCount).toBe(0)
  })

  it('interleaves multi-sentence plans: no word repeats within a round, one call per word', async () => {
    const bodies = mockGenerateDynamic()
    const words = [target('un'), target('deux'), target('trois')]
    const run = await preparePracticeSession({ ...OPTS, plan: { mode: 'perWord', perWord: 2 }, targets: words })
    expect(run.exercises).toHaveLength(6)
    const order = run.exercises.map(e => e.targetCardId)
    // Round structure survives generation: first three all distinct, last three all distinct.
    expect(new Set(order.slice(0, 3)).size).toBe(3)
    expect(new Set(order.slice(3, 6)).size).toBe(3)
    // 4 calls: the starter, the starter word's remainder, and one per other word.
    expect(bodies).toHaveLength(4)
    expect(run.missingCount).toBe(0)
  })

  it('a dead starter does not kill the session — the next slot opens it instead', async () => {
    mockGenerateDynamic({ 0: { ok: false, reason: 'api-error' } })
    const ready: number[] = []
    let appendedCount = 0
    const run = await preparePracticeSessionProgressive(
      { ...OPTS, targets: [target('un'), target('deux'), target('trois')] },
      { onReady: f => ready.push(f.length), onAppend: m => { appendedCount += m.length } },
    )
    expect(ready).toHaveLength(1)
    expect(ready[0]! + appendedCount).toBe(2)
    expect(run.missingCount).toBe(1)      // the starter's sentence never materialised
  })

  it('a repeated sentence for the same word is dropped, not shown twice', async () => {
    // Both of the starter word's calls (starter + remainder) return the identical sentence.
    mockGenerateDynamic({ 0: { sentence: 'La même phrase.' }, 1: { sentence: 'La même phrase.' } })
    const run = await preparePracticeSession({ ...OPTS, plan: { mode: 'perWord', perWord: 2 }, targets: [target('un')] })
    expect(run.exercises).toHaveLength(1)
    expect(run.missingCount).toBe(1)
  })

  it('rejects only when nothing at all became playable', async () => {
    mockGenerateDynamic({ 0: { ok: false, reason: 'no-api-key' } })
    await expect(preparePracticeSessionProgressive(
      { ...OPTS, targets: [target('un')] },
      { onReady: () => {}, onAppend: () => {} },
    )).rejects.toThrow('no-api-key')
  })
})

describe('preparePracticeSessionProgressive — onReady fires once', () => {
  it('and only once, however the batches land', async () => {
    mockGenerateDynamic()
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
    mockGenerateDynamic()
    const run = await preparePracticeSession({ ...OPTS, targets: [target('un'), target('deux'), target('trois')] })
    expect(run.exercises).toHaveLength(3)
    expect(run.missingCount).toBe(0)
  })
})
