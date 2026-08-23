-- Catch-up plans: drain a review backlog by a date you choose.
--
-- ONLY THE TARGET DATE IS STORED. Everything the feature shows — today's quota, which cards, how far
-- behind you are — is DERIVED from the live backlog and recomputed each day (see lib/catchUp.ts).
--
-- This is the same rule as goal_full_debt_resets (migration 109) and for the same reason: a stored
-- "cards remaining" counter goes stale the instant you overshoot, fall short, or a relearn lands, and
-- the plan then quietly lies to you. Recomputing from the real backlog self-corrects — overshoot today
-- and tomorrow's number drops on its own. Do NOT add a progress counter here.
--
-- Keyed by scope so a language, or one card type within it, can be caught up independently:
--   {"bg|en": {"targetDate": "2026-09-05"}, "es|en:typing": {"targetDate": "2026-08-29"}}
-- The bare "src|tgt" key covers whichever types have no plan of their own (most-specific-wins,
-- resolvePlan() in lib/catchUp.ts). Type suffixes match the "Study all due" popover's own buckets:
-- typing | sgForward | sgReverse.
--
-- A plan deletes itself when its scope's backlog reaches zero. Past the target date it holds at the
-- full remaining load rather than expiring, so nothing silently stops serving.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS catchup_plans JSONB NOT NULL DEFAULT '{}'::jsonb;
