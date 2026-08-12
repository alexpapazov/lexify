'use client'

/**
 * components/settings/SettingsShell.tsx — the frame every settings section renders inside.
 *
 * One Settings destination with a section rail, replacing the old two pages of stacked panels. The
 * layout is deliberately FLAT: no cards, no boxes — a section heading, generous spacing, and hairline
 * dividers between sub-sections. Boxes inside a pane that is already a box read as clutter.
 *
 * **Sections are a query param, not a route segment** (`/settings?section=profile`). That is a hard
 * constraint, not a preference: the native build is a static export, which cannot serve dynamic route
 * segments — see the `lib/routes.ts` note. It also means a section link survives a page reload and can
 * be deep-linked from anywhere.
 *
 * On a narrow screen the rail becomes a horizontally scrolling tab strip above the content, so
 * switching sections is one tap and the content still gets the full width.
 */

import Link from 'next/link'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'

export type SettingsSectionId =
  | 'profile' | 'appearance' | 'time' | 'offline'
  | 'goals' | 'ladders' | 'study'
  | 'colors' | 'sync' | 'labels'
  | 'data' | 'danger'

interface SectionDef {
  id:       SettingsSectionId
  label:    string
  /** Hidden when offline — these need a connection (AI, sync, server-side scans). */
  online?:  boolean
  /** Forwarded to the rail link so the product tour can still find its anchors. */
  tour?:    string
}

interface SectionGroup { title: string; items: SectionDef[] }

/** The rail, in reading order. Groups are just visual — every id is addressable directly. */
export const SETTINGS_GROUPS: SectionGroup[] = [
  {
    title: 'General',
    items: [
      { id: 'profile',    label: 'Profile' },
      { id: 'appearance', label: 'Appearance', tour: 'settings-theme' },
      { id: 'time',       label: 'Time zone',  online: true, tour: 'settings-timezone' },
      { id: 'offline',    label: 'Offline' },
    ],
  },
  {
    title: 'Learning',
    items: [
      { id: 'goals',   label: 'Daily goals' },
      { id: 'ladders', label: 'Learning ladders', tour: 'settings-ladder' },
      { id: 'study',   label: 'Study defaults' },
    ],
  },
  {
    title: 'Languages',
    items: [
      { id: 'colors', label: 'Language colors' },
      { id: 'sync',   label: 'Language sync', online: true, tour: 'settings-sync' },
      { id: 'labels', label: 'Vocabulary labels', online: true },
    ],
  },
  {
    title: 'Data',
    items: [
      { id: 'data',   label: 'Redistribute cards', online: true },
      { id: 'danger', label: 'Danger zone',        online: true },
    ],
  },
]

const ALL_SECTIONS = SETTINGS_GROUPS.flatMap(g => g.items)

/** Narrows an arbitrary `?section=` value; anything unknown falls back to the first section. */
export function parseSection(raw: string | null): SettingsSectionId {
  const found = ALL_SECTIONS.find(s => s.id === raw)
  return found ? found.id : 'profile'
}

export function sectionLabel(id: SettingsSectionId): string {
  return ALL_SECTIONS.find(s => s.id === id)?.label ?? 'Settings'
}

/** `/settings?section=…` — the one place these URLs are built. */
export function settingsHref(id: SettingsSectionId): string {
  return `/settings?section=${id}`
}

export function SettingsShell({ active, children }: {
  active:   SettingsSectionId
  children: React.ReactNode
}) {
  const offline = useOfflineMode()
  const groups = SETTINGS_GROUPS
    .map(g => ({ ...g, items: g.items.filter(i => !(offline && i.online)) }))
    .filter(g => g.items.length > 0)

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link href="/study" aria-label="Back to study"
          className="p-1.5 -ml-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-surface/60 transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
        </Link>
        <h1 className="text-xl font-medium text-ink">Settings</h1>
      </div>

      <div className="md:flex md:gap-10 md:items-start">
        {/* Rail — desktop. `md:sticky` keeps it in place while a long section scrolls past. */}
        <nav className="hidden md:block w-48 lg:w-56 shrink-0 md:sticky md:top-20 space-y-5">
          {groups.map(group => (
            <div key={group.title} className="space-y-0.5">
              <p className="px-3 pb-1 text-[10px] uppercase tracking-wider text-ink-faint">{group.title}</p>
              {group.items.map(item => (
                <Link key={item.id} href={settingsHref(item.id)} data-tour={item.tour}
                  className={[
                    'block px-3 py-2 rounded-full text-sm transition-colors',
                    item.id === active ? 'bg-accent/15 text-accent font-medium' : 'text-ink-muted hover:text-ink hover:bg-surface/60',
                  ].join(' ')}>
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        {/* Rail — mobile: one scrolling strip of chips, groups flattened (their titles would
            double the height of the strip for no navigational gain at this size). */}
        <nav className="md:hidden no-scrollbar -mx-4 px-4 mb-5 flex gap-2 overflow-x-auto">
          {groups.flatMap(g => g.items).map(item => (
            <Link key={item.id} href={settingsHref(item.id)} data-tour={item.tour}
              className={[
                'shrink-0 px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors border',
                item.id === active
                  ? 'bg-accent/15 text-accent border-accent/30 font-medium'
                  : 'text-ink-muted border-line/10 hover:text-ink',
              ].join(' ')}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  )
}

// ─── Building blocks for a section's contents ────────────────────────────────

/**
 * One block within a pane: a heading, optional one-line description, then its controls.
 *
 * `divide-y` on the parent draws the hairlines, so a section never draws its own border — that's what
 * keeps a pane reading as one continuous page instead of a stack of cards.
 */
export function SettingsSection({ title, description, children }: {
  title:        string
  description?: React.ReactNode
  children:     React.ReactNode
}) {
  return (
    <section className="py-6 first:pt-0 space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-medium text-ink">{title}</h2>
        {description && <p className="text-sm text-ink-muted max-w-2xl">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** Wraps a pane's sections so the hairlines between them are drawn in one place. */
export function SettingsPane({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-line/10">{children}</div>
}

/** A labelled row: label (+ hint) on the left, control on the right. Stacks on narrow screens. */
export function SettingsRow({ label, hint, children }: {
  label:     string
  hint?:     React.ReactNode
  children:  React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-1.5">
      <div className="space-y-0.5 min-w-0">
        <p className="text-sm text-ink">{label}</p>
        {hint && <p className="text-xs text-ink-faint max-w-xl">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
