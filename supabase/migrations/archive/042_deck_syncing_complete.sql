-- Migration 042: track whether a synced deck has finished Phase 2 translation
--
-- syncing_complete = false means this deck was created by the language sync
-- system and still has pending (blank) cards waiting for AI translation.
-- While false, the app will opportunistically call the fill API whenever
-- the user opens the deck, starts a study session, or saves a card.
-- Once all pending synced_card_links for this user are filled (remaining = 0),
-- syncing_complete is set to true and retries stop.
--
-- Default is true so that all existing (non-synced) decks are unaffected.

ALTER TABLE decks ADD COLUMN IF NOT EXISTS syncing_complete BOOLEAN NOT NULL DEFAULT true;
