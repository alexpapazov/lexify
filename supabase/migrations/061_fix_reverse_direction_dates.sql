-- Migration 061: Fix reverse-direction card due dates (Option A)
--
-- Previously, reverse CardState rows were created with:
--   due_at = now + interval/2 days
--
-- This caused forward and reverse cards for the same word to cluster on the
-- same day (especially for overdue cards that both snap to today).
--
-- Option A fix: reverse should be due AFTER the forward's next review, at:
--   due_at = forward.due_at + round(forward.interval_days / 2) days
--
-- This migration pushes any reverse card whose due date is on or before its
-- corresponding forward card's due date out to the correct position.

UPDATE card_states AS rev
SET
  due_at        = (fwd.due_at + (GREATEST(1, ROUND(COALESCE(fwd.typed_interval_days, fwd.interval_days) / 2.0)) * INTERVAL '1 day'))::timestamptz,
  recall_due_at = (fwd.due_at + (GREATEST(1, ROUND(COALESCE(fwd.typed_interval_days, fwd.interval_days) / 2.0)) * INTERVAL '1 day'))::timestamptz,
  updated_at    = NOW()
FROM card_states AS fwd
WHERE
  -- Match reverse row to its forward counterpart
  rev.card_id          = fwd.card_id
  AND rev.user_id      = fwd.user_id
  AND rev.review_direction  = 'reverse'
  AND fwd.review_direction IS DISTINCT FROM 'reverse'
  -- Only fix rows where reverse is due on or before the forward's next review
  -- (these are the ones initialized with the old "now + interval/2" formula)
  AND rev.due_at <= fwd.due_at
  -- Only touch graduated reverse cards
  AND rev.graduated = true
  AND fwd.graduated = true;
