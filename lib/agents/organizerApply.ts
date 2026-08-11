/**
 * lib/agents/organizerApply.ts — executing an approved `MoveProposal`, and undoing it.
 *
 * A move is a **deck_cards relink**: add the link to the destination deck, drop the link to the deck
 * the card was scoped in. The card row itself is never touched, so review history, audio, choices
 * and every other deck the card is shared into survive untouched.
 *
 * ORDER MATTERS: link the destination FIRST, then unlink the source. If the process dies between the
 * two steps the card is in both places (visible, fixable) rather than in neither (invisible, and it
 * looks exactly like data loss). Never reverse these.
 *
 * Folders and decks named by a destination are created on demand and REUSED by name at their level,
 * so organizing twice doesn't fork the tree — the same rule `BatchDeckImport.ensureFolderPath` uses.
 */

import type { Deck, DeckId, Folder, UserId } from '@/domain'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import type { Destination, MoveProposal } from './cardOrganizer'

/** Everything a move needs that the caller already has loaded, so applying costs no extra reads. */
export interface OrganizerContext {
  userId:         UserId
  sourceLanguage: string
  targetLanguage: string
  pipelineId:     string
  /** Live library, updated in place as folders/decks are created (so a batch reuses them). */
  folders:        Folder[]
  decks:          Deck[]
}

/** What an applied move did, so it can be reversed exactly. */
export interface AppliedMove {
  proposal:  MoveProposal
  fromDeckId: DeckId
  toDeckId:   DeckId
}

/** Creates or reuses every folder on `path`, returning the deepest folder's id (null at the root). */
export async function ensureFolderPath(ctx: OrganizerContext, path: string[]): Promise<string | null> {
  const repo = new SupabaseFolderRepository()
  let parentId: string | null = null
  for (const rawName of path) {
    const name = rawName.trim()
    if (!name) continue
    // Reuse a same-named folder at this level. A folder with no pair of its own is shared, so it
    // matches too — same rule as batch import, so the two features can't fork each other's trees.
    const existing = ctx.folders.find(f =>
      f.parentId === parentId &&
      f.name.trim().toLowerCase() === name.toLowerCase() &&
      (!f.sourceLanguage || (f.sourceLanguage === ctx.sourceLanguage && f.targetLanguage === ctx.targetLanguage)))
    if (existing) { parentId = existing.id; continue }
    const created = await repo.create(ctx.userId, name, parentId, {
      sourceLanguage: ctx.sourceLanguage, targetLanguage: ctx.targetLanguage,
    })
    ctx.folders.push(created)
    parentId = created.id
  }
  return parentId
}

/** Creates or reuses the destination deck, returning its id. */
export async function ensureDeck(ctx: OrganizerContext, to: Destination): Promise<DeckId> {
  const folderId = await ensureFolderPath(ctx, to.path)
  const name = to.deck.trim()
  const existing = ctx.decks.find(d =>
    d.folderId === folderId &&
    d.name.trim().toLowerCase() === name.toLowerCase() &&
    d.sourceLanguage === ctx.sourceLanguage && d.targetLanguage === ctx.targetLanguage)
  if (existing) return existing.id

  const deckRepo = new SupabaseDeckRepository()
  const created = await deckRepo.create(ctx.userId, {
    name, sourceLanguage: ctx.sourceLanguage, targetLanguage: ctx.targetLanguage, pipelineId: ctx.pipelineId,
  })
  const placed = folderId ? await deckRepo.update(created.id, { folderId }) : created
  ctx.decks.push(placed)
  return placed.id
}

/**
 * Applies one move. Returns what it did so `undoMove` can put it back.
 *
 * A card already linked to the destination just loses its source link — `addToDeck` upserts with
 * `ignoreDuplicates`, so re-running a move is harmless rather than an error.
 */
export async function applyMove(ctx: OrganizerContext, p: MoveProposal): Promise<AppliedMove> {
  const cardRepo = new SupabaseCardRepository()
  const toDeckId = await ensureDeck(ctx, p.to)
  if (toDeckId === p.deckId) return { proposal: p, fromDeckId: p.deckId, toDeckId }

  const existing = await cardRepo.listByDeck(toDeckId)
  await cardRepo.addToDeck(toDeckId, p.cardId, existing.length)   // link destination FIRST
  await cardRepo.removeFromDeck(p.deckId, p.cardId)               // …then unlink source
  return { proposal: p, fromDeckId: p.deckId, toDeckId }
}

/**
 * Reverses an applied move: relink the source, unlink the destination. Same order rule — the card is
 * never unlinked from everywhere, even momentarily.
 *
 * Folders and decks the move created are left in place. An empty deck is visible and trivially
 * deleted by hand; auto-deleting one risks removing a folder the user had meanwhile put something
 * else into.
 */
export async function undoMove(applied: AppliedMove): Promise<void> {
  const { proposal: p, fromDeckId, toDeckId } = applied
  if (fromDeckId === toDeckId) return
  const cardRepo = new SupabaseCardRepository()
  const back = await cardRepo.listByDeck(fromDeckId)
  await cardRepo.addToDeck(fromDeckId, p.cardId, back.length)
  await cardRepo.removeFromDeck(toDeckId, p.cardId)
}
