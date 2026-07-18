'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

// Routes reachable while signed out. Everything else is personalized → gated.
const PUBLIC_PREFIXES = ['/auth']

/** Wraps the app content: signed-out users on a personalized route see a friendly
 *  "sign in to continue" screen instead of an empty/broken page. */
export function AuthWall({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isPublic = PUBLIC_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))
  const [status, setStatus] = useState<'loading' | 'authed' | 'anon'>('loading')

  useEffect(() => {
    const supabase = createClient()
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (active) setStatus(data.session ? 'authed' : 'anon')
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (active) setStatus(session ? 'authed' : 'anon')
    })
    return () => { active = false; subscription.unsubscribe() }
  }, [])

  if (isPublic) return <>{children}</>
  if (status === 'loading') {
    return <div className="pt-24 text-center text-ink-faint text-sm">Loading…</div>
  }
  if (status === 'anon') return <AuthGate />
  return <>{children}</>
}

function AuthGate() {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="panel w-full max-w-md text-center space-y-6 py-10">
        <div className="text-5xl" aria-hidden>📚</div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-ink">Sign in to continue</h1>
          <p className="text-ink-muted text-sm leading-relaxed max-w-xs mx-auto">
            Lexify is personalized to your decks, progress, and review schedule.
            Sign in or create a free account to keep going.
          </p>
        </div>
        <div className="flex flex-col gap-2 pt-1">
          <Link href="/auth" className="btn-primary w-full">Sign in</Link>
          <Link href="/auth?mode=signup" className="btn-ghost w-full">Create an account</Link>
        </div>
      </div>
    </div>
  )
}
