/**
 * lib/syncFolderInfra.ts
 *
 * Ensures the stable folder / deck infrastructure for a language sync direction.
 * Folder structure (in the destination language pair's section):
 *
 *   Synced/                 ← root folder, shared across all source pairs → this dest pair
 *     Spanish               ← deck named after the source language, lives directly in root
 *
 * The IDs are stored in `language_sync_state` so the same folders/deck are
 * reused on every subsequent sync — no duplicates from re-running.
 */

import { createClient } from '@/lib/supabase/client'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import type { LanguagePair } from '@/domain'
import { langName } from '@/lib/languages'

export interface SyncInfra {
  rootFolderId: string
  subFolderId:  string  // same as rootFolderId (no sub-folder)
  deckId:       string
}

const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'

export async function ensureSyncInfra(
  userId: string,
  sourcePair: LanguagePair,
  destPair: LanguagePair,
): Promise<SyncInfra> {
  const db = createClient()

  // 1. Return immediately if stable infra already exists for this direction
  const { data: existing } = await db
    .from('language_sync_state')
    .select('root_folder_id, sub_folder_id, deck_id')
    .eq('user_id', userId)
    .eq('source_pair_id', sourcePair.id)
    .eq('destination_pair_id', destPair.id)
    .maybeSingle()

  if (existing) {
    return {
      rootFolderId: existing.root_folder_id as string,
      subFolderId:  existing.sub_folder_id as string,
      deckId:       existing.deck_id as string,
    }
  }

  const folderRepo = new SupabaseFolderRepository()
  const deckRepo   = new SupabaseDeckRepository()

  // 2. Find existing "Synced" root folder for this dest pair from another direction
  const { data: sibling } = await db
    .from('language_sync_state')
    .select('root_folder_id')
    .eq('user_id', userId)
    .eq('destination_pair_id', destPair.id)
    .limit(1)
    .maybeSingle()

  let rootFolderId: string
  if (sibling) {
    rootFolderId = sibling.root_folder_id as string
  } else {
    const root = await folderRepo.create(userId, 'Synced', null)
    rootFolderId = root.id
  }

  // 3. Create the deck named after the source language directly inside root (no sub-folder)
  const deckName = langName(sourcePair.sourceLanguage)
  const deck = await deckRepo.create(userId, {
    name:           deckName,
    sourceLanguage: destPair.sourceLanguage,
    targetLanguage: destPair.targetLanguage,
    pipelineId:     DEFAULT_PIPELINE_ID,
  })
  await deckRepo.update(deck.id, { folderId: rootFolderId })

  // 4. Persist the infra so future syncs in this direction reuse it
  await db.from('language_sync_state').upsert({
    user_id:              userId,
    source_pair_id:       sourcePair.id,
    destination_pair_id:  destPair.id,
    root_folder_id:       rootFolderId,
    sub_folder_id:        rootFolderId,  // no sub-folder; store root in both columns
    deck_id:              deck.id,
  }, { onConflict: 'user_id,source_pair_id,destination_pair_id' })

  return { rootFolderId, subFolderId: rootFolderId, deckId: deck.id }
}
