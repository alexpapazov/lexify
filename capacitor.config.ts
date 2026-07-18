import type { CapacitorConfig } from '@capacitor/cli'

// Native (iOS/Android) shell config. The web app is exported to `out/` by `npm run build:cap`
// and bundled into the app, so it launches offline. Online AI features reach the deployed API via
// NEXT_PUBLIC_API_ORIGIN (baked into that build). Change `appId` to your own reverse-DNS bundle id
// BEFORE running `npx cap add ios` (it can't be changed cleanly afterwards).
const config: CapacitorConfig = {
  appId: 'com.lexify.app',
  appName: 'Lexify',
  webDir: 'out',
  ios: {
    contentInset: 'always',
  },
}

export default config
