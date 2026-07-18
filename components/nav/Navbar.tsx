'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { User } from '@supabase/supabase-js'
import { AvatarMenu } from './AvatarMenu'
import { ProfilePanel } from './ProfilePanel'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { setOfflineMode } from '@/lib/offline/mode'

const NAV_LINKS = [
  { href: '/study',     label: 'Study'    },
  { href: '/library',   label: 'Library'  },
  { href: '/browse',    label: 'Browse'   },
  { href: '/upload',    label: 'Upload'   },
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
    const { data } = await supabase.from('profiles').select('display_name, avatar_url').eq('user_id', uid).single()
    setDisplayName(data?.display_name ?? null)
    setAvatarUrl(data?.avatar_url ?? null)
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
  // Offline: hide the AI-only destinations (agent card-making, upload/AI card gen).
  const OFFLINE_HIDDEN = new Set(['/agents', '/upload'])
  const navLinks = offline ? NAV_LINKS.filter(l => !OFFLINE_HIDDEN.has(l.href)) : NAV_LINKS

  return (
    <>
      {offline && (
        <div className="z-[60] bg-amber-500/90 text-black text-xs font-medium text-center py-1 px-3 flex items-center justify-center gap-3">
          <span>● Offline mode — studying from your downloaded cards. Reviews sync when you go back online.</span>
          <button onClick={() => setOfflineMode(false)} className="underline underline-offset-2 hover:no-underline shrink-0">Go online</button>
        </div>
      )}
      <nav className="sticky top-0 z-50 border-b border-line/5 bg-surface-deep/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center">

          {/* ── Desktop: brand · nav links · account, spread edge to edge ── */}
          <div className="hidden md:flex items-center justify-between w-full gap-2">
            <Link href="/study" className="text-ink font-semibold tracking-wide whitespace-nowrap">
              Lexify
            </Link>

            {navLinks.map(({ href, label }) => {
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
            <Link href="/study" className="text-ink font-semibold tracking-wide">Lexify</Link>
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

      {/* ── Mobile drawer ── */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex flex-col" onClick={() => setMenuOpen(false)}>
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50" />

          {/* Drawer panel */}
          <div
            className="relative mt-14 bg-surface-deep border-b border-line/5 px-4 py-3 space-y-1"
            onClick={e => e.stopPropagation()}
          >
            {navLinks.map(({ href, label }) => {
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
