'use client'

import Link from 'next/link'
import { loadProfileRow } from '@/lib/offline/profilePrefs'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { User } from '@supabase/supabase-js'
import { AvatarMenu } from './AvatarMenu'
import { ProfilePanel } from './ProfilePanel'
import { LexifyLogo } from '@/components/brand/LexifyLogo'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { setOfflineMode } from '@/lib/offline/mode'

const NAV_LINKS = [
  { href: '/study',     label: 'Study'    },
  { href: '/library',   label: 'Library'  },
  { href: '/browse',    label: 'Browse'   },
  { href: '/create',    label: 'Create'   },
  { href: '/agents',    label: 'Agents'   },
  { href: '/progress',  label: 'Analytics' },
  { href: '/settings',  label: 'Settings' },
]

export function Navbar() {
  const pathname = usePathname()
  const router   = useRouter()
  const supabase = createClient()
  const [user,        setUser]        = useState<User | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [avatarUrl,   setAvatarUrl]   = useState<string | null>(null)
  const [menuOpen,    setMenuOpen]    = useState(false)

  async function loadProfile(uid: string) {
    const { data } = await loadProfileRow(() => supabase.from('profiles').select('display_name, avatar_url').eq('user_id', uid).single())
    setDisplayName((data?.display_name as string | null) ?? null)
    setAvatarUrl((data?.avatar_url as string | null) ?? null)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user ?? null
      setUser(u)
      if (u) loadProfile(u.id)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) loadProfile(u.id)
      else setDisplayName(null)
    })

    return () => subscription.unsubscribe()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Close menu on navigation
  useEffect(() => { setMenuOpen(false) }, [pathname])

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/auth')
    router.refresh()
  }

  const offline = useOfflineMode()
  // Offline: hide destinations that need a connection (AI agent, community browse, full analytics).
  // Upload stays — it offers a manual, no-AI entry mode offline. Study/Library/Settings remain.
  // Practice is online-only too, but it's a Study sub-item now, so it's filtered via `studySubs`.
  const OFFLINE_HIDDEN = new Set(['/agents', '/browse', '/progress'])
  const navLinks = offline ? NAV_LINKS.filter(l => !OFFLINE_HIDDEN.has(l.href)) : NAV_LINKS
  const studySubs = offline ? [] : STUDY_SUBS

  return (
    <>
      {/* pt-[safe-area] keeps the Lexify row below the device status bar (Capacitor edge-to-edge). */}
      <nav className="sticky top-0 z-50 border-b border-line/5 bg-surface-deep/90 backdrop-blur pt-[env(safe-area-inset-top)]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center">

          {/* ── Desktop: brand · nav links · account, spread edge to edge ── */}
          <div className="hidden md:flex items-center justify-between w-full gap-2">
            <Link href="/study" className="whitespace-nowrap">
              <LexifyLogo />
            </Link>

            {navLinks.map(({ href, label }) => {
              if (href === '/study')    return <StudyMenu key={href} pathname={pathname} subs={studySubs} />
              if (href === '/progress') return <AnalyticsMenu key={href} pathname={pathname} />
              if (href === '/settings') return <SettingsMenu key={href} pathname={pathname} />
              const isActive = pathname === href
              const onClick = href === '/library' && pathname === '/library'
                ? () => window.dispatchEvent(new CustomEvent('lexify:library-reset'))
                : undefined
              return (
                <Link key={href} href={href} onClick={onClick} className={[
                  'px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-150 whitespace-nowrap',
                  isActive ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
                ].join(' ')}>
                  {label}
                </Link>
              )
            })}

            {user ? (
              <AvatarMenu
                user={user}
                displayName={displayName}
                avatarUrl={avatarUrl}
                onDisplayNameSaved={setDisplayName}
                onAvatarChange={setAvatarUrl}
                onSignOut={handleSignOut}
              />
            ) : (
              <Link href="/auth" className="btn-ghost text-sm py-1.5 px-3">Sign in</Link>
            )}
          </div>

          {/* ── Mobile: brand + hamburger ── */}
          <div className="flex md:hidden items-center justify-between w-full">
            <Link href="/study"><LexifyLogo markSize={24} /></Link>
            <button
              onClick={() => setMenuOpen(o => !o)}
              className="text-ink-muted hover:text-ink transition-colors p-1"
              aria-label="Toggle menu"
            >
              {menuOpen ? (
                // X icon
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : (
                // Hamburger icon
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="6"  x2="21" y2="6"  />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              )}
            </button>
          </div>

        </div>
      </nav>

      {/* Offline banner — sits under the Lexify row, scrolls with the page. */}
      {offline && (
        <div className="z-40 bg-amber-500/90 text-black text-xs font-medium text-center py-1.5 px-3 flex items-center justify-center gap-3">
          <span>● Offline mode — studying from your downloaded cards. Reviews sync when you go back online.</span>
          <button onClick={() => setOfflineMode(false)} className="underline underline-offset-2 hover:no-underline shrink-0">Go online</button>
        </div>
      )}

      {/* ── Mobile drawer ── */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex flex-col" onClick={() => setMenuOpen(false)}>
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50" />

          {/* Drawer panel */}
          <div
            className="relative mt-[calc(env(safe-area-inset-top)+3.5rem)] bg-surface-deep border-b border-line/5 px-4 py-3 space-y-1"
            onClick={e => e.stopPropagation()}
          >
            {navLinks.map(({ href, label }) => {
              if (href === '/study') return (
                <div key={href} className="space-y-1">
                  <Link href="/study" className={[
                    'block px-3 py-2.5 rounded-md text-sm font-medium transition-colors',
                    pathname === '/study' ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
                  ].join(' ')}>Study</Link>
                  {studySubs.map(sub => (
                    <Link key={sub.href} href={sub.href} className={[
                      'block px-5 py-2 rounded-md text-sm font-medium transition-colors',
                      pathname === sub.href ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
                    ].join(' ')}>{sub.label}</Link>
                  ))}
                </div>
              )
              if (href === '/progress') return (
                <div key={href} className="space-y-1">
                  <Link href="/progress" className={[
                    'block px-3 py-2.5 rounded-md text-sm font-medium transition-colors',
                    pathname === '/progress' ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
                  ].join(' ')}>Analytics</Link>
                  {ANALYTICS_SUBS.map(s => (
                    <Link key={s.href} href={s.href} className={[
                      'block px-5 py-2 rounded-md text-sm font-medium transition-colors',
                      pathname === s.href ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
                    ].join(' ')}>{s.label}</Link>
                  ))}
                </div>
              )
              if (href === '/settings') return (
                <div key={href} className="space-y-1">
                  <Link href="/settings" className={[
                    'block px-3 py-2.5 rounded-md text-sm font-medium transition-colors',
                    pathname === '/settings' ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
                  ].join(' ')}>Settings</Link>
                  {SETTINGS_SUBS.map(s => (
                    <Link key={s.href} href={s.href} className={[
                      'block px-5 py-2 rounded-md text-sm font-medium transition-colors',
                      pathname === s.href ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
                    ].join(' ')}>{s.label}</Link>
                  ))}
                </div>
              )
              const isActive = pathname === href
              const onClick = href === '/library' && pathname === '/library'
                ? () => window.dispatchEvent(new CustomEvent('lexify:library-reset'))
                : undefined
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={onClick}
                  className={[
                    'block px-3 py-2.5 rounded-md text-sm font-medium transition-colors',
                    isActive ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
                  ].join(' ')}
                >
                  {label}
                </Link>
              )
            })}

            <div className="pt-3 border-t border-line/5 mt-2 px-3 pb-1">
              {user ? (
                <ProfilePanel
                  user={user}
                  displayName={displayName}
                  avatarUrl={avatarUrl}
                  onSaved={setDisplayName}
                  onAvatarChange={setAvatarUrl}
                  onSignOut={handleSignOut}
                />
              ) : (
                <Link href="/auth" className="block px-3 py-2.5 text-sm font-medium text-ink-muted hover:text-ink transition-colors">
                  Sign in
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// "Study" itself links to the dashboard; Practice hangs under it (drilling your own vocabulary is a
// mode of studying, not a separate destination). Offline the list is emptied — Practice needs AI.
const STUDY_SUBS = [
  { href: '/practice', label: 'Practice' },
]

/** Desktop nav "Study" item — a hover dropdown to its sub-pages. */
function StudyMenu({ pathname, subs }: { pathname: string; subs: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false)
  // The parent lights up for its children too, so being in Practice still shows where you are.
  const active = pathname === '/study' || subs.some(s => pathname.startsWith(s.href))
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <Link href="/study" className={[
        'px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-150 whitespace-nowrap inline-flex items-center gap-1',
        active ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
      ].join(' ')}>Study</Link>
      {open && subs.length > 0 && (
        <div className="absolute top-full left-0 pt-1 z-50">
          <div className="bg-surface-deep border border-line/10 rounded-lg py-1 min-w-[150px] shadow-lg">
            {subs.map(s => (
              <Link key={s.href} href={s.href} className={`block px-3 py-1.5 text-sm ${pathname === s.href ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50'}`}>{s.label}</Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// "Analytics" itself links to the Overview (/progress); only these sub-pages appear on hover / in the drawer.
const ANALYTICS_SUBS = [
  { href: '/progress/connections', label: 'Connections' },
  { href: '/progress/logs',        label: 'Logs'        },
]

/** Desktop nav "Analytics" item — a hover dropdown to its sub-pages. */
function AnalyticsMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false)
  const active = pathname.startsWith('/progress')
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <Link href="/progress" className={[
        'px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-150 whitespace-nowrap inline-flex items-center gap-1',
        active ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
      ].join(' ')}>Analytics</Link>
      {open && (
        <div className="absolute top-full left-0 pt-1 z-50">
          <div className="bg-surface-deep border border-line/10 rounded-lg py-1 min-w-[150px] shadow-lg">
            {ANALYTICS_SUBS.map(s => (
              <Link key={s.href} href={s.href} className={`block px-3 py-1.5 text-sm ${pathname === s.href ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50'}`}>{s.label}</Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// "Settings" itself links to the general settings; hovering reveals the language-configuration sub-page.
const SETTINGS_SUBS = [
  { href: '/settings/language', label: 'Language configuration' },
]

/** Desktop nav "Settings" item — a hover dropdown to its sub-pages. */
function SettingsMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false)
  const active = pathname.startsWith('/settings')
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <Link href="/settings" className={[
        'px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-150 whitespace-nowrap inline-flex items-center gap-1',
        active ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
      ].join(' ')}>Settings</Link>
      {open && (
        <div className="absolute top-full left-0 pt-1 z-50">
          <div className="bg-surface-deep border border-line/10 rounded-lg py-1 min-w-[170px] shadow-lg">
            {SETTINGS_SUBS.map(s => (
              <Link key={s.href} href={s.href} className={`block px-3 py-1.5 text-sm ${pathname === s.href ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50'}`}>{s.label}</Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
