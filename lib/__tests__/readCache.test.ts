import { cachedRead, invalidateReads, clearReadCache, idsKey } from '@/lib/readCache'

describe('readCache', () => {
  beforeEach(() => clearReadCache())

  it('serves a second call within the TTL from cache (fetcher runs once)', async () => {
    let calls = 0
    const fetcher = async () => { calls++; return ['a', 'b'] }
    const first = await cachedRead('k1', fetcher)
    const second = await cachedRead('k1', fetcher)
    expect(calls).toBe(1)
    expect(second).toBe(first) // same object — cached results are shared, treat as immutable
  })

  it('de-dupes concurrent in-flight calls into one fetch', async () => {
    let calls = 0
    let release!: (v: number) => void
    const gate = new Promise<number>(r => { release = r })
    const fetcher = () => { calls++; return gate }
    const p1 = cachedRead('k2', fetcher)
    const p2 = cachedRead('k2', fetcher)
    release(42)
    expect(await p1).toBe(42)
    expect(await p2).toBe(42)
    expect(calls).toBe(1)
  })

  it('refetches after the TTL expires', async () => {
    let calls = 0
    const fetcher = async () => ++calls
    await cachedRead('k3', fetcher, 50)
    await new Promise(r => setTimeout(r, 60))
    expect(await cachedRead('k3', fetcher, 50)).toBe(2)
  })

  it('invalidateReads drops matching prefixes and keeps others', async () => {
    let a = 0, b = 0
    await cachedRead('states:all:u1', async () => ++a)
    await cachedRead('cards:all:u1', async () => ++b)
    invalidateReads('states:')
    expect(await cachedRead('states:all:u1', async () => ++a)).toBe(2) // refetched
    expect(await cachedRead('cards:all:u1', async () => ++b)).toBe(1)  // still cached
  })

  it('a rejected fetch is evicted so the next call retries', async () => {
    let calls = 0
    const failing = async () => { calls++; throw new Error('boom') }
    await expect(cachedRead('k4', failing)).rejects.toThrow('boom')
    // Allow the eviction microtask to run.
    await Promise.resolve()
    await expect(cachedRead('k4', failing)).rejects.toThrow('boom')
    expect(calls).toBe(2)
  })

  it('idsKey is order-insensitive and distinguishes different sets', () => {
    expect(idsKey(['a', 'b', 'c'])).toBe(idsKey(['c', 'a', 'b']))
    expect(idsKey(['a', 'b'])).not.toBe(idsKey(['a', 'c']))
    expect(idsKey(['a', 'b'])).not.toBe(idsKey(['a', 'b', 'c']))
  })
})
