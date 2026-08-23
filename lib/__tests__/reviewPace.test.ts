import {
  buildPaceSamples, pace, weightedMedian, recencyWeight,
  DEFAULT_DUE_MS, HALF_LIFE_DAYS, type PaceRow,
} from '@/lib/reviewPace'

const NOW = Date.parse('2026-08-22T12:00:00.000Z')
const DAY = 86_400_000

function row(ms: number, ageDays: number, over: Partial<PaceRow> = {}): PaceRow {
  return {
    response_ms: ms,
    reviewed_at: new Date(NOW - ageDays * DAY).toISOString(),
    source_language: 'bg', target_language: 'en',
    review_direction: 'forward', was_typed: true,
    ...over,
  }
}

describe('recencyWeight', () => {
  it('halves over one half-life', () => {
    expect(recencyWeight(0)).toBe(1)
    expect(recencyWeight(HALF_LIFE_DAYS)).toBeCloseTo(0.5, 10)
    expect(recencyWeight(HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 10)
  })
})

describe('weightedMedian', () => {
  it('resists a single wild outlier the way a mean would not', () => {
    const xs = [{ v: 5000, w: 1 }, { v: 5200, w: 1 }, { v: 5100, w: 1 }, { v: 900_000, w: 1 }]
    expect(weightedMedian(xs)!).toBeLessThan(6000)
  })

  it('lets recent samples dominate', () => {
    const xs = [{ v: 20_000, w: 0.01 }, { v: 20_000, w: 0.01 }, { v: 4_000, w: 1 }]
    expect(weightedMedian(xs)).toBe(4_000)
  })

  it('is null with nothing to measure', () => {
    expect(weightedMedian([])).toBeNull()
  })
})

describe('pace', () => {
  it('uses the exact bucket when it has enough weighted samples', () => {
    const s = buildPaceSamples([row(6000, 0), row(6000, 0), row(6000, 0)], NOW)
    expect(pace(s, 'bg', 'en', 'forward', true)).toBe(6000)
  })

  it('widens to a broader bucket when the exact one is too thin', () => {
    // One Bulgarian typed review is not enough on its own; the cross-language forward-typed bucket is.
    const rows = [
      row(6000, 0, { source_language: 'es' }),
      row(6000, 0, { source_language: 'es' }),
      row(6000, 0, { source_language: 'es' }),
      row(30_000, 0),
    ]
    expect(pace(buildPaceSamples(rows, NOW), 'bg', 'en', 'forward', true)).toBe(6000)
  })

  it('falls back to a fixed figure with no history at all', () => {
    expect(pace(buildPaceSamples([], NOW), 'bg', 'en', 'forward', true)).toBe(DEFAULT_DUE_MS)
  })

  it('skips rows with no recorded duration rather than counting them as instant', () => {
    const s = buildPaceSamples([row(0, 0), row(0, 0), row(0, 0)], NOW)
    expect(pace(s, 'bg', 'en', 'forward', true)).toBe(DEFAULT_DUE_MS)
  })

  it('measures typed and self-graded separately', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => row(12_000, 0, { was_typed: true })),
      ...Array.from({ length: 4 }, () => row(3_000, 0, { was_typed: false })),
    ]
    const s = buildPaceSamples(rows, NOW)
    expect(pace(s, 'bg', 'en', 'forward', true)).toBe(12_000)
    expect(pace(s, 'bg', 'en', 'forward', false)).toBe(3_000)
  })
})
