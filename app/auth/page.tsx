'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Mode = 'signin' | 'signup'

export default function AuthPage() {
  const [mode,     setMode]     = useState<Mode>('signin')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [name,     setName]     = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [signupDone, setSignupDone] = useState(false)

  const router   = useRouter()
  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email, password,
          options: { data: { display_name: name } },
        })
        if (error) throw error
        setSignupDone(true)
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        // Redirect to study dashboard after successful sign-in
        router.push('/study')
        router.refresh() // forces server components to re-render with new session
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  if (signupDone) {
    return (
      <div className="max-w-sm mx-auto pt-20 text-center space-y-4">
        <div className="text-4xl">✉️</div>
        <h2 className="text-xl font-semibold text-ink">Check your email!</h2>
        <p className="text-ink-muted text-sm">
          Click the confirmation link in your inbox, then come back and sign in.
        </p>
        <button onClick={() => { setSignupDone(false); setMode('signin') }} className="btn-ghost text-sm">
          Back to sign in
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-sm mx-auto pt-16 space-y-6">
      <div className="flex rounded-lg bg-surface p-1 gap-1">
        {(['signin', 'signup'] as Mode[]).map(m => (
          <button key={m} onClick={() => { setMode(m); setError(null) }}
            className={['flex-1 py-2 text-sm font-medium rounded-md transition-colors',
              mode === m ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'].join(' ')}>
            {m === 'signin' ? 'Sign in' : 'Sign up'}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="panel space-y-4">
        {mode === 'signup' && (
          <div className="space-y-1.5">
            <label className="text-sm text-ink-muted">Display name</label>
            <input className="input" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required />
          </div>
        )}
        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Email</label>
          <input type="email" className="input" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Password</label>
          <input type="password" className="input" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />
        </div>
        {error && <p className="text-danger text-sm">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? 'Loading…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>
    </div>
  )
}
