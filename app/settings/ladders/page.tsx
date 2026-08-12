'use client'

// Learning ladders moved into the unified Settings page (2026-08-11). Kept as a redirect so old links
// — including per-language ones carrying ?source=&target= — still resolve.

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function LaddersRedirect() {
  const router = useRouter()
  const params = useSearchParams()
  const source = params.get('source')
  const target = params.get('target')
  useEffect(() => {
    const pair = source && target ? `&source=${source}&target=${target}` : ''
    router.replace(`/settings?section=ladders${pair}`)
  }, [router, source, target])
  return <p className="p-6 text-sm text-ink-faint">Opening learning ladders…</p>
}

export default function LaddersPage() {
  return <Suspense fallback={<p className="p-6 text-sm text-ink-faint">Loading…</p>}><LaddersRedirect /></Suspense>
}
