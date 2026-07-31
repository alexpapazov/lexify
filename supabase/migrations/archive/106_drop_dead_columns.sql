-- 106_drop_dead_columns.sql
--
-- ✅ APPLIED 2026-07-30. Kept for the record.
--
-- This was the one irreversible step of the 2026-07-30 dead-code cleanup: dropping a column
-- destroys its data permanently. The five columns below are gone from the database.
--
-- Drops five columns that no code reads. Each was verified three ways before being listed here:
--   (a) repo-wide search for the snake_case name  → zero hits in code (docs/migrations only)
--   (b) repo-wide search for the camelCase name   → zero hits, or hits that resolve to a
--                                                    DIFFERENT, live column (see strict_* below)
--   (c) search of every migration for a SQL function, RPC, trigger, view, or RLS policy that
--       references the column → none found (a DROP would otherwise break a live DB object)
--
-- Column-by-column rationale:
--
--   profiles.prefer_forvo
--     Added by 084_prefer_forvo.sql. Superseded by `audio_source_default` (088), which migrated
--     this column's value forward. Nothing has read it since.
--
--   profiles.goals_count_accelerated
--     Added by 062_language_pair_goals.sql ("whether fast-tracked cards count toward the daily
--     goal"). The rule is now hardcoded — auto-graduated cards NEVER count toward goals — so the
--     per-user toggle is never consulted.
--
--   user_scheduler_params.strict_spelling
--   user_scheduler_params.strict_accents
--   user_scheduler_params.strict_articles
--     Added as booleans by 066_typed_grading_categories.sql, superseded by the three-level
--     enum columns `spelling_mode` / `accents_mode` / `articles_mode` in
--     069_typed_strictness_levels.sql, which backfilled from these and has read them ever since.
--     NOTE: the camelCase identifiers `strictSpelling` / `strictAccents` / `strictArticles` ARE
--     still live in TypeScript (domain/index.ts, lib/data/userSchedulerParams.ts), but they read
--     the *_mode columns — NOT these booleans. Do not let that name collision talk you out of
--     the drop, and do not rename the TS fields.
--
-- Safety: `if exists` makes this idempotent and a no-op if a column was already removed.

alter table profiles
  drop column if exists prefer_forvo,
  drop column if exists goals_count_accelerated;

alter table user_scheduler_params
  drop column if exists strict_spelling,
  drop column if exists strict_accents,
  drop column if exists strict_articles;
