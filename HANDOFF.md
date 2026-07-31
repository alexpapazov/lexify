# Lexify — engineering handoff (2026-07-30)

The **broad** orientation document: what the app is, how each feature actually works, what's dead, and
what's unfinished. `CLAUDE.md` remains the deep chronological reference (every feature's full
implementation notes + error log); this file is the map you read first.

- **Scale**: ~48,700 lines across 217 TS/TSX files, 673 commits, 452 passing tests (38 suites).
- **Deployed**: `lexify-flax.vercel.app` (web, auto-deploys on push) + a Capacitor iOS app.
- **Backend**: Supabase (Postgres + Auth + RLS). Migrations `001`–`105`, applied BY HAND.

---

## 0. Ground rules (read before touching anything)

- **Never run `git commit` / `git push`.** Output a commit block for the user to run:
  ```
  cd "/Users/alexanderpapazov/Code/alex_creates/lexify" && git add -A && git commit -m "…" && git push && npm run build:cap && npx cap sync ios
  ```
  Use `git add -A` (a subfolder cwd silently misses files with `git add .`). **Never put `!` in a
  commit message** — zsh history expansion fails the commit and leaves files staged-but-uncommitted.
  Quote any `[bracket]` paths.
- **Migrations are applied by hand** in the Supabase SQL editor. Numbering is sequential;
  `001`–`104` live in `supabase/migrations/archive/`, **`105_reverse_dormancy_backfill.sql` is at the
  top level and has been applied** (safe to move into `archive/`). Next number = **106**.
- **Verify before proposing a commit**: `npm run build` + `npm test`.
- **The user studies on desktop web AND an iPhone.** The PWA gets changes on push; the **native app
  only updates after `npm run build:cap && npx cap sync ios` AND an Xcode rebuild.** "Did the fix
  land?" is usually a rebuild question.
- The user logs in with `alex_papazov@college.harvard.edu`.

---

## 1. What Lexify is

A vocabulary app with an Anki-style SRS, built around a **two-phase model**:

1. **Learning pipeline** ("the ladder") — a configurable, multi-rung climb that takes a brand-new
   word to graduation, usually in one sitting.
2. **Due Now** — post-graduation spaced repetition on an FSRS memory model, with several independent
   review *tracks* per card.

Everything else (goals, analytics, offline, agents, syncing) hangs off those two.

**Domain convention that is easy to get backwards:**
`Card.front` = the word in the **language being learned** (target/source language, e.g. Spanish).
`Card.back` = the **native** gloss (English). `promptSide` = what's shown; `answerSide` = what you
must produce.

---

## 2. Architecture

```
domain/index.ts     All shared types. Start here when changing data shapes.
engine/             PURE logic — no React, no Supabase. Unit-tested.
lib/                Client-side services: repos, caching, offline, agents, analytics math.
lib/data/*.ts       Repository layer (the ONLY place that talks to Supabase tables).
app/                Next.js App Router pages (all 'use client').
components/         UI, incl. session modes and the ladder.
supabase/migrations Hand-applied SQL.
```

**Engine modules** (`engine/`) — the heart, all pure and tested:

| File | Owns |
|---|---|
| `ladderEngine.ts` | The rung state machine: advance/drop-back/skip-ahead, graduation intervals |
| `pathwayEngine.ts` | Branched successor to the ladder (opt-in, barely used) |
| `fsrs.ts` | FSRS-5 memory math (Difficulty/Stability/Retrievability) |
| `dueNow.ts` | The decision layer over FSRS: relearn gates, un-graduation, typed→rating mapping |
| `grading.ts` | Typed-answer grading: normalization, near-misses, articles, accents |
| `confusion.ts` | Detecting and classifying "typed a different real word" |
| `pipeline.ts` | The LEGACY pre-ladder step machine — still used for production bookkeeping (§6) |
| `scheduler.ts` | Legacy interval scheduler — superseded by FSRS, partially retired |
| `density.ts`, `productionMode.ts` | Due-date smoothing; typed-vs-self-graded choice |

**Routing note**: there are **no dynamic route segments**. Everything is query params
(`/study/deck?deck=…`), because the Capacitor build is a static export and can't render arbitrary
`[id]` paths. Always build URLs via `lib/routes.ts`, never by hand.

---

## 3. How the features actually work

### 3.1 Learning pipeline (the ladder)

A card climbs configurable **rungs** (`mcq` / `typing` / `dictation` / `self_graded`), each with a
direction (produce target vs produce native). Configured per language pair in Settings → Ladders.

- **Advance rules** are OR-ed clauses (N times, in-a-row or total, minimum rating).
- **Drop-backs** send a card to an earlier rung on N failures; **skip-aheads** jump it forward on N
  successes. Drop-backs are evaluated FIRST, before any advance logic.
- **12-hour window**: the whole climb must finish within 12h of clearing the first rung, or it resets.
- **Interval-setting rung** = where a direction graduates:
  - **Good twice in a row → exactly 1 day** (next study day, turnover-aware).
  - **Easy → by lifetime error score**: ≤2 → 3–4 days, (2,3] → 2–3 days, >3 → 2 days.
    Errors are **weighted**: wrong (`again`/`miss`) = 1, slip (`hard`/`almost`) = 0.5. The score is
    `ClimbState.totalMessUps`, incremented **once centrally** in `reviewRung` so drop-backs and
    skip-aheads can't forgive the error that triggered them.
- **Card order is the LIST order** — nothing is shuffled. Caps (batch size, daily limit,
  stop-at-goal) limit *how many* cards enter, always taking them off the top of the list.
- **Ladder state** lives in `ladder_climb.state` as opaque JSONB — so adding fields to `ClimbState`
  needs no migration.

### 3.2 Due Now (post-graduation)

FSRS-5 schedules graduated cards. A card can be due on several **independent tracks**:

| Track | What it is | Columns |
|---|---|---|
| **Typed production** | always type the target | `typed_due_at` / `typed_interval_days` |
| **Smart typing** | typed while interval < threshold, then self-graded | `smart_due_at` / `smart_interval_days` |
| **Self-graded recall** | forward, no typing | `recall_due_at` / `recall_interval_days` |
| **Reverse recognition** | target→native, a SEPARATE `card_states` row | its own row, `review_direction='reverse'` |

- Typed and Smart are **mutually exclusive** — `activeProductionTrack()` picks the enabled lane.
- **Disabled tracks are "ghosted"**: their due dates persist but are never queued.
- **Relearn**: Again → a 5/10/20-minute loop that **keeps resurfacing this session** until it exits
  (two Goods in a row, or Easy). Three Agains in a row un-graduates the card back to the ladder.
- **Hint + Hard re-shows** instead of advancing (the recall wasn't cold).
- **"Almost"** (self-graded near-miss): logs a 0.3-weight event, bumps difficulty, re-queues 4 cards
  ahead, leaves the schedule alone. Available on normal reviews *and* the undo re-rate view.
- **Retention calibration**: measured retention feeds back into interval length as a multiplier,
  slew-limited to ±0.08/day within a **0.7–2.0** band. This is a damped controller — it creeps, never
  jumps (an earlier version replaced the multiplier outright and oscillated badly).

### 3.3 Dormancy

A card can be **dormant**: stays in the deck, manually studyable, never becomes due automatically.
Triggered manually or automatically after N production reviews (`dormancy_threshold`).
**Dormancy is per-direction** (migration 105): production and recognition each gate on their own
flag, so you can pause one and keep the other. "Make dormant now" and auto-dormancy both pause BOTH.

### 3.4 Goals and carryover

Per-language, per-weekday goals (`language_pairs.goals`). Three escalating modes:

1. **Plain** — today's configured goal.
2. **Yesterday carryover** — two toggles: carry shortfall / carry surplus. Bounded to one day.
3. **Full debt** — unbounded cumulative deficit since the enable date, with per-day waivers.

**The debt is DERIVED, not stored**: `plannedGoalSum` sums the *configured* goals and the deficit is
recomputed as `grads − planned` each day. That statelessness is load-bearing — it's why the **2.5×
cap** works. A day's goal is clamped to `capGoal()` = 2.5 × its configured value; the withheld
remainder stays in the running deficit and reappears tomorrow, capped again. An 8/day pair owing 25
drains 20 → 20 → 9 → 8. **Never cap `plannedGoalSum`** — that would delete the debt instead of
deferring it.

Also here: **"move today's load to tomorrow"** deferrals, and the rule that **auto-graduated cards
never count toward goals**.

### 3.5 Confusion handling

Typing a *different real word* on a production review is a discrimination failure, not a typo.
`respondToProductionConfusion` detects it against a whole-library front index, then:
links A↔B, penalizes **both cards' recognition tracks** (cuts D/S — FSRS-native, so it persists),
injects each word into the other's multiple-choice distractors, queues an immediate **A-vs-B drill**,
and interleaves linked pairs so they land near each other in future sessions.
Intra-language only (same learned language); cross-language pairs are logged but not penalized.

### 3.6 Typed grading

`gradeTyping()` normalizes and compares: case, accents, articles, slash-alternatives, parentheticals,
quoted literals. Per-category **strictness** (spelling / accents / articles) decides whether a
near-miss is a penalty or just a retype. Grammatical gender/number tags (`(f)`, `(pl)`) are stripped
from both sides and never graded. Language-aware article stripping via `ARTICLES_BY_LANG`
(es/fr/it/pt/de/**el**).

### 3.7 Offline + PWA + native

Toggle-based, online-primary. A **download** pulls a scope into IndexedDB (Dexie); the Supabase repos
transparently delegate to local versions when offline, so pages are unchanged. Every offline write
enqueues to an **outbox**; toggling back online drains it, with per-card **conflict resolution** for
card states. Installable PWA with a hand-written service worker; **device-verified** except the
sync-back leg (§7). The native iOS app is the same web build bundled by Capacitor.

### 3.8 Analytics

Three tabs: **Past** (review calendar), **Present** (snapshot + accuracy trend + learning efficiency),
**Future** (FSRS Monte-Carlo due forecast + vocabulary growth). All windows go through
`lib/analyticsData.ts` so the three Present components share one cached fetch each.

### 3.9 Agents

An AI card-editor with a scoped, audited **tool gateway** (`lib/agents/`), a change-set review flow,
and a deterministic (non-AI) **de-dupe** action. Also exposed as a standalone MCP server.

---

## 4. Performance model (hard-won — don't regress these)

The app got slow three separate ways, each with a different fix. All are documented in CLAUDE.md.

1. **Serial await chains.** Loaders ran 4–6 sequential awaits that had no data dependency. Every
   loader now fires everything keyed on the user id in ONE `Promise.all` wave.
2. **Per-deck N+1.** `listByDeck` per deck (2–4 round trips each) → bulk whole-library reads
   (`listAllForUser`, `listForDecks`, `deckIdsByCard`) grouped client-side.
3. **Payload.** Three column allowlists now exist in `lib/data/cards.ts`:
   - `BULK_CARD_COLUMNS` — counting/search. No audio, no `choices`.
   - `SESSION_CARD_COLUMNS` — study sessions. Has `choices`; **no audio**.
   - `listByDeck` — the ONLY read that ships `audio_data`/`audio_sources`. Correct when you need
     audio; **wrong for whole-library work.**
   Sessions hydrate stored clips for *queued cards only* (`lib/sessionAudio.ts`). **This matters
   beyond speed**: a "missing" clip gets regenerated via TTS and written back, permanently replacing
   a Forvo native recording.
4. **`lib/readCache.ts`** — 60s repo-level memoization with in-flight de-dupe. **Every repo write
   must call `invalidateReads(prefix)`** for its family; a missed bust shows up as "I answered cards
   but the count didn't move".
5. **Main-thread blocking.** Heavy synchronous work (FSRS forecasts, Monte Carlo) runs *after*
   `setLoading(false)` behind a `setTimeout(0)` yield.
6. **`lib/dates.ts` caches its `Intl.DateTimeFormat` instances.** Building one per row across ~14k
   rows cost hundreds of ms.

---

## 5. DEAD CODE AUDIT — **EXECUTED 2026-07-30**

Measured, not guessed: exports cross-referenced across all prod files, with test-only usage separated
out, then every deletion candidate adversarially re-verified (18 agents, refute-first) before removal.
**§5.1–5.3 are DONE.** Full findings + the phase plan live in `DEAD_CODE_CLEANUP.md`.

Post-cleanup gate: `npm run build` exits 0, `npx tsc --noEmit` clean, **37 suites / 447 tests pass**.
The 452→447 delta is exactly the deleted `lib/__tests__/relearnPool.test.ts` (1 suite, 5 tests) — no
test regressed and none was skipped to hide a failure.

### 5.1 Orphaned modules — ✅ DELETED

`components/library/Library.tsx` (356), `lib/autoSync.ts` (228), `lib/relearnPool.ts` (40) plus its
test, and the `lib/data/index.ts` barrel (14). The empty `components/library/` directory went too.

Two of these were live traps: the library UI actually lives inline in `app/library/page.tsx`
(`LibraryPageInner` / `LibraryPageBody`), and auto-sync is server-side in `lib/syncProcessor.ts` +
`/api/sync` — anyone editing the deleted files would have been editing nothing.

**Careful:** the `relearnPool` **useState variable** in the three session pages is unrelated to the
deleted module and is live — it holds the in-session relearn queue.

### 5.2 Dead exports in live modules — ✅ DONE

~16 symbols deleted outright and ~75 de-exported (kept, but no longer part of any module's public
surface). Deletions included `engine/grading.ts: gradeMultiField` + `resolveAdaptiveSettings`,
`engine/pipeline.ts: ratingToWasCorrect`, `lib/languages.ts: languageColor` + `defaultLanguageColor`,
`lib/distractors.ts: deckSiblingAnswers`, `lib/routes.ts: ROUTE_ID_KEY`,
`lib/sessionLimits.ts: reviewTrackField`, `lib/agents/runClient.ts: runAgentAndSave`,
`lib/offline/localRepos.ts: localLadderDefault` + `localConfusionLinksForUser`, and in
`domain/index.ts` the `DEFAULT_FLEXIBLE_SETTINGS`, `LanguageSyncState` and `DeckCard` fossils.

Corrections to the original findings list, discovered during verification — **do not "re-fix" these**:
`bestVoiceFor`, `estimateBundleBytes` and `dedupeAgainst` are called INTERNALLY, so they were
de-exported, not deleted. `maxDuration` (`app/api/sync/route.ts`) and `viewport` (`app/layout.tsx`)
look dead to any scanner but are **Next.js framework exports** — leave them alone.

De-exporting the `domain/index.ts` types is safe here specifically because tsconfig has `noEmit` and
never emits declarations, so TS4023/TS4033 ("exported variable has or is using private name") cannot
fire. If declaration emit is ever turned on, revisit.

**Still open:** the 42 test-only exports were left as-is. The `lib/ladderSession.ts` six (`rungUI`,
`reshowDelayMs`, `pickIntervalDay`, `rungIsSingleStep`, two wait constants) are worth a functional
look — they may be vestigial *functions*, not just over-exports.

### 5.3 Dead database columns — migration written, ⚠️ **NOT APPLIED**

`supabase/migrations/106_drop_dead_columns.sql` drops five verified-unread columns:
`profiles.prefer_forvo` (superseded by `audio_source_default`, 088),
`profiles.goals_count_accelerated` (the "auto-graduated cards never count toward goals" rule is now
hardcoded), and `user_scheduler_params.strict_spelling` / `strict_accents` / `strict_articles`
(superseded by `spelling_mode` / `accents_mode` / `articles_mode`, 069).

**This is the one irreversible step and it needs an explicit go-ahead before being run.** Note the
camelCase `strictSpelling` / `strictAccents` / `strictArticles` fields in TS ARE live — they read the
`*_mode` columns, not these booleans. Don't let the name collision scare you off, and don't rename them.

Correction: the legacy scheduler columns (`ease`, `lapse_cluster_count`, `last_lapse_at`,
`pending_interval_days`) were **already dropped by migration 091** — the old note here was stale.
Relatedly, `engine/scheduler.ts` is already trimmed to 87 lines of three live helpers; there is no
scheduler dead code left to remove.

### 5.4 Dead/vestigial features — **NOT touched by the 2026-07-30 cleanup**

Everything in this subsection changes behavior or removes a real feature, so it was deliberately left
alone. Each needs its own decision and its own plan.

- **`engine/scheduler.ts`** — already fully trimmed; all 87 remaining lines are live
  (`classifyReviewMode` / `graduationIntervalRange` / `isGraduatedDueByDate`). Nothing to remove.
- **`engine/pipeline.ts`** — the ORIGINAL 5-step learning pipeline, replaced by the ladder. Still
  called by all three session pages: `progressAfterReview` runs for its **production bookkeeping**
  (typed accuracy window, forced typing, reps/lapses) while FSRS overrides the schedule. This is the
  long-standing backlog item "**Ladder Stage 3** — strip the pre-grad pipeline from the session pages
  and delete the engine pipeline". It is the single biggest remaining cleanup and the reason the
  three session pages are ~1,700–2,300 lines each.
- **Learning Pathways** — fully built (engine, config, visual canvas editor, session integration) but
  **opt-in and effectively unused**; the app ships no prebuilt pathways. It's a parallel code path in
  `LadderStudy` that every ladder change must not break. Consider whether it earns its keep.
- **`@capacitor/core` / `@capacitor/ios`** show as unused dependencies — false positive; they're
  consumed by the native build, not imported in TS.
- **Agent-platform scaffolding now caller-less** — deleting `runAgentAndSave` left
  `lib/data/changeSets.ts: SupabaseChangeSetRepository.create` with no caller, and
  `lib/agents/runner.ts: runAgent` is now reached only by its own tests. Both were LEFT IN PLACE on
  purpose: they're building blocks for the planned Agent Platform Phases 3+ (grants UI, job queue,
  triggers), so removing them is a roadmap decision, not dead-code cleanup.

### 5.5 Structural duplication (not dead, but the top maintenance cost)

**The three session pages** (`app/study/{all,deck,folder}/session/page.tsx`) are near-identical and
total **~5,800 lines**. Almost every fix in this codebase has to be applied three times — including
`handleAnswer`, undo, relearn resurfacing, dormancy, IPA, and the Almost button. This is the highest-
leverage refactor available (extract a shared session hook), and also the riskiest.

---

## 6. Traps that have burned real time

- **Adding a column to a `profiles` SELECT before its migration is applied breaks the WHOLE query** →
  `data` is null → timezone/turnover/carryover silently reset to defaults. The study dashboard,
  LadderStudy and `lib/analyticsData.ts` have core-columns fallbacks. **`PresentSnapshot` now uses
  the shared hardened fetch; `ReviewCalendar` is the last unhardened profile read.**
- **The 1000-row cap.** PostgREST caps at 1000 and a client `.limit()` does NOT lift it — it
  truncates silently. Use `fetchAllRows` with a deterministic `.order()`, and chunk `.in()` lists
  (~400 ids).
- **`getToday(tz, turnoverHour)` owns "what day is it."** Both it and `localDateWithTurnover` default
  to UTC in their signatures — every caller must pass `timezone || deviceTimeZone()`, never
  `?? 'UTC'`. That fallback caused the "resets at midnight" bug.
- **Two "Loading…" screens.** The small faint one is `AuthWall`; the larger is the page. Knowing
  which you're stuck on tells you where to look.
- **Cached reads are shared objects** — treat as immutable, copy before sorting or patching.

---

## 7. Open threads

1. **Ladder Stage 3** — strip the legacy pipeline from the session pages (§5.4). Biggest cleanup.
2. **Analytics still ships rows to draw points.** Postgres `GROUP BY` RPCs would replace ~14k rows
   with ~30; off-screen charts still fetch eagerly instead of on scroll.
3. **Offline sync-back is device-unverified** — study offline, reconnect, confirm the outbox drains.
   This is the leg where data loss would actually appear.
4. **Learning Pathways never runtime-verified** with a real multi-day study run.
5. **Duplicate-card bugs `#55` / `#59`** — merge creates a new duplicate; exact duplicates can still
   be saved.
6. **`ReviewCalendar` profile read is unhardened** (§6).
7. **Scheduling "Stage B"** (learned per-feature interval model) — designed, explicitly **DEFERRED**.
   Do not start without the user reopening it.
8. **Calibration ceiling** was just raised 1.5 → 2.0 because every track had pinned at the old max.
   If they pin at 2.0 too, lower target retention instead of raising it again.

---

## 8. Feature documentation

`features/` holds deep per-feature docs — **read the relevant one in full before changing that
feature, and update it afterward.** Each carries its own error log.

`Learning Pipeline.md` · `Due Now.md` · `Typed Grading.md` · `Confusion Handling.md` ·
`Language Syncing.md` · `Card Data.md` · `Agent Platform.md` ·
`Learning Pathways (proposal).md` · `FSRS Scheduler (proposal).md` ·
`Configurable Pipeline (proposal).md`

---

The user iterates fast and values honest pushback over agreement. If a request has a cleaner design
or a hidden gotcha, say so before building.
