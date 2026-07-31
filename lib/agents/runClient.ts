/**
 * lib/agents/runClient.ts — browser-side application of a reviewed agent run.
 *
 * This runs in the browser so gateway ops hit the user's own RLS-scoped
 * Supabase session (via the existing repos): `applyProposal` applies one
 * approved item from a persisted change set through the real gateway
 * (non-dry-run).
 */

import type { Grant, GatewayContext, ChangeSetItem, UserId } from '@/domain'
import { createSupabaseGatewayDeps } from './deps'
import * as gw from './gateway'

/** Applies a single approved proposal through the gateway (non-dry-run, audited). */
export async function applyProposal(userId: UserId, item: ChangeSetItem): Promise<void> {
  const p = item.proposal
  const operation = p.field === 'create' ? 'create' : p.field === 'delete' ? 'delete' : 'edit'
  const grant: Grant = { operations: [operation], languages: [], folderIds: [], deckIds: [p.deckId], dryRunOnly: false }
  const ctx: GatewayContext = { userId, grant, actor: 'user' }
  const deps = createSupabaseGatewayDeps()

  if (p.field === 'create') {
    const a = p.after as { front: string; back: string }
    await gw.createCard(ctx, deps, { deckId: p.deckId, front: a.front, back: a.back, reason: p.reason })
  } else if (p.field === 'delete') {
    await gw.deleteCard(ctx, deps, { deckId: p.deckId, cardId: p.cardId!, reason: p.reason })
  } else if (p.field === 'front' || p.field === 'back') {
    const patch = p.field === 'front' ? { front: String(p.after) } : { back: String(p.after) }
    await gw.editCardText(ctx, deps, { deckId: p.deckId, cardId: p.cardId!, ...patch, reason: p.reason })
  } else {
    throw new Error(`cannot apply proposal of field '${p.field}'`)
  }
}
