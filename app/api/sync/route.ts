/**
 * POST /api/sync
 *
 * Two-phase language sync (see lib/syncProcessor.ts for full explanation).
 *
 * PHASE 1 — Stub creation (no AI, ~1–2 s):
 *   Called once by the upload page. Creates placeholder cards for every
 *   destination language immediately (front = original word, e.g. "el perro").
 *   Cards appear in the user's library right away. Each stub has a pending
 *   `synced_card_links` row. Then triggers Phase 2.
 *
 * PHASE 2 — Translation fill (AI, self-chaining):
 *   Called with { fillPending: true }. Each invocation translates FILL_BATCH
 *   (5) pending links via Anthropic and updates the cards' front/back. Then
 *   re-fires itself for the next batch. Sequential chain → max 1 concurrent
 *   invocation at a time, safely under Vercel Hobby's 6-function limit.
 *
 * Auth:
 *   Initial client call:     Authorization: Bearer <supabase-jwt>
 *   Server-to-server calls:  x-sync-secret: <SYNC_INTERNAL_SECRET env var>
 */

import { after }             from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createAllStubs,
  fillPendingBatch,
  type SyncPayload,
} from '@/lib/syncProcessor'

export const runtime     = 'nodejs'
export const maxDuration = 10

const INTERNAL_SECRET = process.env.SYNC_INTERNAL_SECRET ?? 'dev-sync-secret'

function getOrigin(req: Request): string {
  const host  = req.headers.get('host') ?? 'localhost:3000'
  const proto = host.startsWith('localhost') ? 'http' : 'https'
  return `${proto}://${host}`
}

async function triggerFill(origin: string, userId: string): Promise<void> {
  await fetch(`${origin}/api/sync`, {
    method:  'POST',
    headers: {
      'content-type':  'application/json',
      'x-sync-secret': INTERNAL_SECRET,
    },
    body: JSON.stringify({ userId, fillPending: true, cards: [] } as SyncPayload),
  }).catch(err => console.error('[sync] failed to trigger fill', err))
}

export async function POST(req: Request) {
  let userId:  string
  let payload: SyncPayload

  const internalSecret = req.headers.get('x-sync-secret')

  if (internalSecret) {
    // ── Server-to-server (self-chain) ─────────────────────────────────────────
    if (internalSecret !== INTERNAL_SECRET) {
      return Response.json({ ok: false }, { status: 401 })
    }
    const body = await req.json()
    userId  = body.userId as string
    payload = body as SyncPayload
  } else {
    // ── Initial upload-page call ──────────────────────────────────────────────
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
    payload = { ...body, userId } as SyncPayload
  }

  if (!payload.userId) {
    return Response.json({ ok: false, error: 'missing userId' }, { status: 400 })
  }

  const origin = getOrigin(req)

  // ── Phase 2: Translation fill ─────────────────────────────────────────────
  if (payload.fillPending) {
    after(async () => {
      console.log('[sync] fill batch start', { userId: payload.userId.slice(0, 8) })
      try {
        const { filled, remaining } = await fillPendingBatch(payload.userId)
        console.log('[sync] fill batch done', { filled, remaining })
        if (remaining > 0) {
          await triggerFill(origin, payload.userId)
        } else {
          console.log('[sync] all translations complete for', payload.userId.slice(0, 8))
        }
      } catch (err) {
        console.error('[sync] fill batch error:', err)
      }
    })
    return Response.json({ ok: true })
  }

  // ── Phase 1: Stub creation ────────────────────────────────────────────────
  if (!payload.cards || payload.cards.length === 0) {
    return Response.json({ ok: true })
  }

  after(async () => {
    console.log('[sync] stub creation start', {
      userId: payload.userId.slice(0, 8),
      cards:  payload.cards.length,
      src:    `${payload.sourceLanguage}:${payload.targetLanguage}`,
    })
    try {
      const { pendingCount } = await createAllStubs(payload)
      console.log('[sync] stubs created', { pendingCount })
      if (pendingCount > 0) {
        // Start the fill chain — translations happen FILL_BATCH at a time
        await triggerFill(origin, payload.userId)
      }
    } catch (err) {
      console.error('[sync] stub creation error:', err)
    }
  })

  return Response.json({ ok: true })
}
