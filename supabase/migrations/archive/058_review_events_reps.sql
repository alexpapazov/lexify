-- Phase 3: track the card's post-graduation review count at the time of each
-- review event, so calibration can isolate first-review failure rates.
-- reps = CardState.reps at event creation time (before progressAfterReview runs).
-- Pre-graduation events default to 0; first post-graduation review = 1.

ALTER TABLE review_events
  ADD COLUMN reps INT NOT NULL DEFAULT 0;
