/**
 * lib/offline/localRepos.ts — local-store implementations of the repo methods used on the STUDY path,
 * plus outbox queuing for every write. The Supabase repos delegate here when offline mode is active
 * (see the `isOfflineActive()` guards in lib/data/*), so the study pages/ladder never change.
 *
 * Reads come straight from the local store. Writes update the local store AND append to the outbox,
 * which the sync engine (Stage 5) pushes to Supabase when you go back online.
 */
import type { Card, CardState, Ladder, TypedAnswerOverride, LanguagePair } from '@/domain'
import type { ClimbState } from '@/engine/ladderEngine'
import type { LadderEventInput } from '@/lib/data/ladderEvents'
import type { SchedulerParamsRow } from '@/lib/data/userSchedulerParams'
import { getLocalStore } from './localStore'
import { ladderKey, overrideKey } from './keys'
import type { OutboxEntity } from './types'

const nowIso = () => new Date().toISOString()
let localSeq = 0
const localId = () => `local-${Date.now()}-${localSeq++}`

async function enqueue(entity: OutboxEntity, key: string, op: 'upsert' | 'insert' | 'delete', payload: unknown): Promise<void> {
  await getLocalStore().enqueue({ entity, key, op, payload, localUpdatedAt: nowIso() })
}

// ── Reads ─────────────────────────────────────────────────────────────────────
export const localDecks       = () => getLocalStore().allDecks()
export const localGetDeck     = async (id: string) => (await getLocalStore().allDecks()).find(d => d.id === id)
export const localFolders     = () => getLocalStore().allFolders()
export const localCardsByDeck = (deckId: string) => getLocalStore().cardsForDeck(deckId)
export const localGetCard     = (id: string) => getLocalStore().getCard(id)

export async function localCardStatesByDeck(deckId: string): Promise<CardState[]> {
  return getLocalStore().cardStatesForDeck(deckId)
}
export async function localClimbForCards(cardIds: string[]): Promise<Map<string, ClimbState>> {
  const rows = await getLocalStore().climbForCards(cardIds)
  return new Map(rows.map(r => [r.cardId, r.state as ClimbState]))
}
export async function localLadderForPair(source: string, target: string): Promise<Ladder | null> {
  return ((await getLocalStore().getLadder(ladderKey(source, target)))?.ladder as Ladder) ?? null
}
export async function localLadderDefault(): Promise<Ladder | null> {
  return ((await getLocalStore().getLadder('default'))?.ladder as Ladder) ?? null
}
export async function localSchedulerParams(): Promise<SchedulerParamsRow[]> {
  return (await getLocalStore().allSchedulerParams()).map(p => p.row as SchedulerParamsRow)
}
export async function localOverridesForUser(): Promise<Omit<TypedAnswerOverride, 'userId'>[]> {
  return (await getLocalStore().allOverrides()).map(o => ({ cardId: o.cardId, answerSide: o.answerSide as TypedAnswerOverride['answerSide'], answerText: o.answerText }))
}
/** Offline language pairs are derived from the downloaded decks (each carries source/target). No
 *  custom goals/flags offline — enough for the dashboard/library to render and route into study. */
export async function localLanguagePairs(userId: string): Promise<LanguagePair[]> {
  const decks = await getLocalStore().allDecks()
  const seen = new Map<string, LanguagePair>()
  let pos = 0
  for (const d of decks) {
    const key = `${d.sourceLanguage}|${d.targetLanguage}`
    if (seen.has(key)) continue
    seen.set(key, {
      id: key, ownerId: userId, sourceLanguage: d.sourceLanguage, targetLanguage: d.targetLanguage,
      position: pos++, flag: null, instructions: null, createdAt: '', goals: null,
    })
  }
  return [...seen.values()]
}
export async function localConfusionLinksForUser(): Promise<Record<string, unknown>[]> {
  return getLocalStore().allConfusionLinks()
}

// ── Writes (local store + outbox) ──────────────────────────────────────────────
export async function localUpsertCardState(state: CardState): Promise<CardState> {
  // Preserve the download-time server baseline (serverUpdatedAt) across offline edits so the sync
  // engine can still tell whether the server row changed while we were offline (→ conflict).
  const existing = await getLocalStore().getCardState(state.cardId, state.reviewDirection)
  await getLocalStore().putCardState({ ...state, serverUpdatedAt: existing?.serverUpdatedAt ?? null })
  await enqueue('cardState', `${state.cardId}:${state.reviewDirection}`, 'upsert', state)
  return state
}
export async function localDeleteCardState(cardId: string, reviewDirection: string): Promise<void> {
  await getLocalStore().deleteCardState(cardId, reviewDirection)
  await enqueue('cardState', `${cardId}:${reviewDirection}`, 'delete', { cardId, reviewDirection })
}
export async function localSaveClimb(cardId: string, deckId: string, state: ClimbState): Promise<void> {
  await getLocalStore().putClimb({ cardId, deckId, state, serverUpdatedAt: null })
  await enqueue('ladderClimb', cardId, 'upsert', { cardId, deckId, state })
}
export async function localRemoveClimb(cardId: string): Promise<void> {
  await getLocalStore().removeClimb(cardId)
  await enqueue('ladderClimb', cardId, 'delete', { cardId })
}
export async function localLogLadderEvent(e: LadderEventInput): Promise<string> {
  const id = localId()
  await enqueue('ladderEvent', id, 'insert', { ...e, _localId: id })
  return id
}
export async function localDeleteLadderEvent(id: string): Promise<void> {
  // The event only exists in the outbox (offline) — drop the pending insert so undo leaves no trace.
  const pending = (await getLocalStore().outbox()).filter(o => o.entity === 'ladderEvent' && o.key === id && o.id != null)
  if (pending.length) await getLocalStore().deleteOutbox(pending.map(o => o.id!))
}
export async function localCreateReviewEvent(input: unknown): Promise<string> {
  const id = localId()
  await enqueue('reviewEvent', id, 'insert', { ...(input as object), _localId: id })
  return id
}
export async function localDeleteReviewEvent(id: string): Promise<void> {
  // The event only exists in the outbox offline — drop the pending insert so undo leaves no trace.
  const pending = (await getLocalStore().outbox()).filter(o => o.entity === 'reviewEvent' && o.key === id && o.id != null)
  if (pending.length) await getLocalStore().deleteOutbox(pending.map(o => o.id!))
}
export async function localAddOverride(cardId: string, answerSide: string, answerText: string): Promise<void> {
  await getLocalStore().putOverride({ key: overrideKey(cardId, answerSide, answerText), cardId, answerSide, answerText })
  await enqueue('override', overrideKey(cardId, answerSide, answerText), 'insert', { cardId, answerSide, answerText })
}
export async function localRemoveOverride(cardId: string, answerSide: string, answerText: string): Promise<void> {
  await getLocalStore().deleteOverride(overrideKey(cardId, answerSide, answerText))
  await enqueue('override', overrideKey(cardId, answerSide, answerText), 'delete', { cardId, answerSide, answerText })
}
export async function localUpdateCard(id: string, patch: Partial<Card>): Promise<Card> {
  const existing = await getLocalStore().getCard(id)
  const updated = { ...(existing as Card), ...patch, id }
  await getLocalStore().putCard(updated)
  await enqueue('card', id, 'upsert', { id, patch })
  return updated
}
