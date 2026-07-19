'use client'

import { AnalyticsTabs } from '@/components/analytics/AnalyticsTabs'
import { ReviewCalendar } from '@/components/analytics/ReviewCalendar'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'

export default function HistoryPage() {
  const offline = useOfflineMode()
  if (offline) return <OfflineUnavailable feature="Analytics" />

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Analytics</h1>
      <AnalyticsTabs />
      <div className="panel p-5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Review history</h2>
          <p className="text-xs text-ink-faint">Each day&apos;s ring shows the language mix; the center is % of that day&apos;s goal (green only if every language also hit its own goal). Tap a day for details.</p>
        </div>
        <ReviewCalendar />
      </div>
    </div>
  )
}
