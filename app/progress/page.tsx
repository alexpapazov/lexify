'use client'

import { useState } from 'react'
import { DueForecastProjection } from '@/components/analytics/DueForecastProjection'
import { ReviewCalendar } from '@/components/analytics/ReviewCalendar'
import { Segmented } from '@/components/analytics/Segmented'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'

type View = 'past' | 'present' | 'future'

export default function AnalyticsPage() {
  const offline = useOfflineMode()
  const [view, setView] = useState<View>('future')

  if (offline) return <OfflineUnavailable feature="Analytics" />

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Analytics</h1>
      <Segmented<View>
        value={view}
        onChange={setView}
        options={[{ value: 'past', label: 'Past' }, { value: 'present', label: 'Present' }, { value: 'future', label: 'Future' }]}
      />

      {view === 'past' && (
        <div className="panel p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Review history</h2>
            <p className="text-xs text-ink-faint">Each day&apos;s ring shows the language mix; the center is % of that day&apos;s goal (green only if every language also hit its own goal). Tap a day for details.</p>
          </div>
          <ReviewCalendar />
        </div>
      )}

      {view === 'present' && (
        <div className="panel p-10 text-center text-sm text-ink-muted">Coming soon — today at a glance.</div>
      )}

      {view === 'future' && (
        <div className="panel p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Projected Due Now load</h2>
            <p className="text-xs text-ink-faint">Your existing cards plus new cards from your daily goals, simulated on the FSRS model by Monte Carlo per language — each language&apos;s measured initial interval, average difficulty, and rating mix (again/hard/good/easy). Every card is played forward many times; the lines are the average and the shaded band is the p10–p90 range. Split into typed, self-graded (recall + smart-typing past its threshold), and reverse recognition.</p>
          </div>
          <DueForecastProjection />
        </div>
      )}
    </div>
  )
}
