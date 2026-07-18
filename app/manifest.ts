import type { MetadataRoute } from 'next'

// PWA web app manifest (served at /manifest.webmanifest). Makes Lexify installable to a phone/iPad
// home screen and launches it standalone (no browser chrome). Offline behaviour comes from the
// service worker (public/sw.js) + the offline mode toggle.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Lexify',
    short_name: 'Lexify',
    description: 'Vocabulary learning with spaced repetition.',
    start_url: '/study',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#12121a',
    theme_color: '#12121a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
