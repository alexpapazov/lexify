-- 129_media_entry_read_on.sql — the reading DATE on a media entry (2026-11-07).
--
-- You often log pages a few days after reading them; the entry should carry the day the
-- reading actually happened, not the day you got around to photographing it. Chosen in the
-- wizard (past dates up to today, never the future; defaults to today). NULL = legacy entries,
-- which display their created_at day.

ALTER TABLE media_entries ADD COLUMN IF NOT EXISTS read_on date;
