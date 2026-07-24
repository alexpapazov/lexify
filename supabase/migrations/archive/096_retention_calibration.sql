-- 096_retention_calibration.sql
-- Per-track FSRS interval calibration derived from measured-vs-target retention.
--
-- When a track's MEASURED recent retention is higher than the pair's TARGET (request_retention),
-- the stock FSRS weights are underestimating the learner's memory: intervals are shorter than they
-- need to be to hit even the target. The calibrate route now stores a per-answer_field multiplier
-- (retention_calibration) = ln(target) / ln(measured), clamped, which the scheduler applies to the
-- scheduled interval — stretching intervals when the learner over-performs, shrinking them when they
-- under-perform, all at the SAME target retention. 1.0 = no adjustment (default / not enough data).
ALTER TABLE user_scheduler_params
  ADD COLUMN IF NOT EXISTS retention_calibration REAL NOT NULL DEFAULT 1.0;
