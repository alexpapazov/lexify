/**
 * lib/offline/sync.ts — the reconnect sync engine (Stage 5). Runs when the user toggles OFF offline
 * mode (i.e. goes back online). It drains the outbox to Supabase:
 *
 *   1. Append-only + last-write-wins writes (review/ladder events, overrides, card edits, ladder
 *      climb) are pushed unconditionally.
 *   2. Card-state writes — the study state the user cares about — are conflict-checked: if the server
 *      row changed since the download baseline (studied on another device), the local write is held
 *      back and surfaced as a CardStateConflict for the user to resolve (keep-device / keep-cloud).
 *
 * IMPORTANT: the caller must have already set offline mode OFF before calling — the repos this engine
 * reuses re-route to the local store while offline is active, which would defeat the push.
 */
import { createClient } from '@/lib/supabase/client'
import type { CardState } from '@/domain'
import { getLocalStore } from './localStore'
import { coalesceOutbox, type CoalescedOp } from './coalesce'
import { cardStateToRow, rowToCardState } from '@/lib/data/cardStates'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { SupabaseLadderEventRepository } from '@/lib/data/ladderEvents'
import { SupabaseReviewEventRepository } from '@/lib/data/reviewEvents'
import { SupabaseCardRepository } from '@/lib/data/cards'
import type { ClimbState } from '@/engine/ladderEngine'
import type { LadderEventInput } from '@/lib/data/ladderEvents'
import type { CreateReviewEventInput } from '@/lib/data/interfaces'

export interface CardStateConflict {
  key:       string              // `${cardId}:${direction}`
  cardId:    string
  direction: 'forward' | 'reverse'
  front:     string
  back:      string
  device:    CardState           // the version studied offline
  cloud:     CardState           // the version currently on the server
  cloudUpdatedAt: string | null  // new baseline if the user keeps cloud
  ids:       number[]            // outbox rows backing the device write
}

export type ConflictChoice = 'device' | 'cloud'
export interface SyncProgress { phase: string; done: number; total: number }
export interface SyncResult { pushed: number; conflicts: CardStateConflict[] }

const supa = () => createClient()

function parseKey(key: string): { cardId: string; direction: 'forward' | 'reverse' } {
  const i = key.lastIndexOf(':')
  const cardId = key.slice(0, i)
  const dir = key.slice(i + 1)
  return { cardId, direction: dir === 'reverse' ? 'reverse' : 'forward' }
}

/** Fetch the server card-state row (raw, to read `updated_at`) for one card + direction. */
async function fetchServerState(userId: string, cardId: string, direction: string):
  Promise<{ state: CardState; updatedAt: string | null } | null> {
  const { data } = await supa().from('card_states').select('*')
    .eq('user_id', userId).eq('card_id', cardId).eq('review_direction', direction).maybeSingle()
  if (!data) return null
  return { state: rowToCardState(data), updatedAt: (data.updated_at as string | null) ?? null }
}

/** Push a card-state upsert to the server and return the row's new `updated_at` (the fresh baseline). */
async function pushState(state: CardState): Promise<string | null> {
  const { data, error } = await supa().from('card_states')
    .upsert(cardStateToRow(state), { onConflict: 'user_id,card_id,review_direction' })
    .select('updated_at').single()
  if (error) throw new Error(error.message)
  return (data?.updated_at as string | null) ?? null
}

/** Persist the resolved baseline (and, for keep-cloud, the cloud values) back into the local store. */
async function setLocalBaseline(state: CardState, serverUpdatedAt: string | null): Promise<void> {
  await getLocalStore().putCardState({ ...state, serverUpdatedAt })
}

/** Push everything that isn't conflict-checked (events, overrides, card edits, ladder climb). */
async function pushNonState(userId: string, op: CoalescedOp): Promise<void> {
  const p = op.payload as Record<string, unknown>
  switch (op.entity) {
    case 'reviewEvent': {
      const input = { ...p } as Record<string, unknown>; delete input._localId
      await new SupabaseReviewEventRepository().create(input as unknown as CreateReviewEventInput)
      return
    }
    case 'ladderEvent': {
      const e = { ...p } as Record<string, unknown>; delete e._localId
      await new SupabaseLadderEventRepository().log(userId, e as unknown as LadderEventInput)
      return
    }
    case 'override': {
      const cardId = p.cardId as string, answerSide = p.answerSide as 'front' | 'back', answerText = p.answerText as string
      const repo = new SupabaseTypedAnswerOverrideRepository()
      if (op.op === 'delete') await repo.remove(userId, cardId, answerSide, answerText)
      else                    await repo.add(userId, cardId, answerSide, answerText)
      return
    }
    case 'ladderClimb': {
      const cardId = p.cardId as string
      const repo = new SupabaseLadderClimbRepository()
      if (op.op === 'delete') await repo.remove(userId, cardId)
      else                    await repo.save(userId, cardId, p.deckId as string, p.state as ClimbState)
      return
    }
    case 'card': {
      const id = p.id as string, patch = p.patch as Parameters<SupabaseCardRepository['update']>[1]
      await new SupabaseCardRepository().update(id, patch)
      return
    }
    case 'folderCreate': {
      // A folder created offline (keeping the client-generated id so decks that reference it match).
      const f = p.folder as { id: string; ownerId: string; name: string; parentId: string | null; position: number; sourceLanguage: string | null; targetLanguage: string | null }
      const { error } = await supa().from('folders').upsert({
        id: f.id, owner_id: f.ownerId, name: f.name, parent_id: f.parentId ?? null, position: f.position ?? 0,
        source_language: f.sourceLanguage ?? null, target_language: f.targetLanguage ?? null,
      }, { onConflict: 'id', ignoreDuplicates: true })
      if (error) throw new Error(error.message)
      return
    }
    case 'deckCreate': {
      // A deck created offline (keeping the client-generated id so its cards/links match on the server).
      const d = p.deck as { id: string; ownerId: string; name: string; sourceLanguage: string; targetLanguage: string; pipelineId: string; folderId: string | null; position: number }
      const { error } = await supa().from('decks').upsert({
        id: d.id, owner_id: d.ownerId, name: d.name, source_language: d.sourceLanguage, target_language: d.targetLanguage,
        pipeline_id: d.pipelineId, folder_id: d.folderId ?? null, position: d.position ?? 0,
      }, { onConflict: 'id', ignoreDuplicates: true })
      if (error) throw new Error(error.message)
      return
    }
    case 'deckCardLink': {
      // Link an existing card into an offline-created deck (the merge / "use existing" path).
      const { error } = await supa().from('deck_cards').upsert(
        { deck_id: p.deckId as string, card_id: p.cardId as string, position: (p.position as number) ?? 0 },
        { onConflict: 'deck_id,card_id', ignoreDuplicates: true },
      )
      if (error) throw new Error(error.message)
      return
    }
    case 'cardCreate': {
      // A card created offline: insert it (keeping the client-generated id so local state/links match)
      // and link it into its deck. No card_state — it's unlearned until studied.
      const card = p.card as { id: string; ownerId: string; sourceLanguage: string; targetLanguage: string; front: string; back: string; hints: string[]; position: number }
      const deckId = p.deckId as string
      const db = supa()
      const { error: cardErr } = await db.from('cards').upsert({
        id: card.id, owner_id: card.ownerId, source_language: card.sourceLanguage, target_language: card.targetLanguage,
        front: card.front, back: card.back, hints: card.hints ?? [], position: card.position ?? 0,
      }, { onConflict: 'id', ignoreDuplicates: true })
      if (cardErr) throw new Error(cardErr.message)
      const { error: linkErr } = await db.from('deck_cards').upsert(
        { deck_id: deckId, card_id: card.id, position: card.position ?? 0 },
        { onConflict: 'deck_id,card_id', ignoreDuplicates: true },
      )
      if (linkErr) throw new Error(linkErr.message)
      return
    }
    default:
      return
  }
}

/**
 * Drain the outbox. Cleanly-syncable writes are pushed and cleared; card-state writes that clash with
 * a server-side change are returned as conflicts (their outbox rows are left in place until resolved).
 */
export async function pushOutbox(userId: string, onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
  const store = getLocalStore()
  const entries = await store.outbox()
  if (entries.length === 0) return { pushed: 0, conflicts: [] }

  const ops = coalesceOutbox(entries)
  const stateOps = ops.filter(o => o.entity === 'cardState')
  const otherOps = ops.filter(o => o.entity !== 'cardState')

  const total = ops.length
  let done = 0
  let pushed = 0
  const clearedIds: number[] = []
  const conflicts: CardStateConflict[] = []

  // 1. Non-state writes — always safe.
  for (const op of otherOps) {
    await pushNonState(userId, op)
    clearedIds.push(...op.ids)
    pushed++
    onProgress?.({ phase: 'Uploading reviews', done: ++done, total })
  }

  // 2. Card-state writes — conflict-checked.
  for (const op of stateOps) {
    const { cardId, direction } = parseKey(op.key)
    const baseline = (await store.getCardState(cardId, direction))?.serverUpdatedAt ?? null
    const server = await fetchServerState(userId, cardId, direction)

    const serverChanged = server != null && baseline != null && server.updatedAt !== baseline
    if (op.op === 'upsert' && serverChanged) {
      const card = await store.getCard(cardId)
      conflicts.push({
        key: op.key, cardId, direction,
        front: card?.front ?? '(card)', back: card?.back ?? '',
        device: op.payload as CardState, cloud: server!.state, cloudUpdatedAt: server!.updatedAt,
        ids: op.ids,
      })
      onProgress?.({ phase: 'Checking for conflicts', done: ++done, total })
      continue
    }

    if (op.op === 'delete') {
      await supa().from('card_states').delete()
        .eq('user_id', userId).eq('card_id', cardId).eq('review_direction', direction)
      await store.deleteCardState(cardId, direction)
    } else {
      const newBaseline = await pushState(op.payload as CardState)
      await setLocalBaseline(op.payload as CardState, newBaseline)
    }
    clearedIds.push(...op.ids)
    pushed++
    onProgress?.({ phase: 'Uploading reviews', done: ++done, total })
  }

  if (clearedIds.length) await store.deleteOutbox(clearedIds)
  return { pushed, conflicts }
}

/**
 * Apply the user's per-card resolutions for the conflicts returned by pushOutbox.
 * keep-device → push the offline version; keep-cloud → adopt the server version locally.
 */
export async function resolveConflicts(
  userId: string,
  conflicts: CardStateConflict[],
  choices: Map<string, ConflictChoice>,
): Promise<void> {
  const store = getLocalStore()
  const cleared: number[] = []
  for (const c of conflicts) {
    const choice = choices.get(c.key) ?? 'device'
    if (choice === 'device') {
      const newBaseline = await pushState(c.device)
      await setLocalBaseline(c.device, newBaseline)
    } else {
      // Adopt the server version — discard the offline change, rebase the local baseline.
      await setLocalBaseline(c.cloud, c.cloudUpdatedAt)
    }
    cleared.push(...c.ids)
  }
  if (cleared.length) await store.deleteOutbox(cleared)
}
