'use client'

/**
 * Registers the offline app-shell service worker (public/sw.js) once, after load. Registering only in
 * production avoids interfering with the dev server's HMR. Failures are non-fatal — the app works
 * without the SW, just without offline shell caching.
 */
import { useEffect } from 'react'

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    if (process.env.NODE_ENV !== 'production') return
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {})
    if (document.readyState === 'complete') register()
    else { window.addEventListener('load', register); return () => window.removeEventListener('load', register) }
  }, [])
  return null
}
