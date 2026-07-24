-- Phase 2: post-acceleration pipeline-restart window tracking.
-- When a card's accelerated_mode transitions 'import_known' → 'none' (2 consecutive
-- wrong answers on the fast track), the next 3 production attempts enter a restart
-- window.  If 2 or more of those 3 are wrong, the pipeline restarts from step 0.

ALTER TABLE card_states
  ADD COLUMN post_accel_restart_window INT NOT NULL DEFAULT 0,
  ADD COLUMN post_accel_wrong_count    INT NOT NULL DEFAULT 0;
