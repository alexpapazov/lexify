/**
 * POST /api/sync
 *
 * Entry point for server-side language syncing.
 * Responds immediately (< 1ms), then runs the sync hop inside after() so it
 * continues on Vercel's servers even if the browser tab is closed or switched.
 *
 * Self-chaining: after processing one language hop, it POSTs to itself for
 * each cascade destination. Each invocation is independent — no single call
 * needs to hold open for the full chain.
 *
 * Auth:
 *   - Client calls:         Authorization: Bearer <supabase-jwt>
 *   - Server-to-server:     x-sync-secret: <SYNC_INTERNAL_SECRET env var>
 *
 * Required env vars (add in Vercel dashboard):
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service role key (Settings → API)
 *   SYNC_INTERNAL_SECRET       — Any random string, used for server-to-server auth
 */

import { after }            from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processSyncHop }   from '@/lib/syncProcessor'
import type { NextHop }     from '@/lib/syncProcessor'

export const runtime    = 'nodejs'
export const maxDuration = 60  // seconds — enough for one language hop

const CHAIN_DELAY_MS     = 8_000  // pause between cascade hops (rate-limit breathing room)
const INTERNAL_SECRET    = process.env.SYNC_INTERNAL_SECRET ?? 'dev-sync-secret'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function getOrigin(req: Request): string {
  const host = req.headers.get('host') ?? 'localhost:3000'
  const proto = host.startsWith('localhost') ? 'http' : 'https'
  return `${proto}://${host}`
}

async function triggerHop(origin: string, hop: NextHop): Promise<void> {
  await fetch(`${origin}/api/sync`, {
    method:  'POST',
    headers: {
      'content-type':  'application/json',
      'x-sync-secret': INTERNAL_SECRET,
    },
    body: JSON.stringify(hop),
  }).catch(err => console.error('sync: failed to trigger next hop', err))
}

export async function POST(req: Request) {
  let userId:   string
  let payload:  Omit<NextHop, 'userId'> & { userId?: string }

  const internalSecret = req.headers.get('x-sync-secret')

  if (internalSecret) {
    // ── Server-to-server hop ────────────────────────────────────────────────
    if (internalSecret !== INTERNAL_SECRET) {
      return Response.json({ ok: false }, { status: 401 })
    }
    const body = await req.json()
    userId  = body.userId
    payload = body
  } else {
    // ── Initial client call ─────────────────────────────────────────────────
    const authHeader = req.headers.get('authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      return Response.json({ ok: false }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user } } = await createAdminClient().auth.getUser(token)
    if (!user) return Response.json({ ok: false }, { status: 401 })
    userId  = user.id
    const body = await req.json()
    payload = { ...body, visited: [] }
  }

  const origin = getOrigin(req)

  // Respond immediately — the actual work runs after the response is sent
  after(async () => {
    try {
      const { nextHops } = await processSyncHop(
        userId,
        payload.sourceLanguage,
        payload.targetLanguage,
        payload.cards,
        payload.visited ?? [],
      )

      // Trigger each cascade hop as a fresh independent server invocation
      for (const hop of nextHops) {
        await sleep(CHAIN_DELAY_MS)
        await triggerHop(origin, hop)
      }
    } catch (err) {
      console.error('sync after() error:', err)
    }
  })

  return Response.json({ ok: true })
}
