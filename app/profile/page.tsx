'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { User } from '@supabase/supabase-js'

export default function ProfilePage() {
  const [user,         setUser]         = useState<User | null>(null)
  const [displayName,  setDisplayName]  = useState('')
  const [saved,        setSaved]        = useState(false)
  const [loading,      setLoading]      = useState(true)
  const router  = useRouter()
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const u = data.session?.user ?? null
      if (!u) { router.push('/auth'); return }
      setUser(u)

      // Load profile display name
      const { data: profile } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('user_id', u.id)
        .single()

      setDisplayName(profile?.display_name ?? '')
      setLoading(false)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!user) return
    await supabase.from('profiles').update({ display_name: displayName }).eq('user_id', user.id)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (loading) {
    return <div className="text-ink-muted pt-16 text-center">Loading…</div>
  }

  return (
    <div className="space-y-8 max-w-lg mx-auto">
      <h1 className="text-2xl font-semibold text-ink">Profile</h1>

      <div className="panel space-y-4">
        <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Account</h2>

        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Email</label>
          <div className="input opacity-60 cursor-not-allowed">{user?.email}</div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm text-ink-muted">Display name</label>
          <input
            className="input"
            placeholder="Your name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
          />
        </div>
      </div>

      <button className="btn-primary" onClick={handleSave}>
        {saved ? 'Saved ✓' : 'Save profile'}
      </button>
    </div>
  )
}
