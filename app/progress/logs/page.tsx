'use client'

import { LadderLogs } from '@/components/analytics/LadderLogs'
import { AnalyticsTabs } from '@/components/analytics/AnalyticsTabs'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'

export default function LogsPage() {
  const offline = useOfflineMode()
  if (offline) return <OfflineUnavailable feature="Analytics" />

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Analytics</h1>
      <AnalyticsTabs />
      <LadderLogs />
    </div>
  )
}
