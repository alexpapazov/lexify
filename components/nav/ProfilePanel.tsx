'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { User } from '@supabase/supabase-js'
import { Avatar } from './Avatar'

/** The account panel that used to be the /profile page: identity, editable display
 *  name, and sign-out. Shared by the desktop avatar dropdown and the mobile drawer. */
export function ProfilePanel({
  user,
  displayName,
  onSaved,
  onSignOut,
}: {
  user: User
  displayName: string | null
  onSaved: (name: string | null) => void
  onSignOut: () => void
}) {
  const [name,   setName]   = useState(displayName ?? '')
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const supabase = createClient()

  async function save() {
    const next = name.trim() || null
    setSaving(true)
    await supabase.from('profiles').update({ display_name: next }).eq('user_id', user.id)
    setSaving(false)
    setSaved(true)
    onSaved(next)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Identity */}
      <div className="flex items-center gap-3">
        <Avatar name={displayName} email={user.email ?? ''} size={40} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink truncate">{displayName || 'Your account'}</div>
          <div className="text-xs text-ink-muted truncate">{user.email}</div>
        </div>
      </div>

      {/* Editable display name */}
      <div className="space-y-1.5">
        <label className="text-xs text-ink-muted">Display name</label>
        <div className="flex gap-2">
          <input
            className="input flex-1 text-sm py-1.5"
            placeholder="Your name"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }}
          />
          <button className="btn-ghost text-sm py-1.5 px-3 whitespace-nowrap" disabled={saving} onClick={save}>
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>

      <button
        onClick={onSignOut}
        className="btn-ghost text-sm py-2 w-full mt-1 border-t border-white/5 rounded-none pt-3 text-ink-muted hover:text-ink"
      >
        Sign out
      </button>
    </div>
  )
}
