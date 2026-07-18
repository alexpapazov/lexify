'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Session } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'

// Routes reachable while signed out. Everything else is personalized → gated.
const PUBLIC_PREFIXES = ['/auth']

/** Wraps the app content:
 *  - signed-out users on a personalized route see a "sign in to continue" screen;
 *  - signed-in users who haven't finished first-run setup are sent to /onboarding. */
export function AuthWall({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const isPublic = PUBLIC_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))
  const onOnboarding = pathname === '/onboarding'

  const [status, setStatus] = useState<'loading' | 'anon' | 'authed'>('loading')
  const [needsOnboarding, setNeedsOnboarding] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    let active = true

    async function check(session: Session | null) {
      if (!session) { if (active) { setStatus('anon'); setNeedsOnboarding(false) } return }
      const { data } = await supabase.from('profiles')
        .select('onboarding_completed').eq('user_id', session.user.id).single()
      if (!active) return
      setNeedsOnboarding(data?.onboarding_completed === false)
      setStatus('authed')
    }

    supabase.auth.getSession().then(({ data }) => check(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => check(session))
    return () => { active = false; subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (status === 'authed' && needsOnboarding && !onOnboarding && !isPublic) {
      router.replace('/onboarding')
    }
  }, [status, needsOnboarding, onOnboarding, isPublic, router])

  if (isPublic) return <>{children}</>
  if (status === 'loading') return <Loader />
  if (status === 'anon') return <AuthGate />
  // authed
  if (onOnboarding) return <>{children}</>
  if (needsOnboarding) return <Loader />   // redirecting into setup
  return <>{children}</>
}

function Loader() {
  return <div className="pt-24 text-center text-ink-faint text-sm">Loading…</div>
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
