-- =============================================================================
-- 024_stage3_same_day_window.sql
--
-- Tracks the "same-day window" for the final 3 pipeline steps (stages 3-5 in
-- the default 5-step pipeline: typing back->front x2, typing front->back x2,
-- final front->back recognition x1). All three of these steps must be
-- completed on the same calendar day for a card to graduate — if a later
-- step in the window is completed on a different day, the engine sends the
-- card back to the window's first step (stage 3) and restarts the window.
--
-- `stage3_entered_date` (ISO date, YYYY-MM-DD) records the day the card most
-- recently entered this window. Null for cards that haven't reached it yet
-- (or pre-date this column) — engine/pipeline.ts treats null as "no
-- same-day check yet" for backward compatibility with in-flight cards.
-- =============================================================================

ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS stage3_entered_date DATE;
