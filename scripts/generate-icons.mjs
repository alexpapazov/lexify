// Generates every app icon from the Lexify brand marks. Run: `node scripts/generate-icons.mjs`
//
// Source of truth is the vector art below, reconstructed exactly from the Figma Make brand system
// (Icon H "Source → Target" + the A1 language-character bubble). Edit it here and re-run to
// regenerate the PWA icons, the favicon, and the iOS app icon in one pass — no re-export needed.
//
// Writes:
//   brand/{app-icon,mark-bubble,logo}.svg                        (editable vector sources)
//   app/icon.svg                                                 (favicon)
//   public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png
//   ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png  (1024², opaque)
import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── Brand palette (from the Figma Make design system) ────────────────────────
const C = {
  primary:      '#4A48D8',
  primaryHover: '#8684F0',
  textPrimary:  '#E6E8F5',
  bgApp:        '#13141F',
}

// The 語 glyph needs a CJK serif. Georgia has no CJK coverage, so list explicit CJK families the
// renderer can actually fall back to — otherwise the character silently becomes a tofu box.
const SERIF = "Georgia, 'Times New Roman', 'Hiragino Mincho ProN', 'Songti SC', 'Yu Mincho', 'Noto Serif CJK JP', 'Noto Serif JP', serif"

/**
 * Icon H — "Source → Target": a tilted back card showing the source letter (A) peeking out behind a
 * front card carrying the target character (語), над two page dots.
 *
 * @param rx     corner radius in viewBox units. 46 = the designed rounded tile; 0 = full-bleed square
 *               (required for iOS / apple-touch, which apply their own corner mask — baking ours in
 *               would double-round and leave dark wedges in the corners).
 * @param inset  fraction to shrink the ART by (background stays full-bleed). Used for the Android
 *               "maskable" icon, where a circular mask would otherwise clip the card corners.
 */
function appIconSvg({ rx = 46, inset = 0 } = {}) {
  const s = 1 - inset * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" fill="none">
  <defs>
    <linearGradient id="h-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#191B2E"/><stop offset="100%" stop-color="#0D0E18"/>
    </linearGradient>
    <linearGradient id="h-front" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="#6560EA"/><stop offset="100%" stop-color="#3A38C8"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" rx="${rx}" fill="url(#h-bg)"/>
  <g transform="translate(100,100) scale(${s}) translate(-100,-100)">
    <g transform="rotate(9 100 92)">
      <rect x="40" y="50" width="120" height="84" rx="11" fill="#3230B0"/>
      <text x="100" y="105" text-anchor="middle" font-size="38" fill="#ffffff" fill-opacity="0.4" font-family="${SERIF}">A</text>
    </g>
    <rect x="40" y="50" width="120" height="84" rx="11" fill="url(#h-front)"/>
    <text x="100" y="109" text-anchor="middle" font-size="54" fill="#ffffff" fill-opacity="0.95" font-family="${SERIF}">語</text>
    <circle cx="93" cy="154" r="5" fill="${C.primary}"/>
    <circle cx="107" cy="154" r="5" fill="#ffffff" fill-opacity="0.18"/>
  </g>
</svg>`
}

/** A1 — the language-character bubble mark (speech bubble containing 語), on its own. */
function bubbleMarkSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52" fill="none">
  <rect x="2" y="2" width="46" height="36" rx="10" fill="${C.primary}"/>
  <polygon points="9,38 2,50 22,38" fill="${C.primary}"/>
  <text x="25" y="28" text-anchor="middle" font-size="20" fill="#ffffff" font-family="${SERIF}">語</text>
</svg>`
}

/** Full lockup: the bubble mark + the "Lexi/fy" logotype (fy in the lighter indigo). */
function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="236" height="56" viewBox="0 0 236 56" fill="none">
  <g transform="translate(0,3)">
    <rect x="2" y="2" width="46" height="36" rx="10" fill="${C.primary}"/>
    <polygon points="9,38 2,50 22,38" fill="${C.primary}"/>
    <text x="25" y="28" text-anchor="middle" font-size="20" fill="#ffffff" font-family="${SERIF}">語</text>
  </g>
  <text x="62" y="37" font-size="32" font-weight="700" letter-spacing="-0.8"
        font-family="Inter, system-ui, -apple-system, sans-serif" fill="${C.textPrimary}">Lexi<tspan fill="${C.primaryHover}">fy</tspan></text>
</svg>`
}

const png = async (svg, size, { opaque = false } = {}) => {
  let p = sharp(Buffer.from(svg)).resize(size, size)
  if (opaque) p = p.flatten({ background: C.bgApp })   // iOS rejects app icons with an alpha channel
  return p.png().toBuffer()
}

await mkdir(join(root, 'brand'), { recursive: true })
await mkdir(join(root, 'public', 'icons'), { recursive: true })

// Editable vector sources
await writeFile(join(root, 'brand', 'app-icon.svg'), appIconSvg())
await writeFile(join(root, 'brand', 'mark-bubble.svg'), bubbleMarkSvg())
await writeFile(join(root, 'brand', 'logo.svg'), logoSvg())

// Favicon — the rounded tile, same identity as the installed app.
await writeFile(join(root, 'app', 'icon.svg'), appIconSvg())

// PWA "any" icons keep the designed rounded tile.
await writeFile(join(root, 'public/icons/icon-192.png'), await png(appIconSvg(), 192))
await writeFile(join(root, 'public/icons/icon-512.png'), await png(appIconSvg(), 512))
// Maskable: full-bleed square + art pulled in, so a circular mask can't clip the cards.
await writeFile(join(root, 'public/icons/icon-maskable-512.png'), await png(appIconSvg({ rx: 0, inset: 0.10 }), 512))
// Apple touch icon + iOS app icon: square and opaque; iOS applies its own corner mask.
await writeFile(join(root, 'public/icons/apple-touch-icon.png'), await png(appIconSvg({ rx: 0 }), 180, { opaque: true }))
await writeFile(
  join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'),
  await png(appIconSvg({ rx: 0 }), 1024, { opaque: true }),
)

console.log('✓ brand/{app-icon,mark-bubble,logo}.svg')
console.log('✓ app/icon.svg')
console.log('✓ public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png')
console.log('✓ ios AppIcon-512@2x.png (1024², opaque)')
