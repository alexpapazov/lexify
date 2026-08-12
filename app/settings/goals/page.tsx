'use client'

// Daily goals moved into the unified Settings page (2026-08-11). This route is kept so old links,
// bookmarks and the native app's cached shell still land somewhere correct.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function GoalsRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/settings?section=goals') }, [router])
  return <p className="p-6 text-sm text-ink-faint">Opening daily goals…</p>
}
