# Language Syncing

Language Syncing automatically generates vocabulary cards in other language pairs when you add or upload cards. Example: uploading a Spanish → English set also produces a French → English set with no extra work. Sync rules define which language pairs to link; a checkbox on the upload / add-cards pages controls whether sync fires for that batch.

---

## Concepts

**Sync rule** — a user-configured rule linking one language pair (source) to another (destination). One row per `(user_id, source_pair_id, destination_pair_id)`.

- **Mode**: `auto` — card is created in the dest deck immediately. `review_first` — a pending link is recorded; user approves manually before any card is created.
- **Trigger**: stored on the rule but not actively used in the upload-checkbox path. Reserved for future differentiation. All enabled `auto` rules for the source pair fire whenever the sync checkbox is checked.

**Synced card link** (`synced_card_links`) — one row per `(source_card_id, destination_pair_id)`. Connects a source card to its generated counterpart and tracks status.

**Sync state** (`language_sync_state`) — caches the folder and deck IDs for each sync direction so `ensureInfra()` only creates infrastructure once.

---

## Database tables

### Migration 039 — core sync tables

**`language_sync_rules`** — one row per `(user_id, source_pair_id, destination_pair_id)`.

| Column | Type | Notes |
|--------|------|-------|
| `mode` | TEXT | `'auto'` or `'review_first'` |
| `trigger` | TEXT | `'on_card_created'`, `'on_card_graduated'`, `'manual_only'` — reserved |
| `enabled` | BOOLEAN | Toggle without deleting the rule |

**`synced_card_links`** — one row per `(source_card_id, destination_pair_id)`.

| Column | Type | Notes |
|--------|------|-------|
| `synced_card_id` | UUID (nullable) | NULL when dismissed |
| `source_front_at_sync` | TEXT | Source card's front text at the time of sync — used by Phase 2 |
| `source_back_at_sync` | TEXT | Source card's back text at the time of sync |
| `generated_front` | TEXT | Translated front produced by Claude (empty until Phase 2 fills it) |
| `generated_back` | TEXT | Translated back produced by Claude |
| `confidence` | FLOAT | 0.0–1.0 from Claude |
| `warning` | TEXT | Claude's note if the translation is uncertain |
| `status` | TEXT | `'pending'`, `'active'`, `'dismissed'`, `'manually_edited'` |

`sync_rule_id` references `language_sync_rules(id)` with **no cascade**. When deleting a rule, delete `synced_card_links` rows for that rule first (the settings page does this).

**`language_sync_state`** — primary key `(user_id, source_pair_id, destination_pair_id)`.

| Column | Notes |
|--------|-------|
| `root_folder_id` | The "SYNCED VOCABULARY" folder for this dest pair |
| `sub_folder_id` | The source-language subfolder inside the root |
| `deck_id` | The date-named deck inside the subfolder |

### Migration 040 — sync origin columns on `cards`

Added `synced_from_language TEXT` and `origin_word TEXT` (single-value; now superseded by the array columns below but kept for backwards compatibility).

### Migration 041 — `is_synced` on `folders`

`is_synced BOOLEAN` marks folders that are managed by the sync system. Sync-managed folders:
- Cannot be renamed or deleted through the normal UI
- Only appear in the library for the language pair whose decks they contain (bypasses the "empty folder = show everywhere" shortcut in `folderMatchesPair`)

### Migration 044 — array sync origin columns on `cards`

`origin_words TEXT[]` and `synced_from_languages TEXT[]` replace the single-value columns. A card may have multiple source languages if different source words from different languages all translated to the same destination word (e.g. Spanish "rojo" and Italian "rosso" → French "rouge"). Backfilled from the old single-value columns.

---

## Folder and deck structure

Each **destination pair** gets its own independent hierarchy. There is no shared root folder.

```
Library (destination pair's language view)
└── SYNCED VOCABULARY/                    ← root folder, is_synced=true, one per dest pair
    └── Spanish / English/                ← subfolder: "SourceLang / TargetLang", is_synced=true
        ├── June 23 2026                  ← deck for today's upload (reused same-day)
        └── June 24 2026                  ← new deck the next day
```

`ensureInfra()` in `lib/syncProcessor.ts` creates this structure on demand and saves the IDs in `language_sync_state`. Subsequent syncs return immediately from the cache (no DB writes). Three staleness cases are handled:

- **Both folders alive** → reuse as-is
- **Root alive, subfolder deleted** → recreate subfolder under same root (no new root created)
- **Root deleted** → full recreation

**Orphan recovery** — if `language_sync_state` has no row for a direction (e.g. a previous run timed out before saving state), `ensureInfra()` scans for unclaimed "SYNCED VOCABULARY" roots before creating new folders. `ensureInfra()` is called sequentially (not via `Promise.all`) so each destination language claims its orphaned root before the next one runs.

---

## Two-phase sync (auto path)

### Entry points

- Upload page (`app/upload/page.tsx`) — "Sync to other languages" checkbox, checked by default; fires when the user saves the upload
- Add-cards page (`app/study/[deckId]/add/page.tsx`) — same checkbox

The checkbox is only shown when the deck's source pair has at least one enabled sync rule.

**What gets synced:** newly created cards **and** cards that were deduplicated against existing source-language cards (action = `'merge'`). If "rojo" already exists in Spanish and the user uploads "rojo" again, the existing card is still included in the sync payload — so it will appear in French, Italian, etc. even though no new Spanish card was created.

The page calls `POST /api/sync` fire-and-forget with:
```json
{
  "sourceLanguage": "es",
  "targetLanguage": "en",
  "cards": [{ "id": "...", "front": "rojo", "back": "red" }, …]
}
```

Auth uses `Authorization: Bearer <supabase-jwt>`. The route responds immediately with `{ ok: true }` and runs all work inside Next.js `after()` so the browser tab does not need to stay open.

---

### Phase 1 — Stub creation (`createAllStubs`)

Runs instantly (no AI). For every enabled `auto` rule reachable from the source pair (BFS walk across rules):

1. Calls `ensureInfra()` to get or create the folder hierarchy and today's date deck.
2. Checks `synced_card_links` for this `(user, destination_pair)` to find already-synced source cards. **Dead link detection** — if a link's `synced_card_id` points to a soft-deleted card, that link is treated as if it doesn't exist (the source card is re-eligible for sync). Dead links for cards in `toSync` are deleted before upserting new links, clearing the unique constraint for the fresh insert.
3. Filters source cards to `toSync` using two checks:
   - `source_card_id` not in existing alive links (same card ID, already synced)
   - `source_front_at_sync` (lowercased) not in existing alive links (same word text, different card ID — e.g. card was re-uploaded)
4. Bulk-inserts blank stub cards: `front = ''`, `back = ''`, `origin_words = [c.front]`, `synced_from_languages = [src.source_language]`.
5. Links stubs to today's deck via `deck_cards`.
6. Upserts `synced_card_links` rows with `status = 'pending'`, storing `source_front_at_sync` and `source_back_at_sync`.

After `createAllStubs` returns, the route triggers Phase 2 via a server-to-server call to itself (`x-sync-secret` header).

---

### Phase 2 — Translation fill (`fillAllPending`)

Fetches **all** pending links for the user and fires one Anthropic call per link, all in parallel (`Promise.all`). Each call:

1. Calls **Claude Haiku** (`claude-haiku-4-5-20251001`, max_tokens 300) with `source_front_at_sync` and `source_back_at_sync`. The translation is always derived from the front (the word being learned), not the back gloss.

2. **Duplicate detection (Case 2 — same dest word from a different source language):** after receiving the translation, checks if another synced card with the same `front` text already exists in the dest language pair. If found:
   - Transfers the stub's deck slot to the existing card
   - Appends the new source language + origin word to the existing card's `origin_words[]` and `synced_from_languages[]` arrays (no duplicates)
   - Soft-deletes the redundant stub
   - Updates the link to point at the existing card and marks it `active`

3. **Normal path:** updates the stub's `front` and `back` in place, marks the link `active`.

If any cards remain pending after the pass (Anthropic error / timeout), the route triggers one retry.

When all pending links are resolved, every incomplete synced deck is marked `syncing_complete = true`.

**Translation prompt:**
```
Front (word being learned): "<sourceFront>"
Back (basis-language gloss): "<sourceBack>"
Translate into new language pair:
  New front: the equivalent word/phrase in <destLearnedLang>
  New back:  the equivalent word/phrase in <destBasisLang>
Return ONLY JSON: { "front": "...", "back": "...", "confidence": 0.0-1.0, "warning": null }
```

---

## Deduplication — all three cases

| Case | Where caught | How |
|------|-------------|-----|
| Same source card re-uploaded (same ID) | Phase 1 | `source_card_id` in existing alive links → skip |
| Same source word re-uploaded (new card ID) | Phase 1 | `source_front_at_sync` (lowercased) in existing alive links → skip |
| Different source languages translate to the same dest word | Phase 2 | After translation, check for existing synced card with same `front` → reuse, append arrays, delete stub |

---

## Manual path — per card

**Entry point:** "⟳ Sync" button in `CardEditModal` (deck detail page) → opens `SyncReviewModal`.

1. Finds the source pair for the current deck.
2. Loads all enabled sync rules for that pair.
3. For each rule, checks for an existing link:
   - `status = 'active'` → shows a read-only summary row
   - `status = 'dismissed'` → skipped
   - No link or `status = 'pending'` → calls `POST /api/sync-translate`, checks for duplicates, builds a review row
4. User can **Approve**, **Edit then Approve**, or **Dismiss** each row.

The manual path uses `lib/syncFolderInfra.ts` (`ensureSyncInfra`) and `POST /api/sync-translate` — separate from the auto path's server-side stack. It creates a flat folder structure without `is_synced: true`.

---

## Managing sync rules

`app/settings/page.tsx` → `LanguageSyncPanel`.

- **Create** — select source and destination pairs, choose mode, save
- **Toggle** — enable/disable without deleting
- **Delete** — two-step confirmation; deletes `synced_card_links` rows for the rule first, then the rule itself (required — no FK cascade)

---

## Card display

The "Sync origin" section in the card detail panel shows all values from the array columns:

- **Synced from:** comma-joined language names from `syncedFromLanguages[]` (e.g. "Spanish, Italian")
- **Origin word:** comma-joined words from `originWords[]` (e.g. "rojo, rosso")

---

## Key files

| File | Role |
|------|------|
| `supabase/migrations/039_language_sync.sql` | Core tables and RLS policies |
| `supabase/migrations/041_folder_is_synced.sql` | `is_synced` column on folders |
| `supabase/migrations/044_cards_origin_words_array.sql` | Array origin columns on cards |
| `lib/syncProcessor.ts` | `createAllStubs()` (Phase 1) and `fillAllPending()` (Phase 2) |
| `lib/supabase/admin.ts` | Service-role client — bypasses RLS; always scope queries to `userId` |
| `app/api/sync/route.ts` | Entry point; responds immediately, runs in `after()` |
| `lib/syncFolderInfra.ts` | `ensureSyncInfra()` — manual review path only |
| `app/api/sync-translate/route.ts` | Claude Haiku translation endpoint — manual path only |
| `app/upload/page.tsx` | Builds sync payload (new cards + merged/existing cards) |
| `app/study/[deckId]/add/page.tsx` | Add-cards sync checkbox |
| `app/library/page.tsx` | `getVisibleRoots()` — filters synced folders to their own language pair |
| `app/study/[deckId]/page.tsx` | `SyncReviewModal`, `CardEditModal` sync origin display |
| `app/settings/page.tsx` | `LanguageSyncPanel` — create/toggle/delete rules |

---

## Required environment variables

| Variable | Where to get it |
|----------|----------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → service_role key |
| `ANTHROPIC_API_KEY` | Anthropic console |
| `SYNC_INTERNAL_SECRET` | Any random string — authenticates server-to-server Phase 2 trigger |

---

## Error log

| Date | Error | Fix |
|------|-------|-----|
| 2026-06-22 | Delete rule button too small; errors silently swallowed | Made delete a full-width button with inline confirmation; errors displayed via `deleteError` state |
| 2026-06-22 | Deleting a sync rule failed with FK constraint violation | `synced_card_links.sync_rule_id` has no CASCADE — settings page now deletes links before the rule |
| 2026-06-22 | "Synced" root folder created with lowercase "synced" | Fixed string literal in `syncFolderInfra.ts` |
| 2026-06-22 | Unnecessary sub-folder layer in folder structure | Removed sub-folder; deck lives directly inside "Synced"; `sub_folder_id = root_folder_id` |
| 2026-06-22 | Auto-sync on card creation never fired | Created `lib/autoSync.ts` (later superseded by server-side two-phase design) |
| 2026-06-22 | Sync fired automatically with no user control | Replaced with explicit "Sync to other languages" checkbox (checked by default) |
| 2026-06-22 | Only 9 of 72 cards synced | All 72 Anthropic calls fired simultaneously, hitting rate limits. Fixed by batching (later redesigned to two-phase parallel fill) |
| 2026-06-22 | Sync stopped when user switched browser tabs | Browser throttled inactive-tab JS. Fixed by moving sync entirely to server via `after()` |
| 2026-06-22 | Sync timed out on Vercel Hobby plan | Processed all cards in one invocation (~17 s). Fixed with self-chaining batches of 5 |
| 2026-06-23 | Multiple SYNCED VOCABULARY roots created per user | Each dest language created its own root. Redesigned: one root per dest pair; roots are per-pair, not shared |
| 2026-06-23 | Multiple SYNCED VOCABULARY roots after Vercel timeout | `language_sync_state` upsert failed silently; next Phase 1 run created second root. Fixed: error surfacing on state upsert; orphan recovery adopts unclaimed roots; sequential `ensureInfra` calls |
| 2026-06-23 | SYNCED VOCABULARY folders from other languages appeared in French library | `folderMatchesPair` returned `true` for empty folders. Fixed: `is_synced` folders bypass the empty-folder shortcut and only show in the library for their own language pair |
| 2026-06-23 | Synced cards not deduplicated when same source word re-uploaded as new card ID | Phase 1 only checked `source_card_id`. Added `source_front_at_sync` (lowercased) check |
| 2026-06-23 | Different source languages producing the same dest word created duplicate cards | Added Phase 2 check: after translation, search for existing synced card with same front; if found, reuse it and merge `origin_words[]` / `synced_from_languages[]` |
| 2026-06-23 | Re-uploading source cards whose synced counterpart was deleted produced no new synced cards | Phase 1 treated dead links (pointing at deleted cards) as "already synced". Fixed: dead links excluded from filter sets; dead links for re-syncing cards deleted before upsert to clear unique constraint |
| 2026-06-23 | Words that already existed in the source language were not synced to other languages | Sync payload only included newly created cards, not merged (existing) cards. Fixed: `toMerge` cards (existing cards added to deck via dedup) are now included in the sync payload |
