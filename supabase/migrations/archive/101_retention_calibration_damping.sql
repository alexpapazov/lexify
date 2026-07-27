-- Retention-calibration damping (Stage A).
-- Adds a per-track timestamp so the interval multiplier can be actuated at most ~once/day (the
-- measurement still refreshes every session), turning the former replace-outright controller into a
-- slow, slew-rate-limited one. Also reins in any currently-inflated multipliers into the new tighter
-- [0.7, 1.5] band up front, so we start damping from a sane state instead of creeping down for days.

ALTER TABLE user_scheduler_params
  ADD COLUMN IF NOT EXISTS retention_calibration_at TIMESTAMPTZ;

UPDATE user_scheduler_params
  SET retention_calibration = LEAST(1.5, GREATEST(0.7, retention_calibration))
  WHERE retention_calibration IS NOT NULL
    AND (retention_calibration > 1.5 OR retention_calibration < 0.7);
