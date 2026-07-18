import { coalesceOutbox } from '@/lib/offline/coalesce'
import type { OutboxEntry } from '@/lib/offline/types'

const iso = '2026-07-18T00:00:00.000Z'
const e = (id: number, entity: OutboxEntry['entity'], key: string, op: OutboxEntry['op'], payload: unknown = {}): OutboxEntry =>
  ({ id, entity, key, op, payload, localUpdatedAt: iso })

describe('coalesceOutbox', () => {
  it('collapses repeated card-state upserts to the last value, keeping all ids', () => {
    const out = coalesceOutbox([
      e(1, 'cardState', 'a:forward', 'upsert', { reps: 1 }),
      e(2, 'cardState', 'a:forward', 'upsert', { reps: 2 }),
      e(3, 'cardState', 'a:forward', 'upsert', { reps: 3 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.payload).toEqual({ reps: 3 })
    expect(out[0]!.ids).toEqual([1, 2, 3])
  })

  it('upsert-then-delete on the same key collapses to a delete (last op wins)', () => {
    const out = coalesceOutbox([
      e(1, 'cardState', 'a:forward', 'upsert', { reps: 1 }),
      e(2, 'cardState', 'a:forward', 'delete', { cardId: 'a' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.op).toBe('delete')
    expect(out[0]!.ids).toEqual([1, 2])
  })

  it('keeps append-only events as distinct inserts', () => {
    const out = coalesceOutbox([
      e(1, 'reviewEvent', 'r1', 'insert'),
      e(2, 'reviewEvent', 'r2', 'insert'),
      e(3, 'ladderEvent', 'l1', 'insert'),
    ])
    expect(out).toHaveLength(3)
  })

  it('collapses per key, not across keys, preserving first-seen order', () => {
    const out = coalesceOutbox([
      e(1, 'cardState', 'a:forward', 'upsert', { v: 1 }),
      e(2, 'cardState', 'b:forward', 'upsert', { v: 1 }),
      e(3, 'cardState', 'a:forward', 'upsert', { v: 2 }),
    ])
    expect(out.map(o => o.key)).toEqual(['a:forward', 'b:forward'])
    expect(out[0]!.payload).toEqual({ v: 2 })
    expect(out[0]!.ids).toEqual([1, 3])
  })

  it('treats override insert/delete as last-write-wins', () => {
    const out = coalesceOutbox([
      e(1, 'override', 'a:front:x', 'insert'),
      e(2, 'override', 'a:front:x', 'delete'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.op).toBe('delete')
  })
})
