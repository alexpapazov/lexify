-- 078_migrate_typing_to_smart.sql
--
-- One-time move: every card currently on the typed-production track becomes a
-- smart-typing card, and every pair that had typed production enabled switches to
-- smart typing enabled (typed disabled) — keeping the mutual exclusivity invariant.
--
-- Safe to run once. Re-running is a near-no-op: the card move only affects rows that
-- still have a typed schedule, and the flag flip is idempotent.

-- 1a. Move each forward card's typed schedule into the smart-typing columns and clear
--     the typed ones. Shared FSRS difficulty/stability and dueAt are left as-is
--     (dueAt already mirrors the typed due date, so it now mirrors the smart one).
UPDATE card_states
SET smart_interval_days = typed_interval_days,
    smart_due_at        = typed_due_at,
    typed_interval_days = NULL,
    typed_due_at        = NULL
WHERE typed_due_at IS NOT NULL;

-- 1b. Legacy graduated forward cards (pre-dual-track: only a general due_at, no typed
--     or recall track) also count as typed production today, so move them to smart too —
--     otherwise disabling typed below would ghost them out of Due Now.
UPDATE card_states
SET smart_interval_days = COALESCE(scheduled_interval_days, interval_days, 1),
    smart_due_at        = due_at
WHERE graduated = true
  AND review_direction = 'forward'
  AND typed_due_at IS NULL
  AND smart_due_at IS NULL
  AND recall_due_at IS NULL
  AND due_at IS NOT NULL;

-- 2. Create a forward_smart params row for every pair that has a forward_typed row,
--    carrying over whether typed production was enabled. Unlisted columns take their
--    defaults (smart lane calibration starts at default).
INSERT INTO user_scheduler_params
  (user_id, source_language, target_language, answer_field, forward_smart_enabled)
SELECT user_id, source_language, target_language, 'forward_smart', forward_typed_enabled
FROM user_scheduler_params
WHERE answer_field = 'forward_typed'
ON CONFLICT (user_id, source_language, target_language, answer_field)
DO UPDATE SET forward_smart_enabled = EXCLUDED.forward_smart_enabled;

-- 3. Disable the typed-production track everywhere (smart typing now owns it).
UPDATE user_scheduler_params
SET forward_typed_enabled = false
WHERE answer_field = 'forward_typed';
