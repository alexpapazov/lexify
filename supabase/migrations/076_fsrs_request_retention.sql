-- 076_fsrs_request_retention.sql
--
-- FSRS Due Now scheduler (Stage 4): per-language-pair target retention.
-- Higher retention = shorter intervals, more reviews, better recall. Default 0.90
-- (the value FSRS was hardcoded to in Stages 2–3). The UI slider clamps to
-- 0.80–0.95; the engine also clamps effective retention to [0.70, 0.97].
-- Canonical on the forward_typed answer_field row (like the strictness levels).

ALTER TABLE user_scheduler_params
  ADD COLUMN IF NOT EXISTS request_retention real NOT NULL DEFAULT 0.90;
