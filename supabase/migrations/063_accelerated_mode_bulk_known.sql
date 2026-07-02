-- Allow 'bulk_known' as an accelerated_mode value.
--
-- Cards graduated in bulk via "Graduate selected" (without the accelerated
-- track) are marked 'bulk_known' — "I already knew these words". They use
-- normal (non-accelerated) scheduling and are excluded from daily goal counts.
-- The original CHECK constraint (migration 045) only permitted
-- ('none', 'import_known'), so inserting a bulk_known row failed with
-- card_states_accelerated_mode_check.

ALTER TABLE card_states
  DROP CONSTRAINT IF EXISTS card_states_accelerated_mode_check;

ALTER TABLE card_states
  ADD CONSTRAINT card_states_accelerated_mode_check
  CHECK (accelerated_mode IN ('none', 'import_known', 'bulk_known'));
