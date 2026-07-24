-- Per-user, per-language color overrides (code → #rrggbb), used by the analytics charts so a
-- language keeps a consistent color. Empty object = all languages use their deterministic default.
alter table profiles
  add column if not exists language_colors jsonb not null default '{}'::jsonb;
