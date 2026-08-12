'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ConnectionGraph } from '@/components/analytics/ConnectionGraph'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'

export default function ConnectionsPage() {
  const offline = useOfflineMode()
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    createClient().auth.getSession().then(({ data }) => setUserId(data.session?.user.id ?? null))
  }, [])

  if (offline) return <OfflineUnavailable feature="Analytics" />

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Analytics</h1>
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Card connections</h2>
        {userId ? <ConnectionGraph userId={userId} /> : <p className="text-sm text-ink-faint">Loading…</p>}
      </div>
    </div>
  )
}
