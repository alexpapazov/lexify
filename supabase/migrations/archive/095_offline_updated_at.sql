-- Stage 0 (offline foundation): every table synced to the offline store needs `updated_at` so the
-- sync engine can detect server-side changes since a download (conflict detection + pull-freshness).
-- These three were the only synced tables missing it. Reuses the existing set_updated_at() trigger fn.

alter table user_scheduler_params  add column if not exists updated_at timestamptz not null default now();
alter table card_confusion_links   add column if not exists updated_at timestamptz not null default now();
alter table typed_answer_overrides add column if not exists updated_at timestamptz not null default now();

drop trigger if exists user_scheduler_params_updated_at on user_scheduler_params;
create trigger user_scheduler_params_updated_at  before update on user_scheduler_params
  for each row execute function set_updated_at();

drop trigger if exists card_confusion_links_updated_at on card_confusion_links;
create trigger card_confusion_links_updated_at   before update on card_confusion_links
  for each row execute function set_updated_at();

drop trigger if exists typed_answer_overrides_updated_at on typed_answer_overrides;
create trigger typed_answer_overrides_updated_at before update on typed_answer_overrides
  for each row execute function set_updated_at();
