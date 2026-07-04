-- Calibration accuracy improvements.

-- ── Part 1: near-miss lenience ──────────────────────────────────────────────
-- Marks a review where the typed answer was an "almost" (accent/typo/article
-- slip) rather than a clean miss. The calibrator weights these as only 0.2 of
-- an error (worth 0.8 of a correct) so spelling slips don't shrink the schedule.
ALTER TABLE review_events
  ADD COLUMN IF NOT EXISTS near_miss BOOLEAN NOT NULL DEFAULT false;

-- ── Part 2: per-error-count graduation interval calibration ─────────────────
-- Running count of pipeline struggles (typing mistakes + "?" + Repeat) for a
-- card that's still in the learning pipeline; accumulates across sessions.
ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS pipeline_error_count   INTEGER NOT NULL DEFAULT 0;
-- Snapshot of pipeline_error_count at the moment the card graduated — the
-- bucket its first-review performance feeds into for grad-interval calibration.
ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS graduation_error_count INTEGER NOT NULL DEFAULT 0;

-- Denormalized onto each review of a graduated card so the calibrator can
-- bucket first-post-graduation reviews by error count without a join.
ALTER TABLE review_events
  ADD COLUMN IF NOT EXISTS graduation_error_count INTEGER NOT NULL DEFAULT 0;

-- Graduation-interval [min,max] buckets for 4,5,6,7 errors (individual) and
-- 8+ errors (the "8err" bucket is a catch-all for 8, 9, 10, …). Buckets 0–3
-- already exist. Defaults taper toward the 1-day floor; calibration moves them.
ALTER TABLE user_scheduler_params
  ADD COLUMN IF NOT EXISTS grad_interval_4err_min INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS grad_interval_4err_max INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS grad_interval_5err_min INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS grad_interval_5err_max INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS grad_interval_6err_min INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS grad_interval_6err_max INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS grad_interval_7err_min INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS grad_interval_7err_max INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS grad_interval_8err_min INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS grad_interval_8err_max INTEGER NOT NULL DEFAULT 1;
