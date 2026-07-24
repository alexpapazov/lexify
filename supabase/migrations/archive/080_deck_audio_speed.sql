-- 080_deck_audio_speed.sql
--
-- Per-deck audio playback speed. Applied at playback time (HTMLAudioElement
-- playbackRate, pitch preserved) — no regeneration needed. 1.0 = normal.

ALTER TABLE user_deck_preferences
  ADD COLUMN IF NOT EXISTS audio_speed real NOT NULL DEFAULT 1.0;
