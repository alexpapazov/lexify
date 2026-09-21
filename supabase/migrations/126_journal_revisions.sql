-- Journal revision history (2026-09-21, second pass): every save of an existing entry pushes the
-- PRIOR text onto `revisions`, so an entry carries its creation day, every day it was edited, and
-- every version of its text. Shape: [{ "content": "...", "editedAt": "<when this version was
-- REPLACED>" }], oldest first. Diffs (additions/changes/removals between versions) are DERIVED at
-- display time from adjacent versions (lib/textDiff.ts) — snapshots are stored, never diffs, so
-- the history can't drift from the text (store what happened; derive what is true).

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS revisions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Side notes: a second, shorter field per entry for new words / grammar constructions spotted
-- while writing. Plain text for now — functionality on top of it is planned (2026-09-21).
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS notes TEXT;
