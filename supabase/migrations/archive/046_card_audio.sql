-- Audio storage for AI-generated TTS (target/source language only).
-- audio_generated: false until TTS has been fetched for this card.
-- audio_data:      base64-encoded mp3 from OpenAI TTS; null until generated.
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS audio_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS audio_data      text    DEFAULT NULL;
