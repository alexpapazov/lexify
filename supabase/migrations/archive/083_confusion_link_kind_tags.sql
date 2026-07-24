-- 083_confusion_link_kind_tags.sql
-- Distinguish two flavours of confusion on card_confusion_links (migration 052):
--   kind='intra' — two words in the SAME learned language (gets the full response: penalty, drill,
--                  distractors, interleave).
--   kind='inter' — a word confused with one in a DIFFERENT language (stored only, for a future
--                  cross-linguistic feature).
-- tags — for intra links, similarity categories driving the future intra-language practice mode:
--   'phonetic' | 'semantic' | 'temporal' | 'other'. Multiple of phonetic/semantic/temporal may apply;
--   'other' is exclusive. Empty = not yet fully classified (semantic/other pending).

alter table card_confusion_links
  add column if not exists kind text     not null default 'intra',
  add column if not exists tags text[]   not null default '{}';
