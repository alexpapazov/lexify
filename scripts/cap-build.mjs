/*
 * Builds the fully-static web bundle for the native (Capacitor) app into `out/`.
 *
 * `output: export` can't include server-only routes, so we temporarily move them aside for the build
 * and restore them after (the normal Vercel deploy keeps them). The native app calls those API routes
 * over the network at the deployed origin (see lib/apiBase.ts + NEXT_PUBLIC_API_ORIGIN).
 *
 * Run: `npm run build:cap`
 */
import { rename, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stash = join(root, '.cap-stash')

// Routes that can't be statically exported → move out during the export build, restore after.
const MOVES = [
  ['app/api', 'api'],
  ['app/manifest.ts', 'manifest.ts'],
]

async function moveOut() {
  await mkdir(stash, { recursive: true })
  for (const [rel, name] of MOVES) {
    const src = join(root, rel)
    if (existsSync(src)) await rename(src, join(stash, name))
  }
}
async function restore() {
  for (const [rel, name] of MOVES) {
    const src = join(stash, name)
    if (existsSync(src)) await rename(src, join(root, rel))
  }
  await rm(stash, { recursive: true, force: true })
}

// The native bundle has no server of its own, so /api/* must hit the deployed origin. Override with
// NEXT_PUBLIC_API_ORIGIN if you deploy elsewhere.
const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'https://lexify-flax.vercel.app'

let failed = false
try {
  await moveOut()
  execSync('npx --no-install next build', {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, CAPACITOR_BUILD: '1', NEXT_PUBLIC_API_ORIGIN: API_ORIGIN },
  })
} catch {
  failed = true
} finally {
  await restore()
}
process.exit(failed ? 1 : 0)
