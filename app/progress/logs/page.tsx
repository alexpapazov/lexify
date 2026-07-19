'use client'

import { useState } from 'react'
import { LadderLogs } from '@/components/analytics/LadderLogs'
import { Segmented } from '@/components/analytics/Segmented'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'

type View = 'duenow' | 'learning'

export default function LogsPage() {
  const offline = useOfflineMode()
  const [view, setView] = useState<View>('learning')

  if (offline) return <OfflineUnavailable feature="Analytics" />

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Analytics</h1>
      <Segmented<View>
        value={view}
        onChange={setView}
        options={[{ value: 'duenow', label: 'Due Now' }, { value: 'learning', label: 'Learning pipeline' }]}
      />

      {view === 'learning' && <LadderLogs />}
      {view === 'duenow' && (
        <div className="panel p-10 text-center text-sm text-ink-muted">Coming soon — Due Now review movies &amp; logs.</div>
      )}
    </div>
  )
}
