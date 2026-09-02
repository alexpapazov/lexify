/**
 * lib/agents/cardEditor.ts — browser helpers for the batched, interactive
 * card-editor flow. The agent applies whatever free-form INSTRUCTION the user
 * gives; reads/writes go through the scoped gateway (scope + audit apply); only
 * the analysis is a server call (`/api/agents/card-editor`), one batch at a time.
 */

import type { CardState, Grant, GatewayContext, UserId } from '@/domain'
import { apiUrl } from '@/lib/apiBase'
import { createSupabaseGatewayDeps } from './deps'
import * as gw from './gateway'
import { normalizeFrontKey } from '@/lib/duplicates'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
/** Which card sides the agent may read (and therefore edit). Defined here, not in the API route:
 * client code must never import from `app/api/**` — the Capacitor build stashes that directory
 * before the static export, and any client-reachable import of it breaks `npm run build:cap`. */
export type AgentSides = 'front' | 'back' | 'both'

export interface ScopedCard {
  deckId: string
  cardId: string
  front: string
  back: string
  /** Language of `front` — needed to normalize it (article stripping is per-language). */
  sourceLanguage?: string
  /** Deck this card was found in, for telling otherwise-identical duplicates apart in the UI. */
  deckName?: string
}

type EditAction = 'edit' | 'split' | 'delete' | 'dedupe'

/**
 * A proposed change. `front`/`back` (from ScopedCard) are the CURRENT text; `newFront`/`newBack` are
 * the proposed replacements for an 'edit'.
 *
 * 'dedupe' is the odd one out: it covers a whole GROUP of duplicate cards rather than a single card,
 * so `group` (every copy, keeper included) and `keepCardId` carry the real payload and the inherited
 * `cardId`/`deckId` are meaningless — never read them on a dedupe proposal.
 */
export interface EditProposal extends ScopedCard {
  action:       EditAction
  newFront?:    string    // 'edit' — new front (omitted = unchanged)
  newBack?:     string    // 'edit' — new back  (omitted = unchanged)
  primaryBack?: string    // 'split' — gloss the original card keeps
  extraBacks?:  string[]  // 'split' — one new sibling per extra gloss
  group?:       ScopedCard[]  // 'dedupe' — every copy sharing the key, keeper included
  keepCardId?:  string        // 'dedupe' — the copy that survives; the rest are deleted
  /** Stable identity for UI state that must survive queue shuffling (undo unshifts, approve slices). */
  id?:          string
  reason:       string
}

/** How de-dupe decides two cards are the same card. */
export type DedupeMode = 'front' | 'front-back'

/**
 * Decides which copies of a duplicate group may actually be deleted, given which are still alive.
 *
 * Pure, and separated from `applyProposal` precisely because this is the rule that prevents the worst
 * possible outcome — deleting the last surviving copy of a word. A group is built from a scan that
 * may be minutes old; by the time it's approved a card could have been removed by an earlier
 * proposal, another tab, or the card editor.
 *
 * Throws rather than silently narrowing, so the UI keeps the proposal on screen and the learner
 * decides again with accurate information.
 */
export function planDedupeDeletions(
  group: ScopedCard[],
  keepCardId: string | undefined,
  isAlive: (cardId: string) => boolean,
): { keep: ScopedCard; doomed: ScopedCard[] } {
  const live = group.filter(c => isAlive(c.cardId))
  if (live.length < 2) throw new Error('Only one copy is still there — nothing left to de-duplicate.')
  const keep = live.find(c => c.cardId === keepCardId)
  if (!keep) throw new Error('The copy you chose to keep has already been deleted. Pick another to keep.')
  const doomed = live.filter(c => c.cardId !== keep.cardId)
  if (doomed.length === 0) throw new Error('nothing to delete in this duplicate group')
  return { keep, doomed }
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
    for (const c of cards) out.push({
      deckId: d.id, cardId: c.id, front: c.front, back: c.back,
      sourceLanguage: d.sourceLanguage, deckName: d.name,
    })
  }
  return out
}

/**
 * Deterministic duplicate finder — no AI.
 *
 * Two modes:
 *   'front-back' — the same card twice: FRONT and BACK both match.
 *   'front'      — the same WORD twice, whatever the glosses say. Catches "cielo = sky" vs
 *                  "cielo = heaven", which front+back matching cannot see and which is how mass
 *                  imports leak duplicates. Genuine homographs land here too, which is exactly why
 *                  this PROPOSES rather than deletes.
 *
 * Emits ONE proposal per duplicate group (not one per extra copy), carrying every copy so the review
 * UI can show them side by side and let the user pick which survives.
 *
 * `rank` orders candidates for the DEFAULT keeper — higher wins. The caller passes review progress,
 * so the copy actually being studied is kept and the untouched import is the one deleted. Ties fall
 * back to scan order, which is deck order.
 *
 * A shared card appearing in several decks is one logical card (same cardId) and is collapsed to a
 * single entry first, so it never counts as a duplicate of itself.
 */
export function findDuplicates(
  cards: ScopedCard[],
  opts: { mode?: DedupeMode; rank?: (cardId: string) => number } = {},
): EditProposal[] {
  const mode = opts.mode ?? 'front-back'
  const rank = opts.rank ?? (() => 0)

  const byId = new Map<string, ScopedCard>()
  for (const c of cards) if (!byId.has(c.cardId)) byId.set(c.cardId, c)

  const groups = new Map<string, ScopedCard[]>()
  for (const c of byId.values()) {
    const front = normalizeFrontKey(c.front, c.sourceLanguage ?? '')
    if (!front) continue   // nothing to compare on
    // NUL separator so a word boundary can't forge a collision across the two fields.
    const key = mode === 'front'
      ? front
      : `${front}\0${c.back.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()}`
    const g = groups.get(key)
    if (g) g.push(c); else groups.set(key, [c])
  }

  const out: EditProposal[] = []
  for (const [key, g] of groups) {
    if (g.length < 2) continue
    // Stable: only a strictly higher rank displaces the incumbent, so equal ranks keep scan order.
    const keep = g.reduce((best, c) => rank(c.cardId) > rank(best.cardId) ? c : best, g[0]!)
    out.push({
      ...keep,
      id: `dedupe:${key}`,
      action: 'dedupe',
      group: g,
      keepCardId: keep.cardId,
      reason: mode === 'front'
        ? `${g.length} cards share the word \u201c${keep.front}\u201d.`
        : `${g.length} identical copies of \u201c${keep.front} = ${keep.back}\u201d.`,
    })
  }
  return out
}

/** Splits an array into fixed-size chunks. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Analyzes one batch against the user's instruction; returns edit proposals joined to their cards.
 *
 * `sides` is the visibility gate — the hidden side is dropped HERE, at the only point where card text
 * leaves the browser, so the model genuinely never receives it. The proposals returned still carry
 * both sides, because they're rebuilt from the LOCAL `ScopedCard`; the review UI shows the whole card
 * even when the agent was blind to half of it.
 */
export async function analyzeBatch(batch: ScopedCard[], task: string, sides: AgentSides = 'both'): Promise<EditProposal[]> {
  const res = await fetch(apiUrl('/api/agents/card-editor'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      task, sides,
      cards: batch.map(c => ({
        cardId: c.cardId,
        ...(sides !== 'back'  ? { front: c.front } : {}),
        ...(sides !== 'front' ? { back:  c.back  } : {}),
      })),
    }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' — '))
  const byId = new Map(batch.map(c => [c.cardId, c]))
  type RawEdit = { cardId: string; action: EditAction; front?: string; back?: string; primaryBack?: string; extraBacks?: string[]; reason: string }
  return (data.edits as RawEdit[]).flatMap(e => {
    const src = byId.get(e.cardId)
    if (!src) return []
    // Second gate, client-side: never let a hidden side through even if the route regressed.
    const newFront = sides !== 'back'  ? e.front : undefined
    const newBack  = sides !== 'front' ? e.back  : undefined
    if (e.action === 'split' && sides === 'front') return []
    return [{ ...src, action: e.action, newFront, newBack, primaryBack: e.primaryBack, extraBacks: e.extraBacks, reason: e.reason }]
  })
}

/** Reverts a just-applied text edit back to the card's original front/back (single-level undo). */
export async function undoEdit(userId: UserId, p: EditProposal): Promise<void> {
  if (p.action !== 'edit') return
  const deps = createSupabaseGatewayDeps()
  const ctx: GatewayContext = { userId, grant: editGrant([p.deckId]), actor: 'card-editor' }
  await gw.editCardText(ctx, deps, { deckId: p.deckId, cardId: p.cardId, front: p.front, back: p.back, reason: 'undo' })
}

/**
 * What an applied proposal needs in order to be undone.
 *
 * For a dedupe, that includes the deleted cards' `card_states` rows: `soft_delete_card` DELETES them
 * (along with typed-answer overrides), so simply un-deleting the card would bring it back stripped of
 * every review — reps, lapses, difficulty, stability, due dates. Capturing them first is what makes
 * Undo a real undo rather than a resurrection.
 */
export interface AppliedUndo {
  proposal:      EditProposal
  /** Cards deleted by a dedupe, with the states they had at deletion time. */
  deleted?:      { cardId: string; states: CardState[] }[]
}

/** Restores whatever `applyProposal` did. Text edits revert; deleted duplicates come back with their
 *  review history. Typed-answer overrides are NOT restored — the delete RPC drops them and they
 *  aren't worth a snapshot. */
export async function undoApplied(userId: UserId, undo: AppliedUndo): Promise<void> {
  const p = undo.proposal
  if (p.action === 'edit') return undoEdit(userId, p)
  if (p.action !== 'dedupe' || !undo.deleted?.length) return

  const cardRepo  = new SupabaseCardRepository()
  const stateRepo = new SupabaseCardStateRepository()
  for (const { cardId, states } of undo.deleted) {
    await cardRepo.undelete(cardId)
    if (states.length > 0) await stateRepo.upsertBatch(states)
  }
}

/** Applies one approved proposal to the library through the gateway (audited). Returns what's needed
 *  to undo it. */
export async function applyProposal(userId: UserId, p: EditProposal): Promise<AppliedUndo> {
  const deps = createSupabaseGatewayDeps()

  if (p.action === 'dedupe') {
    const group = p.group ?? []
    const keepId = p.keepCardId ?? group[0]?.cardId
    if (!keepId) throw new Error('nothing to delete in this duplicate group')

    // LIVENESS RE-CHECK, at apply time — `deps.getCard` returns null for a soft-deleted card. The
    // decision itself lives in the pure `planDedupeDeletions` above.
    const aliveIds = new Set((await Promise.all(
      group.map(async c => ((await deps.getCard(c.cardId)) != null ? c.cardId : null)),
    )).filter((id): id is string => id != null))
    const { doomed } = planDedupeDeletions(group, keepId, id => aliveIds.has(id))

    const stateRepo = new SupabaseCardStateRepository()
    // A group can span decks, so each delete needs a grant for ITS OWN deck — one shared grant built
    // from the proposal's deckId would be refused as out of scope for the others.
    const failed: string[] = []
    const deleted: { cardId: string; states: CardState[] }[] = []
    for (const c of doomed) {
      const cctx: GatewayContext = { userId, grant: editGrant([c.deckId]), actor: 'card-editor' }
      try {
        // Snapshot BEFORE deleting — `soft_delete_card` drops the card_states rows outright, so this
        // is the only moment the review history still exists.
        const states = (await Promise.all([
          stateRepo.get(userId, c.cardId, 'forward'),
          stateRepo.get(userId, c.cardId, 'reverse'),
        ])).filter((s): s is CardState => s != null)
        await gw.deleteCard(cctx, deps, { deckId: c.deckId, cardId: c.cardId, reason: p.reason })
        deleted.push({ cardId: c.cardId, states })
      } catch {
        failed.push(c.front)
      }
    }
    // Surface a partial failure so the caller can keep the proposal on screen rather than advancing
    // past a half-applied group.
    if (failed.length > 0) throw new Error(`${failed.length} of ${doomed.length} copies could not be deleted`)
    return { proposal: p, deleted }
  }

  const ctx: GatewayContext = { userId, grant: editGrant([p.deckId]), actor: 'card-editor' }
  if (p.action === 'split') {
    // Guard: a split with no primaryBack would silently rewrite the gloss to whatever the card
    // already had — harmless, but it means the proposal was malformed, so refuse it instead.
    if (!p.primaryBack || !(p.extraBacks ?? []).length) throw new Error('split proposal is missing its glosses')
    await gw.splitTranslation(ctx, deps, { deckId: p.deckId, cardId: p.cardId, primaryBack: p.primaryBack, extraBacks: p.extraBacks ?? [], reason: p.reason })
  } else if (p.action === 'delete') {
    await gw.deleteCard(ctx, deps, { deckId: p.deckId, cardId: p.cardId, reason: p.reason })
  } else {
    await gw.editCardText(ctx, deps, { deckId: p.deckId, cardId: p.cardId, front: p.newFront, back: p.newBack, reason: p.reason })
  }
  return { proposal: p }
}
