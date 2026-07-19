'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/progress',             label: 'Overview'    },
  { href: '/progress/history',     label: 'History'     },
  { href: '/progress/connections', label: 'Connections' },
  { href: '/progress/logs',        label: 'Logs'        },
]

/** Sub-navigation shared across the Analytics pages (Overview / Connections / Logs). */
export function AnalyticsTabs() {
  const pathname = usePathname()
  return (
    <div className="flex items-center gap-1 bg-surface-raised rounded-card p-1 w-fit">
      {TABS.map(t => {
        const active = pathname === t.href
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-3 py-1.5 rounded text-sm transition-colors ${
              active ? 'bg-accent text-white font-medium' : 'text-ink-muted hover:text-ink'
            }`}
          >{t.label}</Link>
        )
      })}
    </div>
  )
}
