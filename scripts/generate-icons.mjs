// One-off: generate PWA PNG icons from an inline SVG. Run: `node scripts/generate-icons.mjs`
// Requires `sharp` (already a transitive dep). Writes into public/icons/.
import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')

// A ladder ("climb") mark in white on the Lexify indigo. `pad` insets the art for maskable icons.
function svg({ size = 512, rounded = true, pad = 0 } = {}) {
  const s = size
  const r = rounded ? Math.round(s * 0.22) : 0
  // Ladder geometry within the padded content box.
  const box = s * (1 - pad * 2)
  const ox = s * pad
  const oy = s * pad
  const railW = box * 0.11
  const railGap = box * 0.34            // distance between the two rails' inner edges
  const cx = ox + box / 2
  const leftRailX = cx - railGap / 2 - railW
  const rightRailX = cx + railGap / 2
  const railTop = oy + box * 0.16
  const railH = box * 0.68
  const rungH = box * 0.085
  const rungs = [0.28, 0.5, 0.72].map(t => oy + box * t - rungH / 2)
  const rungX = leftRailX
  const rungW = (rightRailX + railW) - leftRailX
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#5A5BE6"/><stop offset="1" stop-color="#3432B0"/>
  </linearGradient></defs>
  <rect width="${s}" height="${s}" rx="${r}" fill="url(#g)"/>
  <g fill="#ffffff">
    <rect x="${leftRailX}" y="${railTop}" width="${railW}" height="${railH}" rx="${railW / 2}"/>
    <rect x="${rightRailX}" y="${railTop}" width="${railW}" height="${railH}" rx="${railW / 2}"/>
    ${rungs.map(y => `<rect x="${rungX}" y="${y}" width="${rungW}" height="${rungH}" rx="${rungH / 2}"/>`).join('\n    ')}
  </g>
</svg>`
}

async function png(name, opts) {
  const buf = Buffer.from(svg(opts))
  await sharp(buf).png().toFile(join(outDir, name))
  console.log('wrote', name)
}

await mkdir(outDir, { recursive: true })
await png('icon-192.png', { size: 192 })
await png('icon-512.png', { size: 512 })
await png('icon-maskable-512.png', { size: 512, rounded: false, pad: 0.12 })
await png('apple-touch-icon.png', { size: 180, rounded: false }) // iOS masks its own corners
await writeFile(join(root, 'app', 'icon.svg'), svg({ size: 512 }))
console.log('done')
