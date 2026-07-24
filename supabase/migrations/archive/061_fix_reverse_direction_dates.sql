-- Migration 061: Fix reverse-direction card due dates (Option A)
--
-- Previously, reverse CardState rows were created with:
--   due_at = now + interval/2 days
--
-- This caused forward and reverse cards for the same word to cluster on the
-- same day, especially when both are overdue (both snap to today).
--
-- Option A fix: reverse should be due AFTER the forward's next review:
--   due_at = GREATEST(fwd.due_at, NOW()) + round(forward.interval_days / 2) days
--
-- Using GREATEST(fwd.due_at, NOW()) as anchor means overdue forward cards
-- project the reverse into the future rather than leaving it in the past too.
--
-- We fix all reverse cards that are currently due on or before their forward's
-- next due date (i.e. all cards initialized with the old formula).

UPDATE card_states AS rev
SET
  due_at        = (GREATEST(fwd.due_at, NOW()) + (GREATEST(1, ROUND(COALESCE(fwd.typed_interval_days, fwd.interval_days) / 2.0)) * INTERVAL '1 day'))::timestamptz,
  recall_due_at = (GREATEST(fwd.due_at, NOW()) + (GREATEST(1, ROUND(COALESCE(fwd.typed_interval_days, fwd.interval_days) / 2.0)) * INTERVAL '1 day'))::timestamptz,
  updated_at    = NOW()
FROM card_states AS fwd
WHERE
  rev.card_id               = fwd.card_id
  AND rev.user_id           = fwd.user_id
  AND rev.review_direction  = 'reverse'
  AND fwd.review_direction  IS DISTINCT FROM 'reverse'
  -- Fix any reverse card due on or before the forward's due date
  AND rev.due_at            <= fwd.due_at
  AND rev.graduated         = true
  AND fwd.graduated         = true;
