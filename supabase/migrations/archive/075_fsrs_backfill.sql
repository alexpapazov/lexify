-- 075_fsrs_backfill.sql
--
-- FSRS Due Now scheduler (Stage 3): one-time backfill of Difficulty + Stability
-- for cards that graduated before FSRS existed. Without this, each old card seeds
-- its D/S lazily on its next review (engine/dueNow.ts: seedDifficulty/seedStability);
-- this migration just does it for all of them up front so the estimates exist now.
--
-- The formulas mirror the engine's lazy seed exactly:
--   difficulty = clamp(5 + 0.7 * lapses, 1, 10)
--   stability  = max(0.5, current interval for the track, defaulting to 1 day)
-- Forward rows are primarily reviewed on the typed/production track, reverse rows
-- on the recall track — so the seed interval is chosen per direction to match what
-- scheduleGraduatedFsrs() would have passed in.
--
-- Idempotent: only touches graduated rows that have not been seeded or reviewed
-- under FSRS yet (difficulty/stability still NULL), so re-running is a no-op and it
-- never overwrites a card that already has a real, reviewed FSRS state.

UPDATE card_states
SET
  difficulty = LEAST(10, GREATEST(1, 5 + 0.7 * COALESCE(lapses, 0))),
  stability  = GREATEST(0.5,
    CASE
      WHEN review_direction = 'reverse'
        THEN COALESCE(recall_interval_days, interval_days, 1)
      ELSE COALESCE(typed_interval_days, interval_days, 1)
    END)
WHERE graduated = true
  AND (difficulty IS NULL OR stability IS NULL);
