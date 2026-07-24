-- =============================================================================
-- 014_cards_per_session_and_typing_step.sql
--
-- 1. Adds cards_per_session to user_deck_preferences — an optional per-deck
--    override that caps how many cards may be "in the pipeline" (introduced
--    but not yet graduated) at once. When set, the session introduces new
--    cards only as earlier ones graduate, in batches of this size, instead
--    of using the calendar-day-based daily_new_cards/spillover logic.
--
-- 2. Adds a fourth step to the default pipeline: a typing step where the
--    target-language term is shown (front) and the learner must type the
--    native-language translation (back) — complementing the existing
--    typing step (back -> front).
-- =============================================================================

ALTER TABLE user_deck_preferences
  ADD COLUMN IF NOT EXISTS cards_per_session INTEGER;

INSERT INTO pipeline_steps (pipeline_id, step_order, step_type, prompt_side, answer_side, required_correct)
VALUES ('00000000-0000-0000-0000-000000000001', 3, 'typing', 'front', 'back', 2)
ON CONFLICT (pipeline_id, step_order) DO NOTHING;
