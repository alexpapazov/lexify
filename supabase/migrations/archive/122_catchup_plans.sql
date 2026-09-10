-- Catch-up plans: the thin record that makes a spread followable.
--
-- Spreading a backlog is a one-shot write to due dates. This stores just enough to track it: a
-- progress bar ("51 of 81 done") and a Reassign button that re-levels whatever is still owed.
--
--   {"bg|en:sgReverse": {"targetDate": "2026-09-05", "startedOn": "2026-08-22", "total": 81}}
--
-- ALL THREE FIELDS ARE HISTORICAL FACTS about the moment the plan was made, and none of them ever
-- changes. How many are LEFT is never stored — it is derived from the live cards on every read
-- (lib/catchUpPlan.ts: isOwedByPlan). That split is deliberate and load-bearing: an earlier version
-- of this feature stored a changing quantity and went stale the moment reality diverged from it.
-- Store what happened; derive what is true now. Do not add a "remaining" or "done" field here.
--
-- Which cards a plan claimed is likewise NOT stored. `scheduled_interval_days` already records the
-- gap between last_reviewed_at and due_at, so a card pushed out without a review is detectable by
-- arithmetic — see the note in lib/catchUpPlan.ts.
--
-- Idempotent, and named the same column as the deleted 121 so an account that already ran that one
-- keeps whatever is there (the shape is a superset — 121 stored only targetDate, and a record
-- missing startedOn/total is ignored rather than trusted).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS catchup_plans JSONB NOT NULL DEFAULT '{}'::jsonb;
