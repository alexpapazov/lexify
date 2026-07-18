/*
 * Lexify service worker — offline app shell.
 *
 * Goal: once the app has been opened online, it can boot with NO connection so the offline study mode
 * (IndexedDB-backed) works from the home-screen icon. Data still comes from Supabase/IndexedDB — the
 * SW only caches the static shell (HTML documents + /_next/static assets + icons).
 *
 * Strategy:
 *   - /_next/static, /icons, fonts, images  → cache-first (immutable, hashed).
 *   - navigations (HTML documents)          → network-first, fall back to cache, then to /study.
 *   - other same-origin GET (incl. RSC)     → network-first, fall back to cache.
 *   - cross-origin (Supabase, APIs) & /api  → never touched: straight to network (fail as designed
 *                                             when offline; the app handles that via offline mode).
 */
const CACHE = 'lexify-shell-v1'
const APP_SHELL_FALLBACK = '/study'

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(['/study', '/manifest.webmanifest']).catch(() => {})))
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    await self.clients.claim()
  })())
})

function isStaticAsset(url) {
  return url.pathname.startsWith('/_next/static/') ||
         url.pathname.startsWith('/icons/') ||
         /\.(?:js|css|woff2?|ttf|otf|png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname)
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const res = await fetch(request)
  if (res && res.ok) { const c = await caches.open(CACHE); c.put(request, res.clone()) }
  return res
}

async function networkFirst(request, { fallbackToShell = false } = {}) {
  try {
    const res = await fetch(request)
    if (res && res.ok && res.type === 'basic') { const c = await caches.open(CACHE); c.put(request, res.clone()) }
    return res
  } catch (err) {
    const cached = await caches.match(request)
    if (cached) return cached
    if (fallbackToShell) {
      const shell = await caches.match(APP_SHELL_FALLBACK)
      if (shell) return shell
    }
    throw err
  }
}

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return          // Supabase & other origins: untouched
  if (url.pathname.startsWith('/api/')) return             // our API routes: never cache

  if (isStaticAsset(url)) { event.respondWith(cacheFirst(request)); return }
  if (request.mode === 'navigate') { event.respondWith(networkFirst(request, { fallbackToShell: true })); return }
  event.respondWith(networkFirst(request))
})
