'use client'

import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { User } from '@supabase/supabase-js'
import { Avatar } from './Avatar'

const AVATAR_BUCKET = 'avatars'
const MAX_AVATAR_BYTES = 5 * 1024 * 1024 // 5 MB

/** The account panel that used to be the /profile page: identity, profile picture
 *  upload, editable display name, and sign-out. Shared by the desktop avatar
 *  dropdown and the mobile drawer. */
export function ProfilePanel({
  user,
  displayName,
  avatarUrl,
  onSaved,
  onAvatarChange,
  onSignOut,
}: {
  user: User
  displayName: string | null
  avatarUrl: string | null
  onSaved: (name: string | null) => void
  onAvatarChange: (url: string | null) => void
  onSignOut: () => void
}) {
  const [name,      setName]      = useState(displayName ?? '')
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
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

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    setError(null)

    if (!file.type.startsWith('image/')) { setError('Please choose an image file.'); return }
    if (file.size > MAX_AVATAR_BYTES)    { setError('Image must be under 5 MB.');    return }

    setUploading(true)
    try {
      const path = `${user.id}/avatar`
      const { error: upErr } = await supabase.storage
        .from(AVATAR_BUCKET)
        .upload(path, file, { upsert: true, contentType: file.type, cacheControl: '3600' })
      if (upErr) throw upErr

      const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path)
      // Stable path → cache-bust so the new image shows immediately.
      const url = `${data.publicUrl}?v=${Date.now()}`
      await supabase.from('profiles').update({ avatar_url: url }).eq('user_id', user.id)
      onAvatarChange(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  async function removePhoto() {
    setError(null)
    setUploading(true)
    try {
      await supabase.storage.from(AVATAR_BUCKET).remove([`${user.id}/avatar`])
      await supabase.from('profiles').update({ avatar_url: null }).eq('user_id', user.id)
      onAvatarChange(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove photo.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Identity + photo controls */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          aria-label="Change profile picture"
          className="relative rounded-full group focus:outline-none focus:ring-2 focus:ring-accent/50 disabled:opacity-60"
        >
          <Avatar name={displayName} email={user.email ?? ''} src={avatarUrl} size={44} />
          <span className="absolute inset-0 rounded-full bg-black/45 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-[10px] font-medium text-white">
            {uploading ? '…' : 'Edit'}
          </span>
        </button>
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink truncate">{displayName || 'Your account'}</div>
          <div className="text-xs text-ink-muted truncate">{user.email}</div>
          <div className="flex gap-3 mt-0.5 text-xs">
            <button className="text-accent hover:underline disabled:opacity-50" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {avatarUrl ? 'Change photo' : 'Add photo'}
            </button>
            {avatarUrl && (
              <button className="text-ink-faint hover:text-ink disabled:opacity-50" disabled={uploading} onClick={removePhoto}>
                Remove
              </button>
            )}
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

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
