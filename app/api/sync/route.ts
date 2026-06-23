/**
 * POST /api/sync
 *
 * Processes ONE batch of BATCH_SIZE cards per invocation, then self-chains.
 * Each call completes in ~3-4 s — safely under Vercel Hobby's 10-second limit.
 *
 * Flow:
 *   1. Respond immediately (< 1 ms).
 *   2. In after():
 *      a. Process cards[0..BATCH_SIZE] via processSyncBatch.
 *      b. If remaining + failed cards exist → trigger same-language continuation (no delay).
 *      c. For each cascade hop → trigger new language hop (CHAIN_DELAY_MS delay beforehand).
 *
 * A cascade hop receives isChainHop=true and sleeps CHAIN_DELAY_MS at the
 * start of its after() block, keeping total per-invocation time under 10 s.
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
  type NextHop,
} from '@/lib/syncProcessor'

export const runtime     = 'nodejs'
export const maxDuration = 10

const CHAIN_DELAY_MS  = 5_000   // pause before cascading to a new language
const MAX_CARD_FAILS  = 10      // drop a card after this many total failures
const INTERNAL_SECRET = process.env.SYNC_INTERNAL_SECRET ?? 'dev-sync-secret'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function getOrigin(req: Request): string {
  const host  = req.headers.get('host') ?? 'localhost:3000'
  const proto = host.startsWith('localhost') ? 'http' : 'https'
  return `${proto}://${host}`
}

async function triggerHop(origin: string, hop: SyncPayload): Promise<void> {
  await fetch(`${origin}/api/sync`, {
    method:  'POST',
    headers: {
      'content-type':  'application/json',
      'x-sync-secret': INTERNAL_SECRET,
    },
    body: JSON.stringify(hop),
  }).catch(err => console.error('sync: failed to trigger hop', err))
}

export async function POST(req: Request) {
  let userId:  string
  let payload: SyncPayload

  const internalSecret = req.headers.get('x-sync-secret')

  if (internalSecret) {
    // ── Server-to-server hop ──────────────────────────────────────────────────
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
    payload = { ...body, userId, visited: [], failCounts: {}, isChainHop: false } as SyncPayload
  }

  if (!payload.cards || payload.cards.length === 0) {
    return Response.json({ ok: true })
  }

  const origin = getOrigin(req)

  after(async () => {
    console.log('[sync] after() invoked', {
      userId:      payload.userId.slice(0, 8),
      cards:       payload.cards.length,
      src:         `${payload.sourceLanguage}:${payload.targetLanguage}`,
      isChainHop:  !!payload.isChainHop,
    })
    try {
      // If this is a cascading hop to a new language, wait before hitting Anthropic
      if (payload.isChainHop) {
        await sleep(CHAIN_DELAY_MS)
      }

      const { failedCards, nextHops } = await processSyncBatch(payload)
      console.log('[sync] batch done', { failed: failedCards.length, nextHops: nextHops.length })

      // Update fail counts; drop cards that have failed too many times
      const failCounts: Record<string, number> = { ...(payload.failCounts ?? {}) }
      const retryable = failedCards.filter(c => {
        const count = (failCounts[c.id] ?? 0) + 1
        failCounts[c.id] = count
        return count < MAX_CARD_FAILS
      })

      // Continue this language with the remaining + failed cards
      const remaining  = payload.cards.slice(BATCH_SIZE)
      const nextCards  = [...remaining, ...retryable]
      if (nextCards.length > 0) {
        await triggerHop(origin, {
          userId:         payload.userId,
          sourceLanguage: payload.sourceLanguage,
          targetLanguage: payload.targetLanguage,
          cards:          nextCards,
          visited:        payload.visited,
          failCounts,
          isChainHop:     false,
        })
      }

      // Cascade to new languages (each hop sleeps CHAIN_DELAY_MS internally)
      for (const hop of nextHops) {
        await triggerHop(origin, hop as NextHop)
      }
    } catch (err) {
      console.error('sync after() error:', err)
    }
  })

  return Response.json({ ok: true })
}
