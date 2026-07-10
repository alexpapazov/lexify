/**
 * lib/agents/cardEditor.ts — browser helpers for the batched, interactive
 * card-editor flow. Reads/writes go through the scoped gateway (so scope + audit
 * still apply); only the analysis is a server call (`/api/agents/card-editor`),
 * done one batch at a time.
 */

import type { Grant, GatewayContext, UserId } from '@/domain'
import { createSupabaseGatewayDeps } from './deps'
import * as gw from './gateway'

export interface ScopedCard { deckId: string; cardId: string; front: string; back: string }

/** A proposed split, joined with the source card's deck + front for display/apply. */
export interface SplitProposal extends ScopedCard {
  primaryBack: string
  extraBacks:  string[]
  reason:      string
}

const readGrant = (deckIds: string[]): Grant =>
  ({ operations: ['edit', 'create'], languages: [], folderIds: [], deckIds, dryRunOnly: false })

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

/** Analyzes one batch of cards; returns split proposals joined back to their source cards. */
export async function analyzeBatch(batch: ScopedCard[]): Promise<SplitProposal[]> {
  const res = await fetch('/api/agents/card-editor', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cards: batch.map(c => ({ cardId: c.cardId, front: c.front, back: c.back })) }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' — '))
  const byId = new Map(batch.map(c => [c.cardId, c]))
  return (data.splits as Array<{ cardId: string; primaryBack: string; extraBacks: string[]; reason: string }>)
    .flatMap(s => {
      const src = byId.get(s.cardId)
      return src ? [{ ...src, primaryBack: s.primaryBack, extraBacks: s.extraBacks, reason: s.reason }] : []
    })
}

/** Applies one approved split to the library (edit original + create siblings), audited. */
export async function applySplit(userId: UserId, p: SplitProposal): Promise<void> {
  const deps = createSupabaseGatewayDeps()
  const ctx: GatewayContext = { userId, grant: readGrant([p.deckId]), actor: 'card-editor' }
  await gw.splitTranslation(ctx, deps, {
    deckId: p.deckId, cardId: p.cardId, primaryBack: p.primaryBack, extraBacks: p.extraBacks, reason: p.reason,
  })
}
