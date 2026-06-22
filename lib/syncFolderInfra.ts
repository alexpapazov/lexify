/**
 * lib/syncFolderInfra.ts
 *
 * Ensures the stable folder / deck infrastructure for a language sync direction.
 * Folder structure (in the destination language pair's section):
 *
 *   synced/                         ← root, shared across all source pairs going into this dest pair
 *     [Source language name]/       ← sub-folder, one per source language
 *       (synced deck lives here)
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
  subFolderId:  string
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

  // 2. Find existing "synced" root folder for this dest pair from another direction
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
    const root = await folderRepo.create(userId, 'synced', null)
    rootFolderId = root.id
  }

  // 3. Create the sub-folder named after the source language (English name)
  const subFolderName = langName(sourcePair.sourceLanguage)
  const sub = await folderRepo.create(userId, subFolderName, rootFolderId)

  // 4. Create the synced deck (dest pair's source/target languages) in the sub-folder
  const deckName = `Synced from ${langName(sourcePair.sourceLanguage)}`
  const deck = await deckRepo.create(userId, {
    name:           deckName,
    sourceLanguage: destPair.sourceLanguage,
    targetLanguage: destPair.targetLanguage,
    pipelineId:     DEFAULT_PIPELINE_ID,
  })
  await deckRepo.update(deck.id, { folderId: sub.id })

  // 5. Persist the infra so future syncs in this direction reuse it
  await db.from('language_sync_state').upsert({
    user_id:              userId,
    source_pair_id:       sourcePair.id,
    destination_pair_id:  destPair.id,
    root_folder_id:       rootFolderId,
    sub_folder_id:        sub.id,
    deck_id:              deck.id,
  }, { onConflict: 'user_id,source_pair_id,destination_pair_id' })

  return { rootFolderId, subFolderId: sub.id, deckId: deck.id }
}
