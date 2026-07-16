-- Per-ladder "wait between rungs" (seconds). After a card advances a rung it is held
-- this long before it can reappear at the next rung (soft timer, like Again/Hard/Good).
-- Default 180s = 3 minutes.
alter table learning_ladders
  add column if not exists between_rung_wait_seconds integer not null default 180;
