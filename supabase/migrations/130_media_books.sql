-- 130_media_books.sql — books as real records in the media log (2026-11-07).
--
-- A book is created once (title + language pair + the reader's marker system) and every
-- reading entry files under it, folder-style. The marker config's canonical home moves from
-- per-entry recall onto the book row; `deck_id` remembers the book's deck once the first
-- commit creates it. Entries keep their denormalized `title` for display/history; `book_id`
-- is the grouping key (SET NULL on book delete so the log never loses entries).
--
-- The backfill creates one book per distinct (user, title, pair) from existing entries —
-- newest entry's markers win — and links every entry to its book.

CREATE TABLE IF NOT EXISTS media_books (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  source_language text NOT NULL,
  target_language text NOT NULL,
  markers         jsonb,
  deck_id         uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS media_books_user_idx
  ON media_books (user_id, deleted_at, created_at DESC);

ALTER TABLE media_books ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own media_books" ON media_books;
CREATE POLICY "own media_books" ON media_books
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE media_entries ADD COLUMN IF NOT EXISTS book_id uuid REFERENCES media_books(id) ON DELETE SET NULL;

-- Backfill: one book per distinct (user, title, pair); the newest entry's markers win.
INSERT INTO media_books (user_id, title, source_language, target_language, markers)
SELECT DISTINCT ON (user_id, title, source_language, target_language)
       user_id, title, source_language, target_language, markers
FROM media_entries
WHERE deleted_at IS NULL
ORDER BY user_id, title, source_language, target_language, created_at DESC;

UPDATE media_entries e
SET book_id = b.id
FROM media_books b
WHERE e.book_id IS NULL
  AND e.user_id = b.user_id AND e.title = b.title
  AND e.source_language = b.source_language AND e.target_language = b.target_language;
