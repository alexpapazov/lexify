'use client'

/**
 * lib/offline/useOfflineMode.ts — the reactive React binding for the offline switch. Kept separate
 * from `./mode` (which is server-safe) so importing the flag in a repo never drags React into a
 * server bundle.
 */
import { useSyncExternalStore } from 'react'
import { OFFLINE_EVENT, isOfflineActive } from './mode'

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(OFFLINE_EVENT, cb)
  window.addEventListener('storage', cb) // reflect changes from other tabs
  return () => { window.removeEventListener(OFFLINE_EVENT, cb); window.removeEventListener('storage', cb) }
}

/** Reactive read of the offline flag for components. */
export function useOfflineMode(): boolean {
  return useSyncExternalStore(subscribe, isOfflineActive, () => false)
}
