-- One-off: reset the currently-"learning" cards in the "Body and Health Mega" deck to robotic
-- (device) audio.
--   • audio_source = 'browser'  → robotic playback (on-device speech synth)
--   • audio_data   = null       → drop the active AI clip so the study modes fall back to robotic
--   • audio_generated = true    → keep the audio prefetch from regenerating an AI clip for them
-- The per-provider audio_sources cache is left intact, so any card can be switched back to
-- ElevenLabs/Forvo from its ℹ panel later.
--
-- "Learning" = a forward card_state that hasn't graduated yet.
update cards
set audio_source    = 'browser',
    audio_data      = null,
    audio_generated = true
where id in (
  select dc.card_id
  from deck_cards dc
  join decks       d  on d.id  = dc.deck_id
  join card_states cs on cs.card_id = dc.card_id and cs.review_direction = 'forward'
  where d.name = 'Body and Health Mega'
    and cs.graduated = false
);
