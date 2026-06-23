# Language Syncing

Language Syncing automatically generates vocabulary cards in a second language pair when you upload cards. For example: uploading a Spanish → English set can also produce a French → English set with no extra work. Sync rules define which language pairs to link; a checkbox on the upload page controls whether sync fires for that batch.

---

## Concepts

**Sync rule** — a user-configured rule linking one language pair (source) to another (destination). One rule per direction per user. Rules have two key settings:

- **Mode**: how the generated card is handled
  - `auto` — card is created in the dest deck immediately, no review needed
  - `review_first` — a pending link is recorded, user reviews and approves it manually before any card is created

- **Trigger**: stored on the rule but not used to filter the upload-checkbox path — all enabled rules for the source pair fire when the user checks "Sync to other languages" at upload time. The `trigger` field (`on_card_created`, `on_card_graduated`, `manual_only`) is reserved for future differentiation (e.g. a separate graduation-triggered path). The only active trigger path today is the upload checkbox.

**Synced card link** — a record connecting a source card to its generated counterpart in the destination pair. One row per `(source_card_id, destination_pair_id)`. Tracks the translation result, confidence, status, and which card was actually created.

**Sync state** — a stable record of the folder and deck IDs created for a given sync direction. Prevents duplicate folder/deck creation across multiple syncs.

---

## Database tables (migration 039)

### `language_sync_rules`

One row per `(user_id, source_pair_id, destination_pair_id)` — enforced by a UNIQUE constraint.

| Column | Type | Notes |
|--------|------|-------|
| `mode` | TEXT | `'review_first'` or `'auto'` |
| `trigger` | TEXT | `'on_card_created'`, `'on_card_graduated'`, `'manual_only'` |
| `enabled` | BOOLEAN | Toggle without deleting the rule |
| `allow_synced_cards_to_trigger_sync` | BOOLEAN | Whether synced cards in the dest pair can themselves trigger further sync rules |

### `synced_card_links`

One row per `(source_card_id, destination_pair_id)` — enforced by a UNIQUE constraint.

| Column | Type | Notes |
|--------|------|-------|
| `synced_card_id` | UUID (nullable) | NULL when dismissed |
| `source_front_at_sync` | TEXT | Snapshot of the source card's front at the time of sync |
| `source_back_at_sync` | TEXT | Snapshot of the source card's back at the time of sync |
| `generated_front` | TEXT | The translated front produced by Claude |
| `generated_back` | TEXT | The translated back produced by Claude |
| `confidence` | FLOAT (nullable) | 0.0–1.0 from Claude |
| `warning` | TEXT (nullable) | Claude's note if the translation is uncertain |
| `status` | TEXT | `'pending'`, `'active'`, `'dismissed'`, `'manually_edited'` |

`sync_rule_id` references `language_sync_rules(id)` with **no cascade**. When deleting a rule, `synced_card_links` rows referencing it must be deleted first (the settings page does this).

### `language_sync_state`

Primary key: `(user_id, source_pair_id, destination_pair_id)`.

| Column | Notes |
|--------|-------|
| `root_folder_id` | The "Synced" folder in the dest pair's library |
| `sub_folder_id` | Currently always equal to `root_folder_id` — no sub-folder exists |
| `deck_id` | The synced deck inside the "Synced" folder |

---

## Folder and deck structure

For each sync direction, `ensureSyncInfra()` in `lib/syncFolderInfra.ts` creates and persists this structure once:

```
Library
└── Synced/                  ← root folder, one per destination language pair
    └── Spanish              ← deck named after the source language (e.g. langName(sourcePair.sourceLanguage))
```

The "Synced" root folder is shared across all source pairs that sync into the same destination pair. If a Spanish→French and a German→French rule both exist, they share one "Synced" folder and have two decks inside: "Spanish" and "German".

`ensureSyncInfra()` checks `language_sync_state` first and returns immediately if infrastructure already exists. This prevents duplicate folders across multiple syncs.

---

## Translation API

`POST /api/sync-translate` (file: `app/api/sync-translate/route.ts`)

Uses **Claude Haiku** (`claude-haiku-4-5-20251001`, max_tokens 300). The semantic anchor is always `sourceFront` (the word being learned in the source pair) — the back/gloss is provided as context but the translation is derived from the front.

**Request:**
```json
{
  "sourceFront":       "la casa",
  "sourceBack":        "house",
  "fromLanguage":      "es",
  "toLearnedLanguage": "fr",
  "toBasisLanguage":   "en"
}
```

**Response (success):**
```json
{ "ok": true, "front": "la maison", "back": "house", "confidence": 0.95, "warning": null }
```

**Response (failure):**
```json
{ "ok": false, "reason": "api-error" }
```

---

## Duplicate detection

Before creating a synced card, all existing cards owned by the user in the destination language direction are checked. If any card has a `front` that matches `generatedFront` (case-insensitive trim), the existing card is reused — it is added to the synced deck without creating a new row. This prevents "horloge" from being created twice if it already exists.

Duplicate check (used in both `autoSync.ts` and `SyncReviewModal`):
```ts
const norm = (s: string) => s.trim().toLowerCase()
const duplicate = destCards.find(c => norm(c.front) === norm(generatedFront))
```

---

## Trigger paths

### Upload checkbox

**Entry point:** "Sync to other languages" checkbox on the add-cards review stage (`app/study/[deckId]/add/page.tsx`)

The checkbox is only rendered when the deck's source language pair has at least one enabled sync rule (checked at page load). It is **checked by default**. If the user unchecks it before saving, no sync fires.

When the user clicks "Add N cards" with the checkbox checked, `handleCommit()` calls `autoSyncNewCards()` fire-and-forget after `cardRepo.bulkCreate()`. The page redirects immediately; syncing runs in the background.

`autoSyncNewCards()` in `lib/autoSync.ts`:
1. Finds the language pair matching the deck's source/target language codes
2. Filters all **enabled** rules for that source pair (trigger field is ignored here — all enabled rules apply)
3. For each matching rule:
   - Calls `ensureSyncInfra()` to get/create the dest folder and deck
   - Loads all existing dest cards for duplicate detection
   - Translates all new cards **in parallel** via `Promise.all`
   - For each translation: check for duplicate → create or reuse card (if mode = `auto`) → upsert link

### Manual — per card

**Entry point:** "⟳ Sync" button in `CardEditModal` (deck detail page) → opens `SyncReviewModal`

`SyncReviewModal` (in `app/study/[deckId]/page.tsx`):
1. Finds the source language pair for the current deck
2. Loads all enabled sync rules for that pair
3. For each rule, checks for an existing link:
   - `status = 'active'` → shows a summary row (already synced, no action needed)
   - `status = 'dismissed'` → skipped entirely
   - No link or `status = 'pending'` → calls translation API, checks for duplicates, builds a review row
4. User can **Approve**, **Edit then Approve**, or **Dismiss** each row
   - Approve: creates/reuses card, upserts link with `status = 'active'`
   - Edit: user edits front/back manually, link gets `status = 'manually_edited'`
   - Dismiss: sets `synced_card_id = null`, `status = 'dismissed'`; card is never proposed again for this source card

---

## Managing sync rules

`app/settings/page.tsx` → `LanguageSyncPanel` component.

- **Create**: select source and destination language pairs, choose mode and trigger, save
- **Toggle**: enable/disable a rule without deleting it
- **Delete**: two-step confirmation (inline confirm button); deletes all `synced_card_links` for the rule first, then deletes the rule itself (required — no FK cascade)

One rule per direction is enforced by the database UNIQUE constraint. The UI prevents creating a duplicate direction and shows an error if attempted.

---

## Key files

| File | Role |
|------|------|
| `supabase/migrations/039_language_sync.sql` | Creates the three tables and RLS policies |
| `lib/syncFolderInfra.ts` | `ensureSyncInfra()` — creates/looks up "Synced" folder and dest deck |
| `lib/autoSync.ts` | `autoSyncNewCards()` — fires sync on card creation |
| `lib/data/languageSyncRules.ts` | `listForUser()`, `upsert()`, `delete()` for sync rules |
| `lib/data/syncedCardLinks.ts` | `listForCard()`, `upsert()`, `dismiss()` for links |
| `app/api/sync-translate/route.ts` | Claude Haiku translation endpoint |
| `app/study/[deckId]/page.tsx` | `SyncReviewModal` and the "⟳ Sync" button in `CardEditModal` |
| `app/settings/page.tsx` | `LanguageSyncPanel` — create/toggle/delete rules |

---

## Error log

| Date | Error | Fix |
|------|-------|-----|
| 2026-06-22 | Delete rule button was too small to click and errors were silently swallowed | Made delete a full-width button with inline confirmation step; errors displayed via `deleteError` state |
| 2026-06-22 | Deleting a sync rule failed with FK constraint violation | `synced_card_links.sync_rule_id` references `language_sync_rules(id)` with no CASCADE — `handleDeleteConfirmed()` now deletes `synced_card_links` rows first, then the rule |
| 2026-06-22 | "Synced" root folder was created with lowercase "synced" | Fixed the string literal in `syncFolderInfra.ts` |
| 2026-06-22 | Folder structure created an unnecessary sub-folder (`synced / Spanish / Synced from Spanish deck`) | Removed sub-folder layer; deck named after source language now lives directly inside "Synced"; `sub_folder_id = root_folder_id` in `language_sync_state` |
| 2026-06-22 | Auto-sync on card creation never fired — `on_card_created` trigger had no implementation | Created `lib/autoSync.ts` and wired `autoSyncNewCards()` fire-and-forget into `handleCommit()` in the add-cards page |
| 2026-06-22 | Sync fired automatically on every upload with no user control | Replaced automatic trigger with an explicit "Sync to other languages" checkbox (checked by default) at the bottom of the add-cards review stage; checkbox only shown when the deck's source pair has enabled rules |
