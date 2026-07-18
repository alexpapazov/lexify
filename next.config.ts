import type { NextConfig } from 'next'

// The native (Capacitor) build is a fully static export bundled into the app; the normal Vercel
// deploy stays server-rendered (with the /api routes). Toggle with CAPACITOR_BUILD=1.
const isCapacitor = process.env.CAPACITOR_BUILD === '1'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(isCapacitor ? { output: 'export', images: { unoptimized: true } } : {}),
}

export default nextConfig
