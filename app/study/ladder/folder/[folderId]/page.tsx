'use client'

import { Suspense } from 'react'
import { useParams } from 'next/navigation'
import { LadderStudy } from '@/components/ladder/LadderStudy'

function Inner() {
  const { folderId } = useParams<{ folderId: string }>()
  return <LadderStudy scope={{ kind: 'folder', folderId }} />
}

export default function LadderFolderPage() {
  return <Suspense fallback={<p className="p-6 text-sm text-ink-faint">Loading…</p>}><Inner /></Suspense>
}
