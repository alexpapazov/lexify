'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { LadderStudy } from '@/components/ladder/LadderStudy'

function Inner() {
  const folderId = useSearchParams().get('folder') ?? ''
  return <LadderStudy scope={{ kind: 'folder', folderId }} />
}

export default function LadderFolderPage() {
  return <Suspense fallback={<p className="p-6 text-sm text-ink-faint">Loading…</p>}><Inner /></Suspense>
}
