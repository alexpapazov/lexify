# Language Syncing

Language Syncing automatically generates vocabulary cards in a second language pair when you add or upload cards. For example: uploading a Spanish → English set can also produce a French → English set with no extra work. Sync rules define which language pairs to link; a checkbox on the upload/add-cards pages controls whether sync fires for that batch.

---

## Concepts

**Sync rule** — a user-configured rule linking one language pair (source) to another (destination). One rule per direction per user. Rules have two key settings:

- **Mode**: how the generated card is handled
  - `auto` — card is created in the dest deck immediately, no review needed
  - `review_first` — a pending link is recorded; user reviews and approves it manually before any card is created

- **Trigger**: stored on the rule but not used to filter the upload-checkbox path — all enabled rules for the source pair fire when the user checks "Sync to other languages." The `trigger` field (`on_card_created`, `on_card_graduated`, `manual_only`) is reserved for future differentiation. The only active trigger paths today are the upload checkbox and the manual per-card review.

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
| `root_folder_id` | The "SYNCED VOCABULARY" folder in the library |
| `sub_folder_id` | Currently always equal to `root_folder_id` |
| `deck_id` | The synced deck inside "SYNCED VOCABULARY" |

---

## Folder and deck structure

For each sync direction, `ensureInfra()` inside `lib/syncProcessor.ts` (auto path) or `ensureSyncInfra()` in `lib/syncFolderInfra.ts` (manual path) creates and persists this structure once:

```
Library
└── SYNCED VOCABULARY/          ← one shared root folder per user (all directions share it)
    ├── Spanish                 ← deck named after the source language (Spanish→Korean rule)
    ├── French                  ← deck named after the source language (French→Korean rule)
    └── …
```

**One folder for all directions.** `SYNCED VOCABULARY` is looked up by name — if it already exists for the user it is reused; otherwise it is created. This means no matter how many sync rules a user has, or what order they first run, there is always exactly one `SYNCED VOCABULARY` folder.

If the user deletes the `SYNCED VOCABULARY` folder, the next auto-sync recreates it automatically.

**Reserved name.** Users cannot manually create a folder named `SYNCED VOCABULARY` (case-insensitive). The library page and upload page both block this with an inline error.

`language_sync_state` caches the folder/deck IDs so `ensureInfra` only creates infrastructure once per direction. Subsequent syncs return immediately from the cache.

---

## Translation model

All translations use **Claude Haiku** (`claude-haiku-4-5-20251001`, max_tokens 300). The semantic anchor is always `sourceFront` (the word being learned in the source pair) — the back/gloss is provided as context but the translation is derived from the front.

The prompt asks for a JSON response:
```json
{ "front": "...", "back": "...", "confidence": 0.95, "warning": null }
```

---

## Duplicate detection

Before creating a synced card, all existing cards owned by the user in the destination language direction are checked. If any card has a `front` that matches `generatedFront` (case-insensitive trim), the existing card is reused — added to the synced deck without creating a new row.

```ts
const norm = (s: string) => s.trim().toLowerCase()
const duplicate = destCards.find(c => norm(c.front) === norm(generatedFront))
```

This prevents creating a duplicate card if e.g. "horloge" already exists in the French deck from a prior sync or manual entry.

---

## Trigger paths

### Auto path — upload checkbox (server-side, self-chaining)

**Entry points:**
- "Sync to other languages" checkbox on the upload page (`app/upload/page.tsx`)
- "Sync to other languages" checkbox on the add-cards review stage (`app/study/[deckId]/add/page.tsx`)

The checkbox is only shown when the deck's source language pair has at least one enabled sync rule. It is **checked by default**. If unchecked before saving, no sync fires.

When the user saves with the checkbox checked, the page calls `POST /api/sync` fire-and-forget with:
```json
{
  "sourceLanguage": "es",
  "targetLanguage": "en",
  "cards": [{ "id": "...", "front": "...", "back": "..." }, …]
}
```

Auth uses `Authorization: Bearer <supabase-jwt>`.

#### `/api/sync` route (`app/api/sync/route.ts`)

Responds immediately with `{ ok: true }` and runs all work inside `after()` (Next.js 15+ — code that continues on the server after the HTTP response is sent, so the browser tab does not need to stay open).

**Single-batch-per-invocation design (Vercel Hobby 10-second limit):**

Each invocation processes exactly `BATCH_SIZE = 5` cards (`cards[0..4]`), then self-triggers for the remainder. This keeps every function call under ~4 seconds, well within the 10-second Hobby limit.

`after()` logic per invocation:
1. If `isChainHop = true` (this is a cascade to a new language), sleep `CHAIN_DELAY_MS = 5000 ms` first — this is the only sleep in the entire system, and it keeps total invocation time under 10 s.
2. Call `processSyncBatch(payload)` with the full payload (it internally slices `cards[0..BATCH_SIZE]`).
3. Update `failCounts` for any failed cards; drop cards that have failed `MAX_CARD_FAILS = 10` times total.
4. **Continuation**: if `remaining + retryable cards > 0`, immediately trigger the same-language continuation (no delay).
5. **Cascade**: for each `NextHop` returned by `processSyncBatch`, trigger a new hop with `isChainHop = true` (the hop will sleep 5 s internally before processing).

Server-to-server calls authenticate via `x-sync-secret: <SYNC_INTERNAL_SECRET>` header.

#### `lib/syncProcessor.ts`

`processSyncBatch(payload)` runs one batch:
1. Adds `sourceLanguage:targetLanguage` to `visitedSet`; skips if already visited (loop prevention).
2. Uses the admin Supabase client (`lib/supabase/admin.ts`) to bypass RLS. All queries are explicitly scoped to `userId`.
3. Looks up the source language pair and all enabled rules for it.
4. For each rule:
   - Calls `ensureInfra()` to get/create the `SYNCED VOCABULARY` folder and dest deck.
   - Loads existing dest cards for duplicate detection.
   - Fires `BATCH_SIZE` Anthropic API calls in parallel (`Promise.all`).
   - For each result: checks for duplicate → creates or reuses card (mode=`auto`) → upserts `synced_card_links`.
   - If `mode = auto` and dest cards were created, adds a `NextHop` for that dest language (cascade).
5. Returns `{ successCards, failedCards, nextHops }`.

#### Cascading

```
User uploads French cards (French→English pair)
  Invocation 1: translates French[1..5] → creates Korean[1..5] (if French→Korean rule exists)
    → triggers: French continuation (remaining French cards)
    → triggers: Korean cascade hop (with Korean[1..5]) — sleeps 5s before processing
  Invocation 2 (Korean cascade): translates Korean[1..5] → creates Italian[1..5]
    → triggers: Italian cascade hop — sleeps 5s
  Invocation 3 (French continuation): translates French[6..10] → creates Korean[6..10]
    → triggers: French continuation (French[11..])
    → triggers: another Korean cascade hop with Korean[6..10]
  …
```

Multiple cascade hops for the same language run independently and in parallel on Vercel's infrastructure — each is a separate function invocation.

**Loop prevention:** the `visited` array is passed through the entire payload chain. A pair key (`${sourceLanguage}:${targetLanguage}`) is added to `visitedSet` when first processed; any later hop that would re-enter an already-visited pair is skipped immediately.

**Retry:** failed cards are passed to the continuation hop via the `failCounts: Record<cardId, number>` payload field. A card is retried up to `MAX_CARD_FAILS = 10` times across invocations; after that it is silently dropped.

#### Required environment variables

These must be set in Vercel dashboard (Settings → Environment Variables):

| Variable | Where to get it |
|----------|----------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → service_role key |
| `SYNC_INTERNAL_SECRET` | Any random string — used to authenticate server-to-server hops |

---

### Manual path — per card

**Entry point:** "⟳ Sync" button in `CardEditModal` (deck detail page) → opens `SyncReviewModal`

`SyncReviewModal` (in `app/study/[deckId]/page.tsx`):
1. Finds the source language pair for the current deck.
2. Loads all enabled sync rules for that pair.
3. For each rule, checks for an existing link:
   - `status = 'active'` → shows a summary row (already synced, no action needed)
   - `status = 'dismissed'` → skipped entirely
   - No link or `status = 'pending'` → calls `POST /api/sync-translate`, checks for duplicates, builds a review row
4. User can **Approve**, **Edit then Approve**, or **Dismiss** each row:
   - Approve: creates/reuses card, upserts link with `status = 'active'`
   - Edit: user edits front/back manually, link gets `status = 'manually_edited'`
   - Dismiss: sets `synced_card_id = null`, `status = 'dismissed'`; card is never proposed again for this source card

The manual path uses `lib/syncFolderInfra.ts` (`ensureSyncInfra`) and `POST /api/sync-translate` — separate from the auto path's server-side stack.

---

## Managing sync rules

`app/settings/page.tsx` → `LanguageSyncPanel` component.

- **Create**: select source and destination language pairs, choose mode and trigger, save
- **Toggle**: enable/disable a rule without deleting it
- **Delete**: two-step confirmation (inline confirm button); deletes all `synced_card_links` for the rule first, then the rule itself (required — no FK cascade)

One rule per direction is enforced by the database UNIQUE constraint. The UI prevents creating a duplicate direction and shows an error if attempted.

---

## Key files

| File | Role |
|------|------|
| `supabase/migrations/039_language_sync.sql` | Creates the three tables and RLS policies |
| `lib/syncProcessor.ts` | `processSyncBatch()` — single-batch server-side processor for the auto path |
| `lib/supabase/admin.ts` | Service-role Supabase client (bypasses RLS — always scope queries to userId) |
| `app/api/sync/route.ts` | Self-chaining API route; responds immediately, runs in `after()` |
| `lib/syncFolderInfra.ts` | `ensureSyncInfra()` — used by the manual review path only |
| `lib/autoSync.ts` | Old client-side sync logic — no longer imported by any page; kept for reference |
| `app/api/sync-translate/route.ts` | Claude Haiku translation endpoint — used by the manual review path only |
| `lib/data/languageSyncRules.ts` | `listForUser()`, `upsert()`, `delete()` for sync rules |
| `lib/data/syncedCardLinks.ts` | `listForCard()`, `upsert()`, `dismiss()` for links |
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
| 2026-06-22 | Sync fired automatically on every upload with no user control | Replaced automatic trigger with an explicit "Sync to other languages" checkbox (checked by default); checkbox only shown when the deck's source pair has enabled rules |
| 2026-06-22 | Sync did not cascade — French→Spanish synced but Spanish→Russian rule was never invoked | Rewrote sync to collect dest cards per rule and recursively cascade; added `visited` loop guard |
| 2026-06-22 | Only 9 of 72 cards synced | Root cause: all 72 translation requests fired simultaneously, hitting Anthropic rate limits. Fixed by processing in batches of 5 |
| 2026-06-22 | Sync stopped mid-set when user switched browser tabs | Root cause: browser throttles background JS in inactive tabs. Fixed by moving sync entirely to the server via Next.js `after()` and a self-chaining API route |
| 2026-06-22 | Sync timed out on Vercel Hobby plan (10-second function limit) | Root cause: previous design processed all cards in one invocation (~17 s). Fixed by processing one batch of 5 cards per invocation and self-triggering for the remainder; each call completes in ~3-4 s |
| 2026-06-22 | Multiple "Synced" folders created when user had rules for different dest languages | Root cause: infra lookup used `language_sync_state` sibling query per dest pair, so each new dest pair created its own folder. Fixed by looking up the folder by name (`SYNCED VOCABULARY`) directly — all directions share one folder |
| 2026-06-22 | Renamed sync folder from "Synced" to "SYNCED VOCABULARY"; blocked reserved name in folder creation UI | `SYNC_FOLDER_NAME` constant in `syncProcessor.ts`; library page and upload page check `name.toUpperCase() === 'SYNCED VOCABULARY'` before creating folders |
