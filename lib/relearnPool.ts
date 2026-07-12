import type { CardState } from '@/domain'

/** Any queue entry that can sit in the relearn pool. */
export interface RelearnEntry {
  state: CardState
  /** The session's answer counter when this card lapsed into relearn (drives the batch-size window). */
  relearnLapsedAt?: number
}

export interface PoolPartition<T> {
  /** Real-clock due (dueAt has elapsed) → resurface now, soonest first. */
  due: T[]
  /** Still waiting: within the batch-size window and not yet due → keep in the pool. */
  keep: T[]
  /** Batch-size window passed without the time elapsing → drop from this session (rolls to a
   *  later one automatically, since dueAt is already persisted). */
  dropped: T[]
}

/**
 * Partition a relearn pool by REAL CLOCK time and a batch-size window.
 *
 * A card that fails a graduated review (Again/Hard) enters a 5/10/20-minute relearn loop with a
 * concrete `dueAt`. It should resurface *this* session only once its real time has elapsed AND
 * fewer than `batchSize` cards have been answered since it lapsed; otherwise it rolls to a future
 * session (its `dueAt` is saved, so a later due-session picks it up when the time has passed).
 */
export function partitionRelearnPool<T extends RelearnEntry>(
  pool: T[], reviewCount: number, batchSize: number, now: number,
): PoolPartition<T> {
  const dueMs = (c: T) => (c.state.dueAt ? new Date(c.state.dueAt).getTime() : 0)
  const due: T[] = [], keep: T[] = [], dropped: T[] = []
  for (const c of pool) {
    if (dueMs(c) <= now) due.push(c)
    else if (reviewCount - (c.relearnLapsedAt ?? reviewCount) >= batchSize) dropped.push(c)
    else keep.push(c)
  }
  due.sort((a, b) => dueMs(a) - dueMs(b))
  return { due, keep, dropped }
}
