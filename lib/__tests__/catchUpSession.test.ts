import { applyCatchUpPlans, type QueueItemFacts } from '@/lib/catchUpSession'
import { scopeKey, type CatchUpPlans, type CatchUpType } from '@/lib/catchUp'

const TODAY  = '2026-08-22'
const TARGET = '2026-09-05'   // 14 days out

interface Item {
  id: string
  pairKey: string
  type: CatchUpType
  bucket: 'overdue' | 'today'
  elapsedDays: number
  stability: number
}

function item(
  id: string, pairKey: string, bucket: 'overdue' | 'today',
  over: Partial<Item> = {},
): Item {
  return { id, pairKey, type: 'typing', bucket, elapsedDays: 12, stability: 15, ...over }
}

const describe_ = (i: Item): QueueItemFacts => ({
  pairKey: i.pairKey, type: i.type, bucket: i.bucket,
  candidate: { key: i.id, elapsedDays: i.elapsedDays, stability: i.stability },
})

const apply = (items: Item[], plans: CatchUpPlans) =>
  applyCatchUpPlans({ items, describe: describe_, plans, today: TODAY })

function many(prefix: string, n: number, pairKey: string, bucket: 'overdue' | 'today', over: Partial<Item> = {}) {
  return Array.from({ length: n }, (_, i) => item(`${prefix}${i}`, pairKey, bucket, over))
}

describe('applyCatchUpPlans', () => {
  it('returns the queue untouched when there are no plans', () => {
    const items = many('a', 5, 'bg|en', 'overdue')
    const out = apply(items, {})
    expect(out.queue).toBe(items)          // same reference — a no-plan session pays nothing
    expect(out.governed).toBe(false)
  })

  it('returns the queue untouched when no plan matches this scope', () => {
    const items = many('a', 5, 'bg|en', 'overdue')
    const out = apply(items, { 'es|en': { targetDate: TARGET } })
    expect(out.queue).toBe(items)
    expect(out.governed).toBe(false)
  })

  it('caps a governed scope to its daily quota and reports what was held back', () => {
    const items = [...many('t', 10, 'bg|en', 'today'), ...many('o', 140, 'bg|en', 'overdue')]
    const out = apply(items, { 'bg|en': { targetDate: TARGET } })

    expect(out.governed).toBe(true)
    expect(out.queue).toHaveLength(20)     // 10 due today + ceil(140/14)
    expect(out.heldBack).toBe(130)
  })

  it('never holds back a card that came due today', () => {
    const items = [...many('t', 30, 'bg|en', 'today'), ...many('o', 140, 'bg|en', 'overdue')]
    const served = new Set(apply(items, { 'bg|en': { targetDate: TARGET } }).queue.map(i => i.id))
    for (const i of items.filter(x => x.bucket === 'today')) expect(served.has(i.id)).toBe(true)
  })

  it('lets a type-level plan govern its type and leaves the other types alone', () => {
    const items = [
      ...many('ty', 140, 'bg|en', 'overdue', { type: 'typing' }),
      ...many('sg', 40,  'bg|en', 'overdue', { type: 'sgReverse' }),
    ]
    const out = apply(items, { [scopeKey('bg|en', 'typing')]: { targetDate: TARGET } })

    const served = out.queue.map(i => i.id)
    expect(served.filter(k => k.startsWith('ty'))).toHaveLength(10)   // ceil(140/14)
    expect(served.filter(k => k.startsWith('sg'))).toHaveLength(40)   // untouched
  })

  it('plans each language separately in a mixed session', () => {
    const items = [
      ...many('bg', 140, 'bg|en', 'overdue'),
      ...many('es', 70,  'es|en', 'overdue'),
    ]
    const out = apply(items, {
      'bg|en': { targetDate: TARGET },
      'es|en': { targetDate: '2026-08-29' },   // 7 days
    })
    const served = out.queue.map(i => i.id)
    expect(served.filter(k => k.startsWith('bg'))).toHaveLength(10)   // ceil(140/14)
    expect(served.filter(k => k.startsWith('es'))).toHaveLength(10)   // ceil(70/7)
  })

  it('mixes the languages rather than finishing one before starting the next', () => {
    const items = [...many('bg', 140, 'bg|en', 'overdue'), ...many('es', 140, 'es|en', 'overdue')]
    const out = apply(items, {
      'bg|en': { targetDate: TARGET }, 'es|en': { targetDate: TARGET },
    })
    const firstFour = out.queue.slice(0, 4).map(i => i.pairKey)
    expect(new Set(firstFour).size).toBe(2)
  })

  it('passes ungoverned cards through alongside a governed scope', () => {
    const items = [...many('bg', 140, 'bg|en', 'overdue'), ...many('es', 12, 'es|en', 'overdue')]
    const out = apply(items, { 'bg|en': { targetDate: TARGET } })
    const served = out.queue.map(i => i.id)
    expect(served.filter(k => k.startsWith('es'))).toHaveLength(12)   // every ungoverned card kept
    expect(served.filter(k => k.startsWith('bg'))).toHaveLength(10)
  })

  it('serves everything once the target date has passed', () => {
    const items = [...many('t', 5, 'bg|en', 'today'), ...many('o', 40, 'bg|en', 'overdue')]
    const out = apply(items, { 'bg|en': { targetDate: '2026-08-01' } })
    expect(out.queue).toHaveLength(45)
    expect(out.heldBack).toBe(0)
  })

  it('reports how much of the served queue is relearning', () => {
    const items = [
      ...many('t',    40, 'bg|en', 'today'),
      ...many('slip', 100, 'bg|en', 'overdue', { elapsedDays: 12,  stability: 15 }),
      ...many('gone', 100, 'bg|en', 'overdue', { elapsedDays: 400, stability: 15 }),
    ]
    const out = apply(items, { 'bg|en': { targetDate: TARGET } })
    expect(out.lapsedServed).toBeGreaterThan(0)
    expect(out.lapsedServed).toBeLessThanOrEqual(Math.floor(out.queue.length * 0.25) + 1)
  })

  it('keeps an item whose describe() returns null', () => {
    // A row the caller can't classify must still be served, not silently dropped.
    const items = many('a', 4, 'bg|en', 'overdue')
    const out = applyCatchUpPlans({
      items,
      describe: (i: Item) => (i.id === 'a0' ? null : describe_(i)),
      plans: { 'bg|en': { targetDate: TARGET } },
      today: TODAY,
    })
    expect(out.queue.map(i => i.id)).toContain('a0')
  })

  it('does not drop a duplicate candidate key', () => {
    const dup = [item('same', 'bg|en', 'overdue'), item('same', 'bg|en', 'overdue')]
    const out = apply(dup, { 'bg|en': { targetDate: TARGET } })
    expect(out.queue).toHaveLength(2)
  })
})
