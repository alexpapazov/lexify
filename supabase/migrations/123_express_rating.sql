-- Express reverse review: whether a clean match just counts as Good (false, the default) or pauses
-- for an Again/Hard/Good/Easy rating on the matched tile (true). Settings → Study defaults → Due Now.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS express_rating BOOLEAN NOT NULL DEFAULT FALSE;
