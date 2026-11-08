-- 131_media_pipeline.sql — server-side media processing (Extraction Engine Stage A, 2026-11-08).
--
-- Photos now upload to a PRIVATE storage bucket and a Supabase Edge Function ("media-worker")
-- parses them in the background — the reader closes the app and comes back to results. Each
-- photo is one `media_pages` row; the worker claims rows, numbers pages (when sentences are
-- on), extracts, writes results back, and deletes every image when the entry completes.
--
-- media_entries gains `status` ('uploading' → 'processing' → 'done') and `options` — the
-- prompt-composition snapshot taken at upload: { circled, underlined, sentences, nounArticle }.
-- Legacy entries are 'done' by default and keep working unchanged.

ALTER TABLE media_entries ADD COLUMN IF NOT EXISTS status  text  NOT NULL DEFAULT 'done';
ALTER TABLE media_entries ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS media_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_id     uuid NOT NULL REFERENCES media_entries(id) ON DELETE CASCADE,
  page_index   integer NOT NULL,                  -- upload order
  storage_path text,                              -- null once the worker has deleted the image
  page_number  integer,                           -- printed page number (sentences mode)
  numbered     boolean NOT NULL DEFAULT false,    -- numbering attempted (page_number may still be null)
  status       text NOT NULL DEFAULT 'pending',   -- pending | working | done | failed
  covered      boolean NOT NULL DEFAULT false,    -- results live on the window-key page before it
  result       jsonb,                             -- { occurrences, allLemmas, pageLanguage }
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_pages_entry_idx ON media_pages (entry_id, page_index);

ALTER TABLE media_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own media_pages" ON media_pages;
CREATE POLICY "own media_pages" ON media_pages
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── Storage: the private bucket photos pass through ─────────────────────────
-- 5MB/object cap (client downscales to ~300KB JPEGs). The worker (service role) bypasses RLS;
-- these policies let the OWNER upload during submission and clean up if they cancel.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('media-pages', 'media-pages', false, 5242880)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "media pages owner insert" ON storage.objects;
CREATE POLICY "media pages owner insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'media-pages' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "media pages owner select" ON storage.objects;
CREATE POLICY "media pages owner select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'media-pages' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "media pages owner delete" ON storage.objects;
CREATE POLICY "media pages owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'media-pages' AND (storage.foldername(name))[1] = auth.uid()::text);
