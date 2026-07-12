import { partitionRelearnPool, type RelearnEntry } from '@/lib/relearnPool'

const NOW = 1_000_000_000_000
const entry = (dueAtMs: number, lapsedAt: number): RelearnEntry =>
  ({ state: { dueAt: new Date(dueAtMs).toISOString() } as RelearnEntry['state'], relearnLapsedAt: lapsedAt })

describe('partitionRelearnPool', () => {
  it('resurfaces a card once its real-clock time has elapsed', () => {
    const pool = [entry(NOW - 1000, 0)]           // due 1s ago
    const { due, keep, dropped } = partitionRelearnPool(pool, 3, 20, NOW)
    expect(due).toHaveLength(1)
    expect(keep).toHaveLength(0)
    expect(dropped).toHaveLength(0)
  })

  it('keeps a not-yet-due card that is still inside the batch-size window', () => {
    const pool = [entry(NOW + 60_000, 0)]         // due in 1 min, lapsed at answer 0
    const { due, keep, dropped } = partitionRelearnPool(pool, 5, 20, NOW)  // only 5 answers since
    expect(due).toHaveLength(0)
    expect(keep).toHaveLength(1)
    expect(dropped).toHaveLength(0)
  })

  it('drops a not-yet-due card once batchSize cards have passed (rolls to a later session)', () => {
    const pool = [entry(NOW + 60_000, 0)]         // due in 1 min, lapsed at answer 0
    const { due, keep, dropped } = partitionRelearnPool(pool, 20, 20, NOW) // 20 answers since → window up
    expect(due).toHaveLength(0)
    expect(keep).toHaveLength(0)
    expect(dropped).toHaveLength(1)
  })

  it('a due card resurfaces even past its window (time wins over the count cap)', () => {
    const pool = [entry(NOW - 1000, 0)]
    const { due, dropped } = partitionRelearnPool(pool, 999, 20, NOW)
    expect(due).toHaveLength(1)
    expect(dropped).toHaveLength(0)
  })

  it('returns due cards soonest-first', () => {
    const pool = [entry(NOW - 1000, 0), entry(NOW - 9000, 0), entry(NOW - 5000, 0)]
    const { due } = partitionRelearnPool(pool, 3, 20, NOW)
    expect(due.map(d => d.state.dueAt)).toEqual([
      new Date(NOW - 9000).toISOString(),
      new Date(NOW - 5000).toISOString(),
      new Date(NOW - 1000).toISOString(),
    ])
  })
})
