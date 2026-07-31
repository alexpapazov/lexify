/**
 * lib/offline/mode.ts — the global "offline mode" switch. When ON, the repos read/write the local
 * store (and queue changes for sync); when OFF, they hit Supabase as normal. Persisted in
 * localStorage so it survives reloads. Server-side (no localStorage) it's always OFF.
 *
 * This module must stay free of React imports — it's pulled into server bundles via the repo layer
 * (e.g. the agents API route). The reactive `useOfflineMode` hook lives in `./useOfflineMode`.
 */
const OFFLINE_KEY = 'lexify-offline-mode'
export const OFFLINE_EVENT = 'lexify:offline-mode'

/** True when offline mode is engaged (client-only). Safe to call anywhere — false on the server. */
export function isOfflineActive(): boolean {
  if (typeof localStorage === 'undefined') return false
  try { return localStorage.getItem(OFFLINE_KEY) === 'on' } catch { return false }
}

export function setOfflineMode(on: boolean): void {
  try { localStorage.setItem(OFFLINE_KEY, on ? 'on' : 'off') } catch { /* ignore */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OFFLINE_EVENT))
}
