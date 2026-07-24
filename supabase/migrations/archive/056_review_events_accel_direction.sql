ALTER TABLE review_events
  ADD COLUMN was_accelerated     BOOLEAN,
  ADD COLUMN accelerated_penalty INT,
  ADD COLUMN review_direction    TEXT DEFAULT 'forward';
