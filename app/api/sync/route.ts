/**
 * POST /api/sync
 *
 * Two-phase language sync (see lib/syncProcessor.ts for full explanation).
 *
 * PHASE 1 — Stub creation (no AI, ~1–2 s):
 *   Called once by the upload page. Creates blank placeholder cards for every
 *   destination language immediately. The original source word is stored as a
 *   hidden hint on each card. Cards appear in every language deck right away.
 *   Then triggers Phase 2.
 *
 * PHASE 2 — Translation fill (AI, one-shot parallel):
 *   Called with { fillPending: true }. ALL pending cards for this user call
 *   the AI simultaneously in a single Promise.all — each card independently
 *   generates its proper front/back from the stored source word. On success
 *   the hidden hint is removed and the link is marked active. If any failed
 *   (Anthropic error), a single retry pass is triggered.
 *
 * Auth:
 *   Initial client call:     Authorization: Bearer <supabase-jwt>
 *   Server-to-server calls:  x-sync-secret: <SYNC_INTERNAL_SECRET env var>
 */

import { after }             from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createAllStubs,
  fillAllPending,
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
    // ── Server-to-server (retry pass) ────────────────────────────────────────
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
      console.log('[sync] fill all pending start', { userId: payload.userId.slice(0, 8) })
      try {
        const { filled, remaining } = await fillAllPending(payload.userId)
        console.log('[sync] fill done', { filled, remaining })
        // Retry once if any calls failed (Anthropic error / timeout)
        if (remaining > 0) {
          console.log('[sync] retrying', remaining, 'failed cards')
          await triggerFill(origin, payload.userId)
        } else {
          console.log('[sync] all translations complete for', payload.userId.slice(0, 8))
        }
      } catch (err) {
        console.error('[sync] fill error:', err)
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
        await triggerFill(origin, payload.userId)
      }
    } catch (err) {
      console.error('[sync] stub creation error:', err)
    }
  })

  return Response.json({ ok: true })
}
