-- One-off: make all Korean ('ko') and Spanish ('es') cards use ElevenLabs audio.
--
-- SQL can't call the TTS API, so for each card:
--   • set the chosen source to 'elevenlabs';
--   • if an ElevenLabs clip is already cached in audio_sources, promote it to audio_data
--     (no regeneration needed);
--   • otherwise clear audio_data / audio_generated so the app regenerates it on next study
--     — this requires the effective source for ko/es to be ElevenLabs (Settings → Audio:
--     Default audio source = AI voice, with no ko/es override).
update cards
set audio_source    = 'elevenlabs',
    audio_data      = coalesce(audio_sources, '{}'::jsonb) ->> 'elevenlabs',
    audio_generated = coalesce(audio_sources, '{}'::jsonb) ? 'elevenlabs'
where source_language in ('ko', 'es');
