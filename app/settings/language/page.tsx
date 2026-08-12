'use client'

// Language configuration was folded into the unified Settings page (2026-08-11) — its sections are
// now rail entries. Kept as a redirect for old links and the nav's cached shell.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function LanguageSettingsRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/settings?section=study') }, [router])
  return <p className="p-6 text-sm text-ink-faint">Opening settings…</p>
}
