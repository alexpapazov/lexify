-- 068_card_dormancy.sql
--
-- Card dormancy: after a set number of production (Due Now) reviews a card can go
-- "dormant" — it stays in the deck and is manually reviewable, but never becomes
-- due automatically again. Can also be toggled manually from the card's info menu.
--
-- dormant           — true = excluded from all Due Now queues/counts/forecast.
-- dormancy_threshold — after this many production reviews the card auto-goes dormant
--                      (null = never). Canonical on the forward row.

ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS dormant BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dormancy_threshold INTEGER;

CREATE INDEX IF NOT EXISTS card_states_dormant_idx
  ON card_states(user_id, dormant) WHERE dormant = TRUE;
