import type { CapacitorConfig } from '@capacitor/cli'

// Native (iOS/Android) shell config. The web app is exported to `out/` by `npm run build:cap`
// and bundled into the app, so it launches offline. Online AI features reach the deployed API via
// NEXT_PUBLIC_API_ORIGIN (baked into that build). Change `appId` to your own reverse-DNS bundle id
// BEFORE running `npx cap add ios` (it can't be changed cleanly afterwards).
const config: CapacitorConfig = {
  appId: 'com.alexpapazov.lexify',
  appName: 'Lexify',
  webDir: 'out',
  // Dark surface-deep (#13141F) so the safe-area strips (status bar / home indicator) match the app
  // instead of showing white behind the web view.
  backgroundColor: '#13141F',
  ios: {
    // 'never' lets the web view go edge-to-edge; we pad for the status bar / home indicator with
    // CSS env(safe-area-inset-*) so the sticky navbar sits below the status bar and content clears
    // the home indicator (viewport-fit=cover is set in the app's viewport meta).
    contentInset: 'never',
    backgroundColor: '#13141F',
  },
}

export default config
