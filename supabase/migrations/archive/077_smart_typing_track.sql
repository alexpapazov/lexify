-- 077_smart_typing_track.sql
--
-- "Smart typing" — a new independent forward-production review track. It mirrors
-- the typed-production lane (own due date + interval, shares the row's FSRS
-- difficulty/stability) but is presented as TYPED while its interval is below the
-- pair's threshold, then SELF-GRADED once past it (and back to typed if it drops
-- below again). It is mutually exclusive with the typed-production track per pair
-- (enforced in the UI). Its enable flag is canonical on the 'forward_smart'
-- answer_field row; the threshold is canonical on the 'forward_typed' row.
--
-- Data move of existing typed cards → smart typing is a separate migration (078).

-- Per-card smart-typing schedule (forward rows only; null when not on the track).
ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS smart_interval_days real,
  ADD COLUMN IF NOT EXISTS smart_due_at        timestamptz;

-- Per-pair enable flag (canonical on the forward_smart row) + threshold in days
-- (canonical on the forward_typed row, like retention/strictness).
ALTER TABLE user_scheduler_params
  ADD COLUMN IF NOT EXISTS forward_smart_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS smart_typing_threshold_days  integer NOT NULL DEFAULT 20;
