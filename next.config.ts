import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    turbo: {
      root: __dirname,
    },
  },
}

export default nextConfig
