-- 081_card_audio_sources.sql
--
-- Multi-source audio: a card can hold several candidate recordings (ElevenLabs TTS,
-- Forvo native speaker, browser/robotic) and the learner picks which one plays.
--   audio_source  — the active source ('elevenlabs' | 'forvo' | 'browser'); null = legacy/default.
--   audio_sources — cached base64 mp3 per provider so switching doesn't re-fetch, e.g.
--                   {"elevenlabs":"<b64>","forvo":"<b64>"}. 'browser' needs no blob.
-- The active provider's blob is mirrored into the existing audio_data column so all
-- the playback call sites keep working unchanged.

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS audio_source  text,
  ADD COLUMN IF NOT EXISTS audio_sources jsonb;
