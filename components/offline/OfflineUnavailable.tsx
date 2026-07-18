'use client'

import Link from 'next/link'
import { setOfflineMode } from '@/lib/offline/mode'

/** Full-page placeholder for features that require a connection, shown while offline mode is on. */
export function OfflineUnavailable({ feature }: { feature: string }) {
  return (
    <div className="max-w-md mx-auto pt-24 text-center space-y-4">
      <div className="text-4xl">📴</div>
      <h1 className="text-xl font-semibold text-ink">{feature} isn&apos;t available offline</h1>
      <p className="text-sm text-ink-muted">Switch back online to use {feature.toLowerCase()}.</p>
      <div className="flex justify-center gap-3 pt-2">
        <button onClick={() => setOfflineMode(false)} className="btn-primary text-sm">Go online</button>
        <Link href="/study" className="btn-ghost text-sm">Back to study</Link>
      </div>
    </div>
  )
}
