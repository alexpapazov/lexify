# Dead code cleanup — findings & phased plan (2026-07-30)

> ## STATUS: Phases 0–3 EXECUTED ✅ · Phase 4 written but NOT applied ⚠️ · Phase 5 untouched
>
> Every deletion candidate below was adversarially re-verified before removal (18 agents, refute-first:
> each was assumed live until a repo-wide sweep of TS, tests, non-TS files, build output, SQL and the
> tsconfig-excluded MCP server failed to find a consumer).
>
> **Final gate:** `npm run build` exits 0 · `npx tsc --noEmit` clean on all source ·
> **37 suites / 447 tests pass**. The 452→447 delta is exactly the deleted `relearnPool.test.ts`
> (1 suite, 5 tests); no test regressed, and none was skipped/disabled to hide a failure.
>
> **What shipped:** 5 files deleted (~680 lines incl. test) · ~16 symbols deleted · ~86 de-exported ·
> 1 write-only `batchSizeRef` removed from each of the 3 session pages · 1 newly-orphaned
> `localStore.allConfusionLinks()` removed · stale docs corrected.
>
> **Corrections found during verification** (the original findings list was wrong on these):
> `bestVoiceFor`, `estimateBundleBytes`, `dedupeAgainst` are used internally → de-exported, not deleted.
> `DeckCard` had no in-file reference at all (its one "use" was a section comment) → deleted, not
> de-exported. `maxDuration` / `viewport` are Next.js framework exports → untouched. Migration 091 had
> already dropped the legacy scheduler columns, and `engine/scheduler.ts` was already fully trimmed.
>
> **The one thing left needing your decision:** `supabase/migrations/106_drop_dead_columns.sql` is
> written but deliberately NOT applied — dropping columns is irreversible. See Phase 4.

Verified against the working tree on 2026-07-30 by cross-referencing every exported symbol in
`app/ components/ lib/ engine/ domain/` (excluding tests) against all other production files and
against test files, plus a migration-vs-code scan for dead database columns. This confirms and
extends HANDOFF.md §5. **Nothing has been deleted yet** — each phase below is a separate,
verifiable chunk of work.

Ground rules for every phase:

- After each phase: `npm run build` && `npm test` must pass (452 tests / 38 suites baseline).
- No `git commit`/`git push` by the assistant — a commit block is output for the user per phase.
- Phases 0–3 are pure dead-code removal (no behavior change). Phases 4–5 change the database or
  live functionality and **require explicit user approval before starting**.

---

## Findings

### A. Orphaned modules — zero non-test importers (verified)

| File | Lines | Notes |
|---|---|---|
| `components/library/Library.tsx` | 356 | Old library UI; rewritten inline in `app/library/page.tsx`. Biggest trap for future edits. |
| `lib/autoSync.ts` | 228 | Client-side auto-sync superseded by server-side `lib/syncProcessor.ts` + `/api/sync`. Nothing calls it. |
| `lib/relearnPool.ts` | 40 | Batch-window relearn partitioning, removed when relearns became session-persistent. Only its own test imports it. (The `relearnPool` identifier in the session pages is an unrelated local `useState` variable.) |
| `lib/data/index.ts` | 14 | Barrel; zero `@/lib/data` imports — every consumer imports the concrete repo module. |

Delete alongside: `lib/__tests__/relearnPool.test.ts` (exists only to exercise the dead module).

### B. Fully dead symbols — zero uses anywhere, including inside their own file (verified)

Safe to delete the implementation, not just the `export` keyword:

- `lib/agents/runClient.ts`: `runAgentAndSave` (the file stays — `applyProposal` is live)
- `lib/agents/anthropic.ts`: `AnthropicTool` (type)
- `lib/forecastFsrs.ts`: `DEFAULT_I0`
- `lib/languages.ts`: `languageColor` → deleting it also orphans `defaultLanguageColor` (its only caller); delete both
- `lib/distractors.ts`: `deckSiblingAnswers` (its one in-file mention is a comment — update the comment)
- `lib/offline/localRepos.ts`: `localLadderDefault`, `localConfusionLinksForUser`
- `lib/routes.ts`: `ROUTE_ID_KEY`
- `lib/sessionLimits.ts`: `reviewTrackField`
- `engine/grading.ts`: `gradeMultiField`, `resolveAdaptiveSettings` — chain-check helpers/types that become orphaned once these go
- `engine/pipeline.ts`: `ratingToWasCorrect`
- `domain/index.ts`: `DEFAULT_FLEXIBLE_SETTINGS`, `LanguageSyncState`, `DeckCard` (only remaining mention is a section comment)

Corrections to HANDOFF §5.2 discovered during verification: `bestVoiceFor` (lib/speak.ts) and
`estimateBundleBytes` (lib/offline/download.ts) are **called internally** — they are de-export
candidates (group C), not deletions. `dedupeAgainst` (lib/distractors.ts) likewise has 6 internal uses.

### C. De-export candidates — exported but only used inside their own file (~75 symbols)

Full list reproducible with the scan (see "Method" below). Mechanical change: remove the `export`
keyword; the symbol stays. Low value on its own; the payoff is that once done, a tool like `knip`
can police dead exports automatically. Notable subtlety:

- **`domain/index.ts` types** (`PipelineId`, `StepType`, `SyncMode`, `SyncTrigger`,
  `SyncedCardStatus`, `GradingMode`, `ChangeField`, `SynonymFieldStatus`, `SynonymDueState`,
  `GradingFieldStatus`, `PipelineStepOrder`): each is referenced by *another type definition* in
  the same file. They can only be deleted if the referencing type is itself dead — otherwise just
  drop the `export`. Follow the chain per symbol at execution time.
- **Framework false positives — do not touch**: `app/api/sync/route.ts: maxDuration` and
  `app/layout.tsx: viewport` are Next.js magic exports read by the framework.

### D. Test-only exports (42 symbols)

Exported solely so tests can reach them. Mostly intentional and fine (pure engine functions,
FSRS internals, calibration constants). One cluster worth a decision from the user:
`lib/ladderSession.ts` has six (`rungUI`, `reshowDelayMs`, `pickIntervalDay`, `rungIsSingleStep`,
`DEFAULT_WRONG_WAIT_SECONDS`, `DEFAULT_CORRECT_WAIT_SECONDS`) referenced by nothing but tests —
HANDOFF flags that the UI may have stopped calling them, i.e. the *functions themselves* may be
vestigial, not just the exports. Needs a functional look, not a mechanical one.

### E. Dead database columns (verified: no snake_case or camelCase references in code)

| Column | Added | Why dead |
|---|---|---|
| `profiles.prefer_forvo` | 084 | Superseded by `audio_source_default` (088), which migrated its value |
| `profiles.goals_count_accelerated` | 062-era goals work | Auto-graduated cards are now hardcoded to never count toward goals |
| `user_scheduler_params.strict_spelling` | 066 | Superseded by `spelling_mode` (069) |
| `user_scheduler_params.strict_accents` | 066 | Superseded by `accents_mode` (069) |
| `user_scheduler_params.strict_articles` | 066 | Superseded by `articles_mode` (069) |

The legacy scheduler columns HANDOFF §5.3 mentions (`ease`, `lapse_cluster_count`,
`last_lapse_at`, `pending_interval_days`) were **already dropped by migration 091** — that
HANDOFF note is stale. `engine/scheduler.ts` is also already trimmed to 87 lines of three live
helpers; there is no scheduler dead code left to remove.

### F. Vestigial features — live code paths, removal changes behavior (permission required)

1. **`engine/pipeline.ts` + session-page pre-grad bookkeeping ("Ladder Stage 3")** — the legacy
   pipeline still runs `progressAfterReview` in all three session pages for production
   bookkeeping while FSRS overrides the schedule. Stripping it is the biggest cleanup in the repo
   and the reason the session pages are so large. Functional change; own project.
2. **Learning Pathways** — fully wired (engine `pathwayEngine.ts` 172 + `lib/pathway.ts` 188 +
   `lib/data/pathways.ts` 56 + `PathwayEditor.tsx` 283 + `PathwayCanvas.tsx` 315 + branches in
   `LadderStudy`/`LadderStudyCard`/`app/settings/ladders` ≈ **1,000+ lines**), opt-in, effectively
   unused, never runtime-verified. Removing it is a feature decision, not dead-code deletion.
3. **Session-page duplication** — the three session pages (~5,800 lines) are near-identical.
   Extracting a shared session hook is the highest-leverage efficiency refactor and the riskiest.

### G. Not dead — do not remove (false-positive shield)

- `@capacitor/core` / `@capacitor/ios` deps — consumed by the native build, not TS imports.
- `lib/agents/mcp/server.ts` — standalone entry point (`npx tsx lib/agents/mcp/server.ts`).
- `maxDuration` / `viewport` framework exports (see C).
- All 42 test-only exports outside the `ladderSession.ts` cluster.

### Housekeeping

- Move `supabase/migrations/105_reverse_dormancy_backfill.sql` into `archive/` (HANDOFF confirms
  it is applied; nothing reads the directory programmatically).
- Fold the corrections above (091 already dropped scheduler columns; scheduler.ts already
  trimmed; bestVoiceFor/estimateBundleBytes/dedupeAgainst are internal-use) back into HANDOFF §5.

---

## Phased plan

**Phase 0 — Baseline + housekeeping** — ✅ **DONE**
Baseline captured green (build 0, 452 tests / 38 suites). Migration 105 moved into `archive/`
(top level is now empty; next number = **106**), archive README title updated to `001–105`.
HANDOFF §5 rewritten to match reality.

**Phase 1 — Delete orphaned modules** — ✅ **DONE** (~680 lines incl. test)
Deleted the four files in (A) plus `lib/__tests__/relearnPool.test.ts`, and the `components/library/`
directory left empty behind `Library.tsx`. Suites went 38 → 37 exactly as predicted.

**Phase 2 — Delete fully dead symbols** — ✅ **DONE** (~16 symbols)
Every symbol in (B) deleted, chain-following the collateral each left behind — notably
`runAgentAndSave`'s private `proxyCallModel` helper plus five now-unreferenced imports, and the
orphaned type import in `engine/grading.ts` line 15. `defaultLanguageColor` went with `languageColor`
after confirming it had no other caller. `DeckCard` was deleted (not de-exported) per the correction
above. Live grading paths (`gradeTyping`, `classifyWrongAnswer`, `isDifferentWordMistake`) untouched.

**Phase 3 — De-export pass** — ✅ **DONE** (~86 symbols)
`export` removed from every internal-only symbol in (C), skipping the Next.js framework exports and
all 42 test-only exports. The `domain/index.ts` group was proven safe empirically (applied → tsc +
jest + build all green → reverted → re-applied deliberately), not just by reasoning.
**Still worth doing:** add `knip` (or `ts-prune`) as a dev dependency so this drift is caught
automatically from here on — it was not added as part of this pass.
**Still open (needs your call):** whether the `lib/ladderSession.ts` six (D) are vestigial *functions*
to delete or exports to keep. That's a functional question, so it was left alone.

**Phase 4 — Drop dead DB columns** — ⚠️ **WRITTEN, NOT APPLIED — needs your explicit go-ahead**
`supabase/migrations/106_drop_dead_columns.sql` exists and drops the five columns in (E), each with
`drop column if exists` (idempotent). All five were verified unread three ways, including a check that
no SQL function, RPC, trigger, view or RLS policy references them. **Nothing has been run against the
database.** This is the only irreversible step in the whole cleanup — dropping a column destroys its
data with no rollback — so it is parked pending sign-off. Apply by hand in the Supabase SQL editor.

**Phase 5 — Feature-level decisions** *(⚠ each requires explicit user approval and its own plan)*
Discuss separately, in rough order of value:
1. **Learning Pathways**: keep, or remove ~1,000+ lines of unused-but-live branching that every
   ladder change must not break.
2. **Ladder Stage 3**: strip `engine/pipeline.ts` bookkeeping from the session pages (HANDOFF
   open thread #1).
3. **Shared session hook**: dedupe the three ~2,000-line session pages.
4. **Analytics efficiency**: replace ~14k-row fetches with Postgres `GROUP BY` RPCs; lazy-load
   off-screen charts (HANDOFF open thread #2).

---

## Method (for reproducing the audit)

Export symbols extracted with `^export (async )?(function|const|let|class|interface|type|enum) NAME`
across all non-test files in `app/ components/ lib/ engine/ domain/`, then each name
word-boundary-grepped across all other production files and test files. Orphan modules found by
grepping for `/<basename>'` import specifiers. DB columns extracted from
`ADD COLUMN` statements across all migrations, checked in both snake_case and camelCase against
code, then cross-checked against later `DROP COLUMN` migrations. Caveats: string-built dynamic
access would evade the scan (none found for the symbols listed); `select('*')` reads exist in a
few repos but none map the five dead columns into domain objects.
