/**
 * lib/agents/migrationApply.ts — executes an approved migration plan, and reverses it.
 *
 * Every step records what it needs to be undone BEFORE it runs, so "Undo migration" replays the
 * journal backwards. A migration is approved in one click, so the ability to take it back is what
 * makes that click safe.
 *
 * The move rules — established when the organizer only moved single cards, and still binding:
 *   - A card move is a `deck_cards` RELINK, never a card rewrite: review history, audio, cached
 *     distractors and every other deck the card is shared into survive untouched.
 *   - **Link the destination FIRST, unlink the source SECOND.** A crash between the two leaves the
 *     card in both places (visible, trivially fixed) rather than in neither, which is indistinguish-
 *     able from data loss. Undo mirrors the same order.
 *
 * Folders and decks are created on demand and reused by name at their level — the same rule as
 * `BatchDeckImport.ensureFolderPath`, so the organizer and the importer can't fork each other's tree.
 */

import type { Deck, Folder, UserId } from '@/domain'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import type { LibraryPath, MigrationStep } from './migrationPlan'

export interface MigrationContext {
  userId:         UserId
  sourceLanguage: string
  targetLanguage: string
  pipelineId:     string
  /** Live library, MUTATED as folders/decks are created so later steps reuse them. */
  folders: Folder[]
  decks:   Deck[]
}

/** What one executed step needs in order to be reversed. */
export type StepUndo =
  | { kind: 'createdFolder'; folderId: string }
  | { kind: 'movedFolder';   folderId: string; prevParentId: string | null }
  | { kind: 'movedDeck';     deckId: string;   prevFolderId: string | null }
  | { kind: 'movedCard';     cardId: string;   fromDeckId: string; toDeckId: string }
  | { kind: 'noop' }

export interface AppliedStep { step: MigrationStep; undo: StepUndo }

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Creates or reuses every folder on `path`, returning the deepest folder's id (null for the root). */
export async function ensureFolderPath(
  ctx: MigrationContext, path: LibraryPath, created: string[] = [],
): Promise<string | null> {
  let parentId: string | null = null
  for (const name of path) {
    // A folder with no pair of its own is shared, so it matches too — same rule as the importer.
    const existing = ctx.folders.find(f =>
      f.parentId === parentId && sameName(f.name, name) &&
      (!f.sourceLanguage || (f.sourceLanguage === ctx.sourceLanguage && f.targetLanguage === ctx.targetLanguage)))
    if (existing) { parentId = existing.id; continue }
    const folder = await new SupabaseFolderRepository().create(ctx.userId, name, parentId, {
      sourceLanguage: ctx.sourceLanguage, targetLanguage: ctx.targetLanguage,
    })
    ctx.folders.push(folder)
    created.push(folder.id)
    parentId = folder.id
  }
  return parentId
}

/** Creates or reuses the deck named by `path` (folders, then the deck name last). */
async function ensureDeck(ctx: MigrationContext, path: LibraryPath): Promise<string> {
  const deckName = path[path.length - 1]!
  const folderId = await ensureFolderPath(ctx, path.slice(0, -1))
  const existing = ctx.decks.find(d =>
    d.folderId === folderId && sameName(d.name, deckName) &&
    d.sourceLanguage === ctx.sourceLanguage && d.targetLanguage === ctx.targetLanguage)
  if (existing) return existing.id
  // `CreateDeckInput` carries no folder, so a deck is created and then placed.
  const deckRepo = new SupabaseDeckRepository()
  const created = await deckRepo.create(ctx.userId, {
    name: deckName, sourceLanguage: ctx.sourceLanguage, targetLanguage: ctx.targetLanguage,
    pipelineId: ctx.pipelineId,
  })
  const placed = folderId ? await deckRepo.update(created.id, { folderId }) : created
  ctx.decks.push(placed)
  return placed.id
}

/** Runs one step, returning what's needed to reverse it. */
export async function applyStep(ctx: MigrationContext, step: MigrationStep): Promise<AppliedStep> {
  if (step.kind === 'createFolder') {
    const created: string[] = []
    await ensureFolderPath(ctx, step.path, created)
    // Only the DEEPEST newly-created folder is recorded: undo deletes it, and deleting a parent
    // would take its (possibly pre-existing) siblings with it.
    const last = created[created.length - 1]
    return { step, undo: last ? { kind: 'createdFolder', folderId: last } : { kind: 'noop' } }
  }

  if (step.kind === 'moveFolder') {
    const folder = ctx.folders.find(f => f.id === step.folderId)
    if (!folder) return { step, undo: { kind: 'noop' } }
    const prevParentId = folder.parentId
    const toParentId = await ensureFolderPath(ctx, step.toParent)
    if (toParentId === prevParentId) return { step, undo: { kind: 'noop' } }
    await new SupabaseFolderRepository().updateParent(folder.id, toParentId)
    folder.parentId = toParentId
    return { step, undo: { kind: 'movedFolder', folderId: folder.id, prevParentId } }
  }

  if (step.kind === 'moveDeck') {
    const deck = ctx.decks.find(d => d.id === step.deckId)
    if (!deck) return { step, undo: { kind: 'noop' } }
    const prevFolderId = deck.folderId
    const toFolderId = await ensureFolderPath(ctx, step.toFolder)
    if (toFolderId === prevFolderId) return { step, undo: { kind: 'noop' } }
    await new SupabaseDeckRepository().update(deck.id, { folderId: toFolderId })
    deck.folderId = toFolderId
    return { step, undo: { kind: 'movedDeck', deckId: deck.id, prevFolderId } }
  }

  // moveCard — the relink, destination first.
  const cardRepo = new SupabaseCardRepository()
  const toDeckId = await ensureDeck(ctx, step.toDeck)
  if (toDeckId === step.fromDeckId) return { step, undo: { kind: 'noop' } }
  const existing = await cardRepo.listByDeck(toDeckId)
  await cardRepo.addToDeck(toDeckId, step.cardId, existing.length)
  await cardRepo.removeFromDeck(step.fromDeckId, step.cardId)
  return { step, undo: { kind: 'movedCard', cardId: step.cardId, fromDeckId: step.fromDeckId, toDeckId } }
}

/**
 * Reverses one executed step.
 *
 * A folder this migration CREATED is deleted on undo — unlike the old per-move undo, which left them
 * behind. That's safe here only because the journal records the exact folder the migration made and
 * undo runs in reverse order, so anything the migration put inside it has already been moved back
 * out by the time we get here. A folder that existed beforehand is never touched.
 */
export async function undoStep(applied: AppliedStep): Promise<void> {
  const u = applied.undo
  if (u.kind === 'noop') return
  if (u.kind === 'createdFolder') {
    await new SupabaseFolderRepository().softDelete(u.folderId).catch(() => {})
    return
  }
  if (u.kind === 'movedFolder') {
    await new SupabaseFolderRepository().updateParent(u.folderId, u.prevParentId)
    return
  }
  if (u.kind === 'movedDeck') {
    await new SupabaseDeckRepository().update(u.deckId, { folderId: u.prevFolderId })
    return
  }
  const cardRepo = new SupabaseCardRepository()
  const back = await cardRepo.listByDeck(u.fromDeckId)
  await cardRepo.addToDeck(u.fromDeckId, u.cardId, back.length)   // relink source FIRST
  await cardRepo.removeFromDeck(u.toDeckId, u.cardId)
}

export interface RunResult {
  applied: AppliedStep[]
  /** Steps that threw, with the reason — the run continues past them. */
  failed:  { step: MigrationStep; error: string }[]
}

/**
 * Runs the whole plan in order, reporting progress.
 *
 * A failing step does NOT abort the migration: the rest of the plan is usually independent of it, and
 * stopping halfway leaves a library in a state nobody chose. Failures are collected and shown, and
 * everything that did land stays undoable.
 */
export async function runMigration(
  ctx: MigrationContext,
  steps: MigrationStep[],
  onProgress?: (done: number, total: number) => void,
): Promise<RunResult> {
  const applied: AppliedStep[] = []
  const failed: RunResult['failed'] = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    try {
      applied.push(await applyStep(ctx, step))
    } catch (e) {
      failed.push({ step, error: e instanceof Error ? e.message : String(e) })
    }
    onProgress?.(i + 1, steps.length)
  }
  return { applied, failed }
}

/** Reverses an executed migration, newest step first. */
export async function undoMigration(
  applied: AppliedStep[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let i = applied.length - 1; i >= 0; i--) {
    await undoStep(applied[i]!).catch(() => {})
    onProgress?.(applied.length - i, applied.length)
  }
}
