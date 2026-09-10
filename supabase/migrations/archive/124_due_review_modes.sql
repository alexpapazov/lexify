-- Due Now launch modes, chosen once in Settings → Study → Due Now (2026-09-09). These replace the
-- dashboard due picker's per-row two-button chooser: a row now launches straight into the
-- configured mode.
--   forward_cloze    — forward due reviews (typing + self-graded, native → target) launch with
--                      cloze prompts (`?cloze=1`) instead of the bare gloss.
--   reverse_matching — due reverse self-graded rows launch the express matching session
--                      (whether matches then collect ratings stays `express_rating`, migration 123).
-- NOTE: an earlier, unrelated 124_forward_cloze.sql was created and deleted UNAPPLIED on
-- 2026-09-07; if it was somehow run, this ADD COLUMN IF NOT EXISTS simply keeps that column.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS forward_cloze    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS reverse_matching BOOLEAN NOT NULL DEFAULT FALSE;
