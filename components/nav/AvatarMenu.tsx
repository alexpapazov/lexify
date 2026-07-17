'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { Avatar } from './Avatar'
import { ProfilePanel } from './ProfilePanel'

/** Desktop account control: a circular avatar button that opens a dropdown with the
 *  account panel (identity, display-name editing, sign out). */
export function AvatarMenu({
  user,
  displayName,
  avatarUrl,
  onDisplayNameSaved,
  onAvatarChange,
  onSignOut,
}: {
  user: User
  displayName: string | null
  avatarUrl: string | null
  onDisplayNameSaved: (name: string | null) => void
  onAvatarChange: (url: string | null) => void
  onSignOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  // Close on navigation.
  useEffect(() => { setOpen(false) }, [pathname])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Account menu"
        aria-expanded={open}
        className="rounded-full transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-surface-deep"
      >
        <Avatar name={displayName} email={user.email ?? ''} src={avatarUrl} size={32} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-card border border-line/10 bg-surface-raised shadow-xl p-4 z-50">
          <ProfilePanel
            user={user}
            displayName={displayName}
            avatarUrl={avatarUrl}
            onSaved={onDisplayNameSaved}
            onAvatarChange={onAvatarChange}
            onSignOut={onSignOut}
          />
        </div>
      )}
    </div>
  )
}
