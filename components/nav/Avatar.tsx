'use client'

import { useEffect, useState } from 'react'

/** Circular identity avatar. Shows the uploaded profile picture when `src` is set,
 *  otherwise the user's initials on a deterministic color derived from their email
 *  (so the same account always gets the same swatch). */

function initials(name: string | null | undefined, email: string): string {
  const src = (name && name.trim()) || email || ''
  if (!src) return '?'
  const parts = src.trim().split(/[\s._@-]+/).filter(Boolean)
  if (parts.length >= 2 && parts[0] && parts[1]) return (parts[0][0]! + parts[1][0]!).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

function hue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360
  return h
}

export function Avatar({
  name,
  email,
  src,
  size = 32,
}: {
  name?: string | null
  email: string
  src?: string | null
  size?: number
}) {
  const [broken, setBroken] = useState(false)
  // Reset the error state when the source changes (e.g. after a new upload).
  useEffect(() => { setBroken(false) }, [src])

  const dimensions = { width: size, height: size }

  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        style={dimensions}
        onError={() => setBroken(true)}
        className="rounded-full object-cover shrink-0 bg-surface"
      />
    )
  }

  const h = hue(email || name || 'lexify')
  return (
    <div
      aria-hidden
      style={{ ...dimensions, backgroundColor: `hsl(${h} 42% 42%)`, fontSize: Math.round(size * 0.4) }}
      className="rounded-full flex items-center justify-center text-white font-semibold select-none shrink-0 leading-none"
    >
      {initials(name, email)}
    </div>
  )
}
