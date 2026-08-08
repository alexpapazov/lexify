-- 112_card_starred.sql — starring a card.
--
-- A manual flag the learner sets from the star in a study card's top-left corner: "come back to
-- this one". Deliberately NOT derived from review history (difficulty and lapses already cover
-- that) — starring is for reasons the scheduler can't see: a word you love, one your teacher
-- flagged, one whose gloss you don't trust yet.
--
-- Starred cards can be filtered on the deck page, in the library, and picked as a practice source.

ALTER TABLE cards ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;

-- Starred cards are a small subset queried on their own ("show me my starred words"), so a partial
-- index costs almost nothing and keeps that filter off a full scan.
CREATE INDEX IF NOT EXISTS cards_starred_idx ON cards (owner_id) WHERE starred;
