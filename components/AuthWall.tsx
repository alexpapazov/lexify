'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Session } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { cachedRead, invalidateReads } from '@/lib/readCache'

/**
 * Per-user "finished onboarding" memo. The flag is one-way, so a cached `true` can never go stale;
 * we deliberately never cache `false` (a user mid-setup must keep being redirected).
 * localStorage access is wrapped — it throws in some privacy modes.
 */
const ONBOARDED_KEY = (uid: string) => `lexify-onboarded:${uid}`
function readOnboarded(uid: string): boolean {
  try { return localStorage.getItem(ONBOARDED_KEY(uid)) === '1' } catch { return false }
}
function writeOnboarded(uid: string): void {
  try { localStorage.setItem(ONBOARDED_KEY(uid), '1') } catch { /* private mode — just re-query */ }
}

/**
 * Call the moment onboarding is persisted. Without this the gate would keep serving its cached
 * "not onboarded" answer (60s TTL) and bounce the user straight back into setup after they finish.
 */
export function markOnboardingComplete(uid: string): void {
  writeOnboarded(uid)
  invalidateReads(`authwall:onboarded:${uid}`)
}

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
      const uid = session.user.id

      // `onboarding_completed` is a ONE-WAY flag — once finished it can never revert — so cache it
      // per user and skip the query entirely on every later load. This used to be a SECOND blocking
      // round trip (after getSession's, which itself may refresh an expired token), gating the whole
      // app behind it on every single page load.
      if (readOnboarded(uid)) {
        if (active) { setNeedsOnboarding(false); setStatus('authed') }
        return
      }

      try {
        // cachedRead de-dupes the in-flight duplicate: onAuthStateChange fires INITIAL_SESSION on
        // subscribe, so check() runs twice on mount and both would otherwise query.
        const completed = await cachedRead(`authwall:onboarded:${uid}`, async () => {
          // maybeSingle, not single: a user with no profiles row yet is normal and must not error.
          const { data } = await supabase.from('profiles')
            .select('onboarding_completed').eq('user_id', uid).maybeSingle()
          return data?.onboarding_completed !== false   // absent/unknown → treat as done, never trap
        })
        if (!active) return
        if (completed) writeOnboarded(uid)
        setNeedsOnboarding(!completed)
      } catch {
        // A failed onboarding lookup must not strand the user on the loader forever — that was the
        // "stuck on Loading…" bug: this promise had no catch, so a rejection meant setStatus never
        // ran and the gate never resolved. Assume onboarded and let them in.
        if (active) setNeedsOnboarding(false)
      }
      if (active) setStatus('authed')
    }

    supabase.auth.getSession()
      .then(({ data }) => check(data.session))
      // getSession rejecting (rather than returning a null session) also used to hang the gate.
      // Treat it as signed-out: the sign-in screen is recoverable, an endless loader is not.
      .catch(() => { if (active) setStatus('anon') })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => { void check(session) })
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
