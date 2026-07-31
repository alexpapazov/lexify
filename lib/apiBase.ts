/**
 * lib/apiBase.ts — resolves the origin for calls to our own /api routes.
 *
 * On the web build the app and the API share an origin, so /api/* is relative. In the native
 * (Capacitor) build the app is served from a local file scheme with no server of its own, so /api/*
 * must target the DEPLOYED origin. Set NEXT_PUBLIC_API_ORIGIN (e.g. https://lexify-flax.vercel.app)
 * for the Capacitor build; leave it empty on web so URLs stay relative.
 *
 * These endpoints are AI features (card gen, distractors, TTS, IPA, sync, agents) — online-only. Offline
 * mode already gates them; this just points them at the right host when the native app IS online.
 */
const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? ''

/** Absolute-or-relative URL for one of our /api routes. */
export function apiUrl(path: string): string {
  return API_ORIGIN + path
}
