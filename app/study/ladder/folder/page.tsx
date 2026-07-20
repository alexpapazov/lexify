'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { LadderStudy } from '@/components/ladder/LadderStudy'

function Inner() {
  const folderId = useSearchParams().get('folder') ?? ''
  return <LadderStudy scope={{ kind: 'folder', folderId }} />
}

export default function LadderFolderPage() {
  return <Suspense fallback={<div className="text-ink-muted pt-16 text-center">Loading session…</div>}><Inner /></Suspense>
}
