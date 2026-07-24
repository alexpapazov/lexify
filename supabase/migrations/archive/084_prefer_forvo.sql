-- Global "prefer Forvo recordings" audio setting (per user).
-- When on, on-demand audio generation tries Forvo (real native-speaker recordings)
-- first and falls back to ElevenLabs when Forvo has no recording for the word.
alter table profiles
  add column if not exists prefer_forvo boolean not null default false;
