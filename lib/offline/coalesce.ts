/**
 * lib/offline/coalesce.ts — collapse the offline outbox into the minimal set of server writes.
 *
 * State-like entities (cardState, ladderClimb, override, card) are last-write-wins per key: if a
 * card state was upserted five times offline, only the final value needs to reach the server. The
 * accumulated outbox ids ride along so the sync engine can clear every collapsed row once the single
 * write succeeds.
 *
 * Append-only entities (ladderEvent, reviewEvent) are kept as distinct inserts — each is its own row.
 * (Undo already removes a pending insert from the outbox before sync, so anything left is real.)
 */
import type { OutboxEntry, OutboxEntity } from './types'

export interface CoalescedOp {
  entity:         OutboxEntity
  key:            string
  op:             OutboxEntry['op']
  payload:        unknown
  localUpdatedAt: string
  ids:            number[]   // every outbox row this op stands in for (delete these on success)
}

const APPEND_ONLY: ReadonlySet<OutboxEntity> = new Set<OutboxEntity>(['ladderEvent', 'reviewEvent'])

export function coalesceOutbox(entries: OutboxEntry[]): CoalescedOp[] {
  const collapsed = new Map<string, CoalescedOp>()
  const result: CoalescedOp[] = []

  for (const e of entries) {
    const ids = e.id != null ? [e.id] : []
    if (APPEND_ONLY.has(e.entity)) {
      result.push({ entity: e.entity, key: e.key, op: e.op, payload: e.payload, localUpdatedAt: e.localUpdatedAt, ids })
      continue
    }
    const mapKey = `${e.entity}:${e.key}`
    const prev = collapsed.get(mapKey)
    if (prev) {
      // Last op wins; keep every id so the whole run gets cleared from the outbox on success.
      prev.op = e.op
      prev.payload = e.payload
      prev.localUpdatedAt = e.localUpdatedAt
      prev.ids.push(...ids)
    } else {
      const op: CoalescedOp = { entity: e.entity, key: e.key, op: e.op, payload: e.payload, localUpdatedAt: e.localUpdatedAt, ids }
      collapsed.set(mapKey, op)
      result.push(op) // mutated in place if it recurs, so insertion order is preserved
    }
  }
  return result
}
