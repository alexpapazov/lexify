# Lexify — engineering handoff (2026-07-30)

The **broad** orientation document: what the app is, how each feature actually works, what's dead, and
what's unfinished. `CLAUDE.md` remains the deep chronological reference (every feature's full
implementation notes + error log); this file is the map you read first.

- **Scale**: ~50,300 lines across 222 TS/TSX files, 678 commits, 525 passing tests (41 suites).
- **Deployed**: `lexify-flax.vercel.app` (web, auto-deploys on push) + a Capacitor iOS app.
- **Backend**: Supabase (Postgres + Auth + RLS). Migrations `001`–`108`, applied BY HAND — **all
  applied, nothing pending.**

---

## 0. Ground rules (read before touching anything)

- **Never run `git commit` / `git push`.** Output a commit block for the user to run:
  ```
  cd "/Users/alexanderpapazov/Code/alex_creates/lexify" && git add -A && git commit -m "…" && git push && npm run build:cap && npx cap sync ios
  ```
  Use `git add -A` (a subfolder cwd silently misses files with `git add .`). **Never put `!` in a
  commit message** — zsh history expansion fails the commit and leaves files staged-but-uncommitted.
  Quote any `[bracket]` paths.
- **Migrations are applied by hand** in the Supabase SQL editor. Numbering is sequential.
  `001`–`108` are all applied and all live in `supabase/migrations/archive/`. **The top level is
  empty, which is the signal that nothing is pending** — put a new migration there, tell the user to
  run it, and move it into `archive/` once it's live. Next number = **109**.
- **Verify before proposing a commit**: `npm run build` + `npm test` (green = build exits 0 and
  **41 suites / 525 tests** pass). `npx tsc --noEmit` also reports 8 errors in
  `.next/dev/types/validator.ts` about missing `app/**/[id]/page.js` modules — those are **stale dev
  artifacts** from the old dynamic routes, present at baseline, and not something you introduced.
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
| `pipeline.ts` | The LEGACY pre-ladder step machine — still used for production bookkeeping (§5.1) |
| `scheduler.ts` | 87 lines, all live: `classifyReviewMode`, `graduationIntervalRange`, `isGraduatedDueByDate`. The old interval-multiplier scheduler it's named after is long gone |
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

**Side visibility (2026-07-31):** the agent can be restricted to seeing only fronts, only backs, or
both — so it isn't swayed by the side you don't care about. A blinded agent **may not edit that side**
(it can't know the current text), and `split` needs backs. The review UI always shows the whole card.

**De-dupe (2026-07-31):** one proposal per duplicate GROUP, in two modes (*same word* / *exact
copies*). Every copy is rendered in full — keeper in normal ink, doomed ones red — and clicking a card
makes it the keeper. The default keeper is **the copy with the most review progress**, so approving
can't silently discard months of study for a fresh import. **A scope must be selected**; it no longer
falls back to the whole library.

### 3.10 Vocabulary onboarding (new 2026-07-30)

Bulk intake for words you already know — paste a frequency list, rate confidence, skip the ladder.
**Create → "Onboard vocabulary"** → AI accuracy check → front-only duplicate drop → rate each card
1–4 at `/study/deck/onboard`. Bands 2/3/4 graduate immediately, centred on **7 / 30 / 180 days**
(windows 3–11 / 15–45 / 126–234, spread against existing load); band 1 leaves the card untouched for
the ladder. Writes both direction rows as `bulk_known` (excluded from goals). Resumable — the deck
page shows "Finish onboarding" while `card_onboarding` rows remain unrated.

Full detail in `features/Vocabulary Onboarding.md`. Migration 107 applied 2026-07-30.

Side effect worth knowing: `INPUT_WORD_CAP` is now **5000**, and *all* AI card generation goes through
`lib/generateCards.ts`, which chunks. Calling `/api/cards/generate` directly with a big input
truncates at 150 cards with no error.

### 3.11 Batch deck import (new 2026-07-30)

Create has a **"Single deck / Batch of decks"** toggle. Batch mode reads a `.docx` **locally — no AI,
no upload** — and turns its heading structure into folders and decks (a heading with word lines under
it is a deck; a heading with only sub-headings is a folder), then saves the decks one at a time through
the normal two-step duplicate check, with "Remove all duplicates" / "Ignore all" / "Skip this deck".
Parser in `lib/docx.ts` (zip via `DecompressionStream`, no new dependency). Full detail in
`features/Batch Deck Import.md`. No migration.

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

## 5. Vestigial code and structural debt

A dead-code cleanup ran on 2026-07-30 (commit `7bf1648`): 5 orphaned modules, ~16 unused symbols and
~86 over-exports removed, plus migration `106` dropping 5 unread columns. **That work is closed** —
`DEAD_CODE_CLEANUP.md` has the record if you ever need it; don't re-litigate it. What follows is what
it deliberately did NOT touch, because each item changes behavior and needs its own decision.

Two leftovers from that pass that a scanner will flag again — **they are not bugs**: a handful of
symbols (`bestVoiceFor`, `estimateBundleBytes`, `dedupeAgainst`, most of `domain/index.ts`'s type
aliases) are used only inside their own file, so they're intentionally non-exported. And `maxDuration`
(`app/api/sync/route.ts`) / `viewport` (`app/layout.tsx`) look unused but are Next.js framework
exports. Leave all of them alone.

### 5.1 Vestigial features

- **`engine/pipeline.ts`** — the ORIGINAL 5-step learning pipeline, replaced by the ladder. Still
  called by all three session pages: `progressAfterReview` runs for its **production bookkeeping**
  (typed accuracy window, forced typing, reps/lapses) while FSRS overrides the schedule. This is the
  long-standing backlog item "**Ladder Stage 3** — strip the pre-grad pipeline from the session pages
  and delete the engine pipeline". It is the single biggest remaining cleanup and a large part of why
  the three session pages are ~1,700–2,300 lines each.
- **Learning Pathways** — fully built (engine, config, visual canvas editor, session integration) but
  **opt-in and effectively unused**; the app ships no prebuilt pathways. It's a parallel code path in
  `LadderStudy` that every ladder change must not break. Roughly 1,000+ lines across
  `engine/pathwayEngine.ts`, `lib/pathway.ts`, `lib/data/pathways.ts`, `PathwayEditor`/`PathwayCanvas`
  and branches inside `LadderStudy`. Worth asking whether it earns its keep.
- **Agent-platform scaffolding with no caller** — `lib/data/changeSets.ts: create` and
  `lib/agents/runner.ts: runAgent` (test-only) are building blocks for the planned Agent Platform
  Phases 3+ (grants UI, job queue, triggers). Left in place on purpose; removing them is a roadmap
  decision.
- **`lib/ladderSession.ts`** has six symbols reached only by their tests (`rungUI`, `reshowDelayMs`,
  `pickIntervalDay`, `rungIsSingleStep`, two wait constants). Unresolved question: did the UI stop
  calling them, or did the feature move? Needs a functional look, not a mechanical one.
- **`@capacitor/core` / `@capacitor/ios`** show as unused dependencies — false positive; they're
  consumed by the native build, not imported in TS.

### 5.2 Structural duplication (not dead, but the top maintenance cost)

**The three session pages** (`app/study/{all,deck,folder}/session/page.tsx`) are near-identical and
total **~5,800 lines** (deck 2,325 · all 1,800 · folder 1,693). Almost every fix in this codebase has
to be applied three times — including `handleAnswer`, undo, relearn resurfacing, dormancy, IPA, and
the Almost button. **If you fix a session bug, check whether it needs applying to all three.** This is
the highest-leverage refactor available (extract a shared session hook), and also the riskiest.

Other files big enough to need care: `components/CardEditModal.tsx` (2,128), `app/study/deck/page.tsx`
(2,065), `app/library/page.tsx` (1,676), `app/study/page.tsx` (1,339).

---

## 6. Traps that have burned real time

- **Adding a column to a `profiles` SELECT before its migration is applied breaks the WHOLE query** →
  `data` is null → timezone/turnover/carryover silently reset to defaults. The study dashboard,
  LadderStudy and `lib/analyticsData.ts` have core-columns fallbacks. **`PresentSnapshot` now uses
  the shared hardened fetch; `ReviewCalendar` is the last unhardened profile read.**
- **The 1000-row cap.** PostgREST caps at 1000 and a client `.limit()` does NOT lift it — it
  truncates silently. **This bit hard on 2026-07-31**: `cardRepo.listOwned` had no paging, so every
  duplicate check and the merge picker were blind past the first 1000 cards of a pair — the real
  reason a mass import leaked duplicates. Assume any unpaged `select` is a latent version of this. Use `fetchAllRows` with a deterministic `.order()`, and chunk `.in()` lists
  (~400 ids).
- **`getToday(tz, turnoverHour)` owns "what day is it."** Both it and `localDateWithTurnover` default
  to UTC in their signatures — every caller must pass `timezone || deviceTimeZone()`, never
  `?? 'UTC'`. That fallback caused the "resets at midnight" bug.
- **Two "Loading…" screens.** The small faint one is `AuthWall`; the larger is the page. Knowing
  which you're stuck on tells you where to look.
- **Cached reads are shared objects** — treat as immutable, copy before sorting or patching.
- **Duplicate detection has THREE tiers** (`lib/duplicates.ts`): `exact` (front+back), `near`
  (front+back after articles/case), and `front` (same word, different gloss — added 2026-07-31,
  because nothing matched on the front alone and mass imports leaked duplicates through that hole).
  Batch import uses front-only outright; create/deck-add add `front` as an extra flag;
  `bulkCreate`'s silent reuse stays exact-only on purpose. Homographs land in the `front` tier by
  design — it flags, never blocks.
- **Name collisions that mislead.** `relearnPool` is a live `useState` variable in the three session
  pages holding the in-session relearn queue (the similarly-named module is gone — don't confuse
  them). And the TS fields `strictSpelling` / `strictAccents` / `strictArticles` read the
  `spelling_mode` / `accents_mode` / `articles_mode` columns, NOT the `strict_*` booleans, which were
  dropped in migration 106.

---

## 7. Open threads

Roughly in priority order. Nothing here is half-written — the tree is clean and every migration is
applied, so any of these is a clean start.

0. **Vocabulary onboarding + batch deck import are unexercised against a real account.** Both are
   code-complete, build/test-verified, and their migrations are live, but neither was clicked through
   (the flows are behind auth). First run to watch for onboarding: rate a handful of words, then check
   the deck's Due Now counts and the ℹ panel's per-track schedules. For batch import: confirm the
   folder tree lands where expected and the per-deck duplicate check behaves across successive decks.
1. **Ladder Stage 3** — strip the legacy pipeline from the session pages (§5.1). Biggest cleanup, and
   it shrinks the three session pages that §5.2 is about.
2. **Offline sync-back is device-unverified** — study offline, reconnect, confirm the outbox drains.
   This is the leg where data loss would actually appear, so it's the highest-risk unknown.
3. **Duplicate-card bugs `#55` / `#59`** — merge creates a new duplicate; exact duplicates can still
   be saved. Partly mitigated 2026-07-31 by the front-only tier (§6), but the underlying
   `bulkCreate` silent-reuse contract is unchanged: it still matches exact front+back only and gives
   the caller no signal about what it did, so a UI verdict the user overrides still inserts a row.
   **Six normalizations still coexist** across the intake paths (tier-1, tier-2, `normalizeFrontKey`,
   the `|||` textarea key, `lib/generateCards.ts`, and bare `toLowerCase()` at the deck-page/sync
   sites); NFC is now in the first three but not the rest. **There is no DB-level uniqueness at all** —
   no unique index on `cards(front)` or `(front, back)`. Application code is the only gate.
4. **Analytics still ships rows to draw points.** Postgres `GROUP BY` RPCs would replace ~14k rows
   with ~30; off-screen charts still fetch eagerly instead of on scroll.
5. **`ReviewCalendar` profile read is unhardened** — it's the last one without the core-columns
   fallback (§6, first bullet).
6. **Learning Pathways never runtime-verified** with a real multi-day study run — related to the
   keep-or-cut question in §5.1.
7. **Calibration ceiling** was raised 1.5 → 2.0 because every track had pinned at the old max.
   If they pin at 2.0 too, lower target retention instead of raising it again.
8. **Scheduling "Stage B"** (learned per-feature interval model) — designed, explicitly **DEFERRED**.
   Do not start without the user reopening it.
9. **Card connection agent** — designed and PAUSED mid-conversation; see
   `features/Card Connection Agent (proposal).md`. Its infrastructure audit found a **real bug worth
   fixing on its own**: `synonymGroups.addMember` cannot merge two groups, so declaring A≡B when each
   already belongs to a group strands the other group's members instead of forming one equivalence
   class. Confusion links were audited and are already correct.

---

## 8. Feature documentation

`features/` holds deep per-feature docs — **read the relevant one in full before changing that
feature, and update it afterward.** Each carries its own error log.

`Learning Pipeline.md` · `Due Now.md` · `Typed Grading.md` · `Confusion Handling.md` ·
`Language Syncing.md` · `Card Data.md` · `Agent Platform.md` · `Vocabulary Onboarding.md` ·
`Batch Deck Import.md` · `Learning Pathways (proposal).md` · `FSRS Scheduler (proposal).md` ·
`Configurable Pipeline (proposal).md` · `Card Connection Agent (proposal).md`

---

The user iterates fast and values honest pushback over agreement. If a request has a cleaner design
or a hidden gotcha, say so before building.
