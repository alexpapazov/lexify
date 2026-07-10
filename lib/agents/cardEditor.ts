/**
 * lib/agents/cardEditor.ts — browser helpers for the batched, interactive
 * card-editor flow. The agent applies whatever free-form INSTRUCTION the user
 * gives; reads/writes go through the scoped gateway (scope + audit apply); only
 * the analysis is a server call (`/api/agents/card-editor`), one batch at a time.
 */

import type { Grant, GatewayContext, UserId } from '@/domain'
import { createSupabaseGatewayDeps } from './deps'
import * as gw from './gateway'

export interface ScopedCard { deckId: string; cardId: string; front: string; back: string }

export type EditAction = 'edit' | 'split' | 'delete'

/**
 * A proposed change to one card. `front`/`back` (from ScopedCard) are the CURRENT
 * text; `newFront`/`newBack` are the proposed replacements for an 'edit'.
 */
export interface EditProposal extends ScopedCard {
  action:       EditAction
  newFront?:    string    // 'edit' — new front (omitted = unchanged)
  newBack?:     string    // 'edit' — new back  (omitted = unchanged)
  primaryBack?: string    // 'split' — gloss the original card keeps
  extraBacks?:  string[]  // 'split' — one new sibling per extra gloss
  reason:       string
}

const editGrant = (deckIds: string[]): Grant =>
  ({ operations: ['edit', 'create', 'delete'], languages: [], folderIds: [], deckIds, dryRunOnly: false })

/** Every card in the granted scope, as {deckId, cardId, front, back}. Reads only. */
export async function gatherScopedCards(userId: UserId, grant: Grant): Promise<ScopedCard[]> {
  const deps = createSupabaseGatewayDeps()
  const ctx: GatewayContext = { userId, grant, actor: 'card-editor' }
  const decks = await gw.listDecksInScope(ctx, deps)
  const out: ScopedCard[] = []
  for (const d of decks) {
    const cards = await gw.searchCards(ctx, deps, { deckId: d.id })
    for (const c of cards) out.push({ deckId: d.id, cardId: c.id, front: c.front, back: c.back })
  }
  return out
}

/** Splits an array into fixed-size chunks. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Analyzes one batch against the user's instruction; returns edit proposals joined to their cards. */
export async function analyzeBatch(batch: ScopedCard[], task: string): Promise<EditProposal[]> {
  const res = await fetch('/api/agents/card-editor', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, cards: batch.map(c => ({ cardId: c.cardId, front: c.front, back: c.back })) }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' — '))
  const byId = new Map(batch.map(c => [c.cardId, c]))
  type RawEdit = { cardId: string; action: EditAction; front?: string; back?: string; primaryBack?: string; extraBacks?: string[]; reason: string }
  return (data.edits as RawEdit[]).flatMap(e => {
    const src = byId.get(e.cardId)
    return src ? [{ ...src, action: e.action, newFront: e.front, newBack: e.back, primaryBack: e.primaryBack, extraBacks: e.extraBacks, reason: e.reason }] : []
  })
}

/** Reverts a just-applied text edit back to the card's original front/back (single-level undo). */
export async function undoEdit(userId: UserId, p: EditProposal): Promise<void> {
  if (p.action !== 'edit') return
  const deps = createSupabaseGatewayDeps()
  const ctx: GatewayContext = { userId, grant: editGrant([p.deckId]), actor: 'card-editor' }
  await gw.editCardText(ctx, deps, { deckId: p.deckId, cardId: p.cardId, front: p.front, back: p.back, reason: 'undo' })
}

/** Applies one approved proposal to the library through the gateway (audited). */
export async function applyProposal(userId: UserId, p: EditProposal): Promise<void> {
  const deps = createSupabaseGatewayDeps()
  const ctx: GatewayContext = { userId, grant: editGrant([p.deckId]), actor: 'card-editor' }
  if (p.action === 'split') {
    await gw.splitTranslation(ctx, deps, { deckId: p.deckId, cardId: p.cardId, primaryBack: p.primaryBack ?? p.back, extraBacks: p.extraBacks ?? [], reason: p.reason })
  } else if (p.action === 'delete') {
    await gw.deleteCard(ctx, deps, { deckId: p.deckId, cardId: p.cardId, reason: p.reason })
  } else {
    await gw.editCardText(ctx, deps, { deckId: p.deckId, cardId: p.cardId, front: p.newFront, back: p.newBack, reason: p.reason })
  }
}
