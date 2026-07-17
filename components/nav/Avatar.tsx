'use client'

/** Circular identity avatar. Renders the user's initials on a deterministic color
 *  derived from their email, so the same account always gets the same swatch.
 *  (No uploaded-image support yet — this is the placeholder "profile picture".) */

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
  size = 32,
}: {
  name?: string | null
  email: string
  size?: number
}) {
  const h = hue(email || name || 'lexify')
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        backgroundColor: `hsl(${h} 42% 42%)`,
        fontSize: Math.round(size * 0.4),
      }}
      className="rounded-full flex items-center justify-center text-white font-semibold select-none shrink-0 leading-none"
    >
      {initials(name, email)}
    </div>
  )
}
