'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { User } from '@supabase/supabase-js'

const NAV_LINKS = [
  { href: '/',         label: 'Home'     },
  { href: '/study',    label: 'Study'    },
  { href: '/library',  label: 'Library'  },
  { href: '/browse',   label: 'Browse'   },
  { href: '/upload',   label: 'Upload'   },
  { href: '/profile',  label: 'Profile'  },
  { href: '/settings', label: 'Settings' },
]

export function Navbar() {
  const pathname = usePathname()
  const router   = useRouter()
  const supabase = createClient()
  const [user,        setUser]        = useState<User | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)

  async function loadProfile(uid: string) {
    const { data } = await supabase.from('profiles').select('display_name').eq('user_id', uid).single()
    setDisplayName(data?.display_name ?? null)
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

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/')
    router.refresh()
  }

  return (
    <nav className="sticky top-0 z-50 border-b border-white/5 bg-surface-deep/90 backdrop-blur">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-1 relative">
        <Link href="/" className="absolute right-full -translate-x-3 text-ink font-semibold tracking-wide whitespace-nowrap">Lexify</Link>

        {NAV_LINKS.map(({ href, label }) => {
          const isActive = pathname === href
          return (
            <Link key={href} href={href} className={[
              'px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-150',
              isActive ? 'text-ink bg-surface' : 'text-ink-muted hover:text-ink hover:bg-surface/50',
            ].join(' ')}>
              {label}
            </Link>
          )
        })}

        <div className="ml-auto flex items-center gap-3">
          {user ? (
            <>
              <span className="text-xs text-ink-muted hidden sm:block truncate max-w-[160px]">
                {displayName ?? user.email}
              </span>
              <button onClick={handleSignOut} className="btn-ghost text-sm py-1.5 px-3">
                Sign out
              </button>
            </>
          ) : (
            <Link href="/auth" className="btn-ghost text-sm py-1.5 px-3">Sign in</Link>
          )}
        </div>
      </div>
    </nav>
  )
}
