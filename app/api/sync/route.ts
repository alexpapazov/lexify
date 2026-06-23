/**
 * POST /api/sync
 *
 * Processes ONE batch of BATCH_SIZE cards per invocation, then self-chains
 * for the remaining cards. Each call completes in ~3-4 s (parallel Anthropic
 * calls for all destination languages) — safely under Vercel Hobby's 10 s limit.
 *
 * Flow:
 *   1. Respond immediately (< 1 ms).
 *   2. In after():
 *      a. Process cards[0..BATCH_SIZE] via processSyncBatch.
 *         → Translates to ALL destination languages at once (BFS through rules).
 *      b. If remaining + failed cards exist → trigger continuation (same payload).
 *
 * No cascade hops. All language levels are translated directly from the source
 * cards in each batch, keeping max concurrent invocations = 1 at a time.
 *
 * Auth:
 *   - Client calls:         Authorization: Bearer <supabase-jwt>
 *   - Server-to-server:     x-sync-secret: <SYNC_INTERNAL_SECRET env var>
 */

import { after }             from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  processSyncBatch,
  BATCH_SIZE,
  type SyncPayload,
} from '@/lib/syncProcessor'

export const runtime     = 'nodejs'
export const maxDuration = 10

const MAX_CARD_FAILS  = 10      // drop a card after this many total failures
const INTERNAL_SECRET = process.env.SYNC_INTERNAL_SECRET ?? 'dev-sync-secret'

function getOrigin(req: Request): string {
  const host  = req.headers.get('host') ?? 'localhost:3000'
  const proto = host.startsWith('localhost') ? 'http' : 'https'
  return `${proto}://${host}`
}

async function triggerContinuation(origin: string, payload: SyncPayload): Promise<void> {
  await fetch(`${origin}/api/sync`, {
    method:  'POST',
    headers: {
      'content-type':  'application/json',
      'x-sync-secret': INTERNAL_SECRET,
    },
    body: JSON.stringify(payload),
  }).catch(err => console.error('[sync] failed to trigger continuation', err))
}

export async function POST(req: Request) {
  let userId:  string
  let payload: SyncPayload

  const internalSecret = req.headers.get('x-sync-secret')

  if (internalSecret) {
    // ── Server-to-server continuation ────────────────────────────────────────
    if (internalSecret !== INTERNAL_SECRET) {
      return Response.json({ ok: false }, { status: 401 })
    }
    const body = await req.json()
    userId  = body.userId as string
    payload = body as SyncPayload
  } else {
    // ── Initial client call ───────────────────────────────────────────────────
    const authHeader = req.headers.get('authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      return Response.json({ ok: false }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user } } = await createAdminClient().auth.getUser(token)
    if (!user) {
      console.error('[sync] auth failed — invalid or expired JWT')
      return Response.json({ ok: false }, { status: 401 })
    }
    userId  = user.id
    const body = await req.json()
    payload = { ...body, userId, failCounts: {} } as SyncPayload
  }

  if (!payload.cards || payload.cards.length === 0) {
    return Response.json({ ok: true })
  }

  const origin = getOrigin(req)

  after(async () => {
    console.log('[sync] after() invoked', {
      userId:  payload.userId.slice(0, 8),
      cards:   payload.cards.length,
      src:     `${payload.sourceLanguage}:${payload.targetLanguage}`,
    })
    try {
      const { failedCards } = await processSyncBatch(payload)
      console.log('[sync] batch done', { failed: failedCards.length })

      // Update fail counts; drop cards that have failed too many times
      const failCounts: Record<string, number> = { ...(payload.failCounts ?? {}) }
      const retryable = failedCards.filter(c => {
        const count = (failCounts[c.id] ?? 0) + 1
        failCounts[c.id] = count
        return count < MAX_CARD_FAILS
      })

      const remaining = payload.cards.slice(BATCH_SIZE)
      const nextCards = [...remaining, ...retryable]
      if (nextCards.length > 0) {
        await triggerContinuation(origin, {
          userId:         payload.userId,
          sourceLanguage: payload.sourceLanguage,
          targetLanguage: payload.targetLanguage,
          cards:          nextCards,
          failCounts,
        })
      }
    } catch (err) {
      console.error('[sync] after() error:', err)
    }
  })

  return Response.json({ ok: true })
}
