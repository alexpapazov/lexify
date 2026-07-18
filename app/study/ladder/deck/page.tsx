'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { LadderStudy } from '@/components/ladder/LadderStudy'

function Inner() {
  const deckId = useSearchParams().get('deck') ?? ''
  return <LadderStudy scope={{ kind: 'deck', deckId }} />
}

export default function LadderDeckPage() {
  return <Suspense fallback={<p className="p-6 text-sm text-ink-faint">Loading…</p>}><Inner /></Suspense>
}
