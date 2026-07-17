-- Per-deck audio playback volume (0–1, applied at playback time). 1 = full volume.
alter table user_deck_preferences
  add column if not exists audio_volume real not null default 1;
