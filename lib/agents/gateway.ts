/**
 * lib/agents/gateway.ts — the single, scoped, audited entry point for every
 * agent-driven card mutation (Agent Platform, Phase 1). See
 * `features/Agent Platform.md`.
 *
 * Every mutation passes three gates:
 *   1. SCOPE   — the target deck must satisfy the caller's `Grant`
 *                (operation + languages + folders + decks).
 *   2. AUDIT   — an applied change writes an `agent_actions` row (before/after).
 *   3. APPLY / PROPOSE — when `grant.dryRunOnly`, ops only return a
 *                `ChangeProposal[]` and never touch data.
 *
 * The gateway is framework-free: it takes a `GatewayDeps` bundle (injected
 * repos) so it can be unit-tested with in-memory fakes. `createSupabaseGatewayDeps()`
 * wires the real repositories.
 */

import type {
  Card, CardId, Deck, DeckId, Folder, UserId,
  Grant, GatewayContext, ChangeProposal, AgentAction, AgentOperation,
} from '@/domain'
import { descendantDeckIds } from '@/lib/folderStats'

// ─── Dependencies (injected) ───────────────────────────────────────────────

export interface GatewayDeps {
  listDecks:   (userId: UserId) => Promise<Deck[]>
  listFolders: (userId: UserId) => Promise<Folder[]>
  listCards:   (deckId: DeckId) => Promise<Card[]>
  getCard:     (cardId: CardId) => Promise<Card | null>
  updateCard:  (cardId: CardId, patch: Partial<Pick<Card, 'front' | 'back'>>) => Promise<Card>
  createCard:  (deck: Deck, ownerId: UserId, front: string, back: string, position: number) => Promise<Card>
  deleteCard:  (cardId: CardId) => Promise<void>
  recordAction:(action: Omit<AgentAction, 'id' | 'createdAt'>) => Promise<void>
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class GatewayScopeError extends Error {
  constructor(message: string) { super(message); this.name = 'GatewayScopeError' }
}
class GatewayNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'GatewayNotFoundError' }
}

// ─── Scope ─────────────────────────────────────────────────────────────────

const pairKey = (d: Deck) => `${d.sourceLanguage}|${d.targetLanguage}`

/** Whether a deck satisfies a grant. `folderDeckIds` = decks reachable from the grant's folders. */
function deckMatchesGrant(deck: Deck, grant: Grant, folderDeckIds: Set<string>): boolean {
  if (grant.languages.length && !grant.languages.includes(pairKey(deck))) return false
  if (grant.deckIds.length   && !grant.deckIds.includes(deck.id))         return false
  if (grant.folderIds.length && !folderDeckIds.has(deck.id))              return false
  return true
}

/** Every deck the caller's grant permits touching. */
export async function listDecksInScope(ctx: GatewayContext, deps: GatewayDeps): Promise<Deck[]> {
  const decks = await deps.listDecks(ctx.userId)
  const folders = ctx.grant.folderIds.length ? await deps.listFolders(ctx.userId) : []
  const folderDeckIds = new Set(
    ctx.grant.folderIds.flatMap(fid => descendantDeckIds(fid, folders, decks)),
  )
  return decks.filter(d => deckMatchesGrant(d, ctx.grant, folderDeckIds))
}

function assertOperation(grant: Grant, op: AgentOperation): void {
  if (!grant.operations.includes(op)) {
    throw new GatewayScopeError(`operation '${op}' not permitted by this grant`)
  }
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() < Date.now()) {
    throw new GatewayScopeError('grant has expired')
  }
}

/** Resolves a deck and asserts it's in scope for `op`. Throws otherwise. */
async function assertDeckInScope(
  ctx: GatewayContext, deps: GatewayDeps, deckId: DeckId, op: AgentOperation,
): Promise<Deck> {
  assertOperation(ctx.grant, op)
  const deck = (await listDecksInScope(ctx, deps)).find(d => d.id === deckId)
  if (!deck) throw new GatewayScopeError(`deck ${deckId} is outside this grant's scope`)
  return deck
}

// ─── Result shape ──────────────────────────────────────────────────────────

export interface GatewayResult {
  /** true when the change was actually written (false for dry-run or a no-op). */
  applied:   boolean
  /** What changed (or would change, under dry-run). Empty when nothing differs. */
  proposals: ChangeProposal[]
  /** The resulting card, when applicable and applied. */
  card?:     Card
}

// ─── Read ops ───────────────────────────────────────────────────────────────

/** Cards in a single in-scope deck, optionally filtered by a case-insensitive substring on either side. */
export async function searchCards(
  ctx: GatewayContext, deps: GatewayDeps, args: { deckId: DeckId; query?: string },
): Promise<Card[]> {
  // A read still respects scope but doesn't require a mutating operation grant.
  const deck = (await listDecksInScope(ctx, deps)).find(d => d.id === args.deckId)
  if (!deck) throw new GatewayScopeError(`deck ${args.deckId} is outside this grant's scope`)
  const cards = await deps.listCards(args.deckId)
  const q = args.query?.trim().toLowerCase()
  if (!q) return cards
  return cards.filter(c => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q))
}

// ─── Mutation ops (apply or propose) ─────────────────────────────────────────

/** Edits a card's front and/or back text. */
export async function editCardText(
  ctx: GatewayContext, deps: GatewayDeps,
  args: { deckId: DeckId; cardId: CardId; front?: string; back?: string; reason: string },
): Promise<GatewayResult> {
  const deck = await assertDeckInScope(ctx, deps, args.deckId, 'edit')
  const card = await deps.getCard(args.cardId)
  if (!card) throw new GatewayNotFoundError(`card ${args.cardId} not found`)

  const proposals: ChangeProposal[] = []
  if (args.front !== undefined && args.front !== card.front) {
    proposals.push({ cardId: card.id, deckId: deck.id, field: 'front', before: card.front, after: args.front, reason: args.reason })
  }
  if (args.back !== undefined && args.back !== card.back) {
    proposals.push({ cardId: card.id, deckId: deck.id, field: 'back', before: card.back, after: args.back, reason: args.reason })
  }
  if (proposals.length === 0) return { applied: false, proposals: [] }
  if (ctx.grant.dryRunOnly)   return { applied: false, proposals }

  const patch: Partial<Pick<Card, 'front' | 'back'>> = {}
  if (args.front !== undefined) patch.front = args.front
  if (args.back !== undefined)  patch.back = args.back
  const updated = await deps.updateCard(card.id, patch)
  await deps.recordAction({
    userId: ctx.userId, actor: ctx.actor, operation: 'edit', cardId: card.id, deckId: deck.id,
    before: { front: card.front, back: card.back }, after: { front: updated.front, back: updated.back }, dryRun: false,
  })
  return { applied: true, proposals, card: updated }
}

/** Creates a new card in an in-scope deck. */
export async function createCard(
  ctx: GatewayContext, deps: GatewayDeps,
  args: { deckId: DeckId; front: string; back: string; reason: string },
): Promise<GatewayResult> {
  const deck = await assertDeckInScope(ctx, deps, args.deckId, 'create')
  const proposal: ChangeProposal = {
    cardId: null, deckId: deck.id, field: 'create',
    before: null, after: { front: args.front, back: args.back }, reason: args.reason,
  }
  if (ctx.grant.dryRunOnly) return { applied: false, proposals: [proposal] }

  const existing = await deps.listCards(deck.id)
  const created = await deps.createCard(deck, ctx.userId, args.front, args.back, existing.length)
  await deps.recordAction({
    userId: ctx.userId, actor: ctx.actor, operation: 'create', cardId: created.id, deckId: deck.id,
    before: null, after: { front: created.front, back: created.back }, dryRun: false,
  })
  return { applied: true, proposals: [proposal], card: created }
}

/** Soft-deletes a card (removes it everywhere it's referenced). */
export async function deleteCard(
  ctx: GatewayContext, deps: GatewayDeps,
  args: { deckId: DeckId; cardId: CardId; reason: string },
): Promise<GatewayResult> {
  const deck = await assertDeckInScope(ctx, deps, args.deckId, 'delete')
  const card = await deps.getCard(args.cardId)
  if (!card) throw new GatewayNotFoundError(`card ${args.cardId} not found`)
  const proposal: ChangeProposal = {
    cardId: card.id, deckId: deck.id, field: 'delete',
    before: { front: card.front, back: card.back }, after: null, reason: args.reason,
  }
  if (ctx.grant.dryRunOnly) return { applied: false, proposals: [proposal] }

  await deps.deleteCard(card.id)
  await deps.recordAction({
    userId: ctx.userId, actor: ctx.actor, operation: 'delete', cardId: card.id, deckId: deck.id,
    before: { front: card.front, back: card.back }, after: null, dryRun: false,
  })
  return { applied: true, proposals: [proposal], card }
}

/**
 * Splits a card whose back holds two glosses (e.g. `salut = hi / hello`) into a
 * primary card (back = `primaryBack`) plus one new sibling card per extra gloss.
 * Composite of `editCardText` + `createCard`, so it inherits scope + dry-run.
 */
export async function splitTranslation(
  ctx: GatewayContext, deps: GatewayDeps,
  args: { deckId: DeckId; cardId: CardId; primaryBack: string; extraBacks: string[]; reason: string },
): Promise<GatewayResult> {
  const edit = await editCardText(ctx, deps, { deckId: args.deckId, cardId: args.cardId, back: args.primaryBack, reason: args.reason })
  const card = await deps.getCard(args.cardId)
  const front = card?.front ?? ''
  const proposals: ChangeProposal[] = [...edit.proposals]
  let applied = edit.applied
  for (const extra of args.extraBacks) {
    const res = await createCard(ctx, deps, { deckId: args.deckId, front, back: extra, reason: args.reason })
    proposals.push(...res.proposals)
    applied = applied || res.applied
  }
  return { applied, proposals }
}
