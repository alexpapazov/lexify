/**
 * lib/syncFolderInfra.ts
 *
 * Ensures a deck exists for today's sync batch. No folders are created —
 * synced cards land directly in the language's library root with the date
 * as the deck name (e.g. "2026-06-28").
 *
 * Intra-day syncs reuse the same deck. The next day a new deck is created.
 */

import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import type { LanguagePair } from '@/domain'

interface SyncInfra {
  deckId: string
}

const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'

export async function ensureSyncInfra(
  userId: string,
  sourcePair: LanguagePair,
  destPair: LanguagePair,
): Promise<SyncInfra> {
  const db    = createClient()
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  // Reuse today's deck if one already exists for this sync direction
  const { data: existing } = await db
    .from('language_sync_state')
    .select('deck_id, sync_date')
    .eq('user_id', userId)
    .eq('source_pair_id', sourcePair.id)
    .eq('destination_pair_id', destPair.id)
    .maybeSingle()

  if (existing?.sync_date === today) {
    const { data: deck } = await db
      .from('decks')
      .select('id')
      .eq('id', existing.deck_id)
      .is('deleted_at', null)
      .maybeSingle()
    if (deck) return { deckId: existing.deck_id as string }
  }

  // Create a new deck for today — no folder, sits at the library root
  const deckRepo = new SupabaseDeckRepository()
  const deck = await deckRepo.create(userId, {
    name:           today,
    sourceLanguage: destPair.sourceLanguage,
    targetLanguage: destPair.targetLanguage,
    pipelineId:     DEFAULT_PIPELINE_ID,
  })

  await db.from('language_sync_state').upsert({
    user_id:              userId,
    source_pair_id:       sourcePair.id,
    destination_pair_id:  destPair.id,
    deck_id:              deck.id,
    root_folder_id:       null,
    sub_folder_id:        null,
    sync_date:            today,
  }, { onConflict: 'user_id,source_pair_id,destination_pair_id' })

  return { deckId: deck.id }
}
