-- 127_implicit_credit.sql — reading-sighting credit (Media Intake Stage B).
--
-- `last_implicit_at`: when this row last received IMPLICIT credit — a passive sighting of the
-- word in logged media (book page read, word NOT marked) applied as a schedule-only advance.
-- Gates the one-credit-per-row-per-day cap. Implicit credit writes NO review_events row (it is
-- not a recall — keeping it out of review_events keeps measured retention, calibration, and the
-- analytics charts honest by construction); the media entry log is its audit trail.

ALTER TABLE card_states ADD COLUMN IF NOT EXISTS last_implicit_at TIMESTAMPTZ;
