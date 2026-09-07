-- Forward Due Now reviews as cloze: show a generated target-language sentence with the reviewed
-- word blanked out (gloss inside the blank, translation underneath) instead of the bare gloss.
-- Settings → Study defaults → Due Now. Grading is unchanged — the sentence is prompt context only.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS forward_cloze BOOLEAN NOT NULL DEFAULT FALSE;
