-- 091_drop_multiplier_scheduler_columns.sql
--
-- Stage 4 of the legacy interval-multiplier removal. FSRS (engine/dueNow) now owns all
-- graduated scheduling, so the multiplier coefficients are dead. This drops:
--   • the per-track multiplier params on user_scheduler_params (good/hard/easy min/ideal/max/floor,
--     the accelerated variants, and the decay/again-reduction constants), and
--   • the vestigial per-card scheduling columns on card_states (ease, lapse_cluster_count,
--     last_lapse_at, pending_interval_days).
--
-- KEPT (still live): user_scheduler_params.max_interval_days, request_retention,
-- recent_retention_rate, grad_interval_*err_*, typed_prob_*, the *_enabled flags, the
-- strictness modes, smart_typing_threshold_days; card_states.difficulty/stability/relearning/
-- good_streak/again_streak/relearning_step/interval_days/scheduled_interval_days.
--
-- Apply AFTER deploying the code that no longer reads/writes these columns.

-- ── user_scheduler_params: drop multiplier coefficients ──────────────────────
alter table user_scheduler_params
  drop column if exists good_min,
  drop column if exists good_ideal,
  drop column if exists good_max,
  drop column if exists good_floor,
  drop column if exists hard_min,
  drop column if exists hard_ideal,
  drop column if exists hard_max,
  drop column if exists hard_floor,
  drop column if exists easy_min,
  drop column if exists easy_ideal,
  drop column if exists easy_max,
  drop column if exists easy_floor,
  drop column if exists accel_good_min,
  drop column if exists accel_good_ideal,
  drop column if exists accel_good_max,
  drop column if exists accel_hard_min,
  drop column if exists accel_hard_ideal,
  drop column if exists accel_hard_max,
  drop column if exists accel_easy_min,
  drop column if exists accel_easy_ideal,
  drop column if exists accel_easy_max,
  drop column if exists decay_constant_days,
  drop column if exists again_reduction;

-- ── card_states: drop vestigial multiplier-scheduler columns ─────────────────
alter table card_states
  drop column if exists ease,
  drop column if exists lapse_cluster_count,
  drop column if exists last_lapse_at,
  drop column if exists pending_interval_days;
