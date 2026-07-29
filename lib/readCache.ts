/**
 * lib/readCache.ts — short-TTL cross-navigation read cache.
 *
 * Every study surface (dashboard, the 3 session pages, the ladder, Library) refetches the same
 * whole-library reads on mount, so dashboard → session → dashboard pays the full load three times
 * within a minute. This module memoizes those reads for a short window so the second hop is served
 * from memory — the win is biggest on the phone, where each round trip is 100–300 ms.
 *
 * Correctness model:
 *  - Entries live for TTL_MS (60 s) — long enough to cover a navigation hop, short enough that
 *    external changes (another device, the calibrate route's server-side writes) stay bounded.
 *  - Every repo WRITE calls `invalidateReads(...)` with its family prefix, so an answered card
 *    (states), an edited card (cards), a settings toggle (params) is never served stale locally.
 *  - Offline mode bypasses the cache entirely — local-store reads are already fast, and the outbox
 *    flow must always see its own writes.
 *  - In-flight de-dupe: concurrent callers of the same key share one promise. Rejections evict
 *    immediately so a retry refetches.
 *
 * Treat cached results as IMMUTABLE — the same array/Map/objects are handed to every caller within
 * the TTL. Copy before sorting or patching (all current consumers already do).
 */

import { isOfflineActive } from '@/lib/offline/mode'

const TTL_MS = 60_000

type Entry = { at: number; promise: Promise<unknown> }
const store = new Map<string, Entry>()

export function cachedRead<T>(key: string, fetcher: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
  if (isOfflineActive()) return fetcher()
  const now = Date.now()
  const hit = store.get(key)
  if (hit && now - hit.at < ttlMs) return hit.promise as Promise<T>
  const promise = fetcher()
  promise.catch(() => { if (store.get(key)?.promise === promise) store.delete(key) })
  store.set(key, { at: now, promise })
  return promise
}

/** Drops every cached entry whose key starts with any of the given prefixes. Call from writes. */
export function invalidateReads(...prefixes: string[]): void {
  for (const key of store.keys()) {
    if (prefixes.some(p => key.startsWith(p))) store.delete(key)
  }
}

/** Full reset — used by auth sign-out and tests. */
export function clearReadCache(): void { store.clear() }

/**
 * Stable short key for an id list (deck ids, card ids): order-insensitive, bounded length.
 * djb2 over the sorted join — collisions are astronomically unlikely at cache scale, and the
 * appended count guards the degenerate cases.
 */
export function idsKey(ids: string[]): string {
  const joined = [...ids].sort().join(',')
  let h = 5381
  for (let i = 0; i < joined.length; i++) h = ((h << 5) + h + joined.charCodeAt(i)) | 0
  return `${(h >>> 0).toString(36)}:${ids.length}`
}
