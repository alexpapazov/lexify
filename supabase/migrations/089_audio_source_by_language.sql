-- Per-language audio source overrides (e.g. {"es": "elevenlabs"}), layered over audio_source_default.
-- Empty object = every language uses the global default.
alter table profiles
  add column if not exists audio_source_by_language jsonb not null default '{}'::jsonb;
