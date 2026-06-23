/**
 * lib/syncFolderInfra.ts
 *
 * Ensures the stable folder / deck infrastructure for a language sync direction.
 * Each destination language pair gets its OWN "SYNCED VOCABULARY" folder so
 * it only appears in that language's library view.
 *
 * Folder structure (one per destination pair):
 *
 *   SYNCED VOCABULARY/        ← per-destination-pair root folder
 *     Spanish                 ← deck named after the source language
 *
 * The IDs are stored in `language_sync_state` so the same folder/deck are
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
const SYNC_FOLDER_NAME    = 'SYNCED VOCABULARY'

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
    // Verify both the deck and folder still exist
    const [{ data: deck }, { data: folder }] = await Promise.all([
      db.from('decks').select('id').eq('id', existing.deck_id).is('deleted_at', null).maybeSingle(),
      db.from('folders').select('id').eq('id', existing.root_folder_id).is('deleted_at', null).maybeSingle(),
    ])
    if (deck && folder) {
      return {
        rootFolderId: existing.root_folder_id as string,
        subFolderId:  existing.sub_folder_id  as string,
        deckId:       existing.deck_id        as string,
      }
    }
    // Stale — clear and recreate below
    await db
      .from('language_sync_state')
      .delete()
      .eq('user_id', userId)
      .eq('source_pair_id', sourcePair.id)
      .eq('destination_pair_id', destPair.id)
  }

  const folderRepo = new SupabaseFolderRepository()
  const deckRepo   = new SupabaseDeckRepository()

  // 2. Create a new "SYNCED VOCABULARY" folder for THIS destination pair
  const root = await folderRepo.create(userId, SYNC_FOLDER_NAME, null)
  const rootFolderId = root.id

  // 3. Create the deck named after the source language
  const deckName = langName(sourcePair.sourceLanguage)
  const deck = await deckRepo.create(userId, {
    name:           deckName,
    sourceLanguage: destPair.sourceLanguage,
    targetLanguage: destPair.targetLanguage,
    pipelineId:     DEFAULT_PIPELINE_ID,
  })
  await deckRepo.update(deck.id, { folderId: rootFolderId })

  // 4. Persist so future syncs reuse this folder/deck
  await db.from('language_sync_state').upsert({
    user_id:              userId,
    source_pair_id:       sourcePair.id,
    destination_pair_id:  destPair.id,
    root_folder_id:       rootFolderId,
    sub_folder_id:        rootFolderId,
    deck_id:              deck.id,
  }, { onConflict: 'user_id,source_pair_id,destination_pair_id' })

  return { rootFolderId, subFolderId: rootFolderId, deckId: deck.id }
}
