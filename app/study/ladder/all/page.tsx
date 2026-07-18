'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { LadderStudy } from '@/components/ladder/LadderStudy'

function Inner() {
  const params = useSearchParams()
  const source = params.get('source') ?? ''
  const target = params.get('target') ?? ''
  return <LadderStudy scope={{ kind: 'all', source, target }} />
}

export default function LadderAllPage() {
  return <Suspense fallback={<p className="p-6 text-sm text-ink-faint">Loading…</p>}><Inner /></Suspense>
}
