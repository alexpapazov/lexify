-- Migration 009: ensure the decks "owner update" RLS policy allows soft-deletes.
--
-- Soft-deleting a deck (SupabaseDeckRepository.softDelete) does:
--   UPDATE decks SET deleted_at = now() WHERE id = :deckId
--
-- If the live "decks: owner update" policy's check clause requires
-- `deleted_at IS NULL` (e.g. copied from the owner-select policy), the
-- resulting row (with deleted_at set) fails that check and Postgres raises:
--   "new row violates row-level security policy for table \"decks\""
--
-- Recreate the policy based on ownership only, so owners can update any
-- field on their own decks — including setting deleted_at.
DROP POLICY IF EXISTS "decks: owner update" ON decks;
CREATE POLICY "decks: owner update" ON decks
  FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);
