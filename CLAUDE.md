# Lexify — project memory

This file is the persistent context for working on Lexify across separate
chat sessions. Read it at the start of any session touching this codebase.
Update it (briefly) whenever you ship a feature or learn something a future
session would need.

## Feature documentation

Detailed explanations of how each major feature works live in `features/`.
**Before changing any feature that has a file there, read it in full.**
**After making changes, update the file to reflect what changed.**
Each file also contains an error log — add any bugs found and fixed to it.
Current feature files:

- `features/Learning Pipeline.md` — how a card moves from unlearned to
  graduated: the 5-step pipeline, same-day window, typing mistake streak,
  I-don't-know penalty, session queue building
- `features/Due Now.md` — post-graduation spaced repetition: interval
  multipliers, multiplier decay, timing classification (elective/due/very-early),
  10-minute relearn loop, lapse clustering, production mode (typed vs. self-graded)
- `features/Language Syncing.md` — auto-generating cards in a second language
  pair: sync rules, triggers, modes, translation API, duplicate detection,
  folder/deck infrastructure, manual review flow, settings UI
- `features/Typed Grading.md` — per-category typed-answer strictness
  (spelling/accents/articles: strict=penalty vs lenient=no penalty, always
  retype), weighted near-miss (0.2/0.3), `typing_error_marks` capture for
  future practice modes. **Fully wired for Due Now typed reviews (TypingMode +
  all 3 session pages). Needs migration 066.** Pre-grad typing + synonym-group
  typed production not yet covered.

## ⚠️ Pending from 2026-06-15 session(s) — verify before relying on this

These sessions implemented and **committed/pushed**: TypingMode
never-auto-advance, the stages 3-5 same-day window (`stage3EnteredDate`,
migration 024), persisted typed-answer overrides (`typed_answer_overrides`,
migration 025), confusion-driven distractor promotion (`answer_side` /
`is_word_mixup` on `card_confusions`, migration 026), per-category
"Study" buttons + an elective-study picker on the deck detail/session pages,
elective session batch-cap (migration 027, `elective_session_limit`),
"Study [Category]" button above filtered card list, "Study ahead" button
on session done screen — see the dated subsections below for details.

As of the end of the latest session:

- `npm run build` / `npm test` **not yet confirmed** by the user for the
  latest changes (027 + "Study ahead" + category button above card list).
- Migration `027_elective_session_limit.sql` **not yet applied** in Supabase.
- Migrations `024_stage3_same_day_window.sql`,
  `025_typed_answer_overrides.sql`, and
  `026_card_confusion_word_mixups.sql` — status of application in Supabase
  is unknown (user should verify).
- `?category=` support was added to all three session pages in the latest
  session (2026-06-15): `study/[deckId]/session`, `study/folder/[folderId]/session`,
  and `study/all/session`. All three support `?category=new|learning|graduated|due`.
  Folder and all-session use a hardcoded `FOLDER/ALL_ELECTIVE_LIMIT = 20`.
  "Study ahead" in folder/all sessions is a page reload (router.push to same URL);
  the deck session tracks remainingElective in-memory for seamless continuation.
- The per-stat-box "Study" buttons were **removed** from the deck detail page
  stat boxes; the category study button appears above the filtered card list instead.
- `study/[deckId]/page.tsx`: "Study [Category]" button above filtered card list.
- `library/[folderId]/page.tsx`: "Study [Category]" button above filtered card list → folder session.
- `library/page.tsx` (pairing view): "Study [Category]" button above filtered card list → all session.

If you're picking this up: check whether these migrations are live before
assuming this work is fully deployed or debugging it as "broken".

## Locating this codebase (read this first)

The real "Lexify" app — the one deployed at lexify-flax.vercel.app — lives at:

    /Users/alexanderpapazov/Code/alex_creates/lexify

(Renamed 2026-07-09 from `.../alex_creates/lang_learn_app`; the old path no
longer exists.)

If you don't already have access to this folder, **ask the user for access
before doing anything else** (e.g. via the cowork directory-connection tool).
Do not assume any other connected folder is this project — in particular,
there is a separate, older/divergent folder elsewhere in this user's
workspace (`.../Documents/Claude/Projects/Language Learning Application/
lang_learn_app`, branded "LinguaStage") that is **not** Lexify and should not
be read or edited for Lexify work.

Once you have access, before making any changes:

1. Read this file (`CLAUDE.md`) in full.
2. Read `domain/index.ts`, all of `engine/*.ts` (`pipeline.ts`, `scheduler.ts`,
   `grading.ts`, `productionMode.ts`, `density.ts`), `lib/data/interfaces.ts`
   and the relevant `lib/data/*.ts` repo implementations, the
   `components/session/*.tsx` UI, the `app/study/**` pages, and the most
   recent `supabase/migrations/*.sql` files — enough to build an accurate,
   *current* understanding of how the pipeline, grading, scheduler,
   distractors, and confusion-tracking actually work (this file describes the
   state as of the last update, but the code is the source of truth).
3. If asked to plan or scope a change, report your understanding back to the
   user for correction first — don't start implementing until that's
   confirmed.

## What Lexify is

A Quizlet-style vocabulary app with an Anki-style spaced-repetition engine,
intended to grow into a broader language-learning tool (spoken + signed
languages, AI-assisted features). Currently focused on a Spanish↔English
vocabulary pipeline, but the domain model is language-pair-generic.

## Tech stack

- Next.js App Router + TypeScript (strict mode), all pages are `'use client'`.
- Supabase (Postgres + Auth + RLS) as the backend. SQL migrations live in
  `supabase/migrations/`, numbered sequentially (`001_...` through
  `029_...` as of 2026-06-15).
- Tailwind for styling.
- Jest for engine unit tests (`npm test`).
- `lib/dates.ts` — `getToday(tz?)` utility for timezone-aware YYYY-MM-DD dates.

## Directory layout

- `domain/index.ts` — all shared TypeScript types (`Card`, `Pipeline`,
  `PipelineStep`, `CardState`, `ReviewInput`, `ReviewEvent`, `CardConfusion`,
  `GradingSettings`, etc.). Start here when changing data shapes.
- `engine/` — pure, framework-free logic (no React/Supabase imports). This is
  the core SRS/pipeline logic:
  - `pipeline.ts` — `progressAfterReview()` (the pipeline state machine) and
    `initialCardState()`.
  - `scheduler.ts` — post-graduation spaced-repetition scheduling (interval
    growth, lapse clustering, relearn-loop, "very early review is a no-op"
    threshold).
  - `grading.ts` — `gradeTyping()` (normalizes/compares typed answers —
    case, accents, articles, slash-alternatives, parentheticals) and
    `classifyWrongAnswer()` (severity 0–1 for scheduling impact).
  - `productionMode.ts` — constants/logic for when a post-graduation review
    is typed vs. self-graded flashcard.
  - `density.ts` — smoothing helper for the due-cards forecast chart.
  - `__tests__/` — Jest tests for all of the above. Run with `npm test`.
- `lib/data/` — repository layer (Supabase access). One file per entity
  (`cards.ts`, `cardStates.ts`, `cardConfusions.ts`, `pipelines.ts`,
  `decks.ts`, `folders.ts`, `deckPreferences.ts`, `languagePairs.ts`,
  `dismissedPairs.ts`, `reviewEvents.ts`), plus `interfaces.ts` defining the
  repository contracts and `index.ts` re-exporting them.
- `app/` — pages (App Router):
  - `study/[deckId]/session/page.tsx`, `study/all/session/page.tsx`,
    `study/folder/[folderId]/session/page.tsx` — the three study-session
    pages. They share **nearly identical** `handleAnswer` logic; when fixing
    a session bug, check whether the fix needs to be applied to all three.
  - `study/[deckId]/page.tsx` — deck detail (stats, confusions, edit links).
  - `study/[deckId]/edit/page.tsx`, `study/[deckId]/add/page.tsx` — card
    editing / AI-assisted card generation.
  - `library/`, `upload/`, `browse/`, `profile/`, `settings/`, `auth/`,
    `study/page.tsx` (dashboard with due-forecast chart).
- `components/session/` — `FlashcardMode.tsx`, `MultipleChoiceMode.tsx`,
  `TypingMode.tsx`, `RatingButtons.tsx` — the per-step UI renderers.
- `components/library/Library.tsx`, `components/nav/Navbar.tsx`,
  `components/LanguageCombobox.tsx`.
- `supabase/migrations/` — sequential SQL migrations (see below).

## Domain conventions (important — easy to get backwards)

- `Card.front` = the word/phrase in the **language being learned** (source
  language, e.g. Spanish).
- `Card.back` = the word/phrase in the learner's **native/basis language**
  (target language for translation purposes, e.g. English).
- `PipelineStep.promptSide` = which side is *shown* to the learner.
  `PipelineStep.answerSide` = which side the learner must *produce*
  (pick in multiple choice, or type).
- `step.stepType` is `'recognition'` (multiple choice) or `'typing'`.

## The learning pipeline (core feature)

Each card has a `CardState` tracking `currentStepOrder`, `correctInStep`,
`graduated`, plus SRS fields (`dueAt`, `intervalDays`, `ease`, `reps`,
`lapses`, lapse-clustering fields, typed-production fields, etc.).

`engine/pipeline.ts: progressAfterReview()` is the state machine:

- **Pre-graduation**: generically finds
  `sortedSteps.find(s => s.stepOrder > state.currentStepOrder)`. If a card
  completes `requiredCorrect` correct answers on its current step, it moves
  to the next step (or graduates if there is none). This means **adding a
  new pipeline step is just a migration insert** — no engine code changes
  needed.
- **Post-graduation**: hands off to `scheduler.ts` for interval scheduling,
  lapse clustering, and the relearn loop (3 close-together lapses sends a
  graduated card back into the pipeline at step 0).

### Default pipeline (`00000000-0000-0000-0000-000000000001`) — 5 steps

As of migration 023, the default pipeline has 5 steps (`step_order` 0–4):

0. **recognition**, prompt=front, answer=back, requiredCorrect=1 —
   Spanish shown, pick English (multiple choice with distractors).
1. **recognition**, prompt=back, answer=front, requiredCorrect=1 —
   English shown, pick Spanish.
2. **typing**, prompt=back, answer=front, requiredCorrect=2 —
   English shown, type Spanish. Must get this right **twice in a row**
   before moving on.
3. **typing**, prompt=front, answer=back, requiredCorrect=1 —
   Spanish shown, type English (only needs 1 correct, unlike step 2's 2-in-a-row).
4. **recognition**, prompt=front, answer=back, requiredCorrect=1 —
   *(new, migration 023)* one final Spanish→English multiple-choice check
   before the card graduates.

### Same-day window for stages 3-5 (migration 024, this session 2026-06-15)

The last 3 steps of the default pipeline (stages 3-5: typing back→front x2,
typing front→back x2, final front→back recognition) must all be completed
**on the same calendar day** for a card to graduate. Generically, the
"window" is `sortedSteps.slice(-3)` — the final 3 steps of *any* pipeline,
not hardcoded to the 5-step default.

- Tracked via `CardState.stage3EnteredDate` (ISO date `YYYY-MM-DD`, column
  `card_states.stage3_entered_date`, migration 024). Set to "today" whenever
  the card enters the window's first step (stage 3).
- In `engine/pipeline.ts: progressAfterReview()`: when the learner passes a
  step *inside* the window (but not the first step of the window) on a
  different calendar day than `stage3EnteredDate`, the card is sent back to
  the window's first step (stage 3), `correctInStep` resets to 0, and
  `stage3EnteredDate` is reset to today (restarting the window).
- `stage3EnteredDate: null` (new/legacy cards that haven't reached the window
  yet) skips this check entirely — backward compatible.
- This rule is **independent of and coexists with** the typing-mistake-streak
  → stage-1 redo below: that path returns via spread and leaves
  `stage3EnteredDate` untouched, so a stage-1 redo doesn't reset the same-day
  window's start date.

### Typing-mistake-streak → multiple-choice redo (migration 022)

Tracked via `CardState.typingMistakeStreak` / `typingFailCycles` (stored
per-card, not per-step, so it applies whether the learner is typing Spanish
*or* English):

- 3 wrong typing answers in a row = 1 "fail cycle" (streak resets to 0).
- On the **3rd fail cycle** (i.e. 9 wrong-in-a-row typing answers, in groups
  of 3), the card is sent back to `sortedSteps[0]` (step 0), which naturally
  flows through step 1 too — so the learner redoes **both** recognition
  directions before resuming typing.
- A correct typing answer resets `typingMistakeStreak` to 0 immediately.

### TypingMode never auto-advances (this session, 2026-06-15)

`components/session/TypingMode.tsx`:

- Checking an answer never auto-advances. The learner must press **Continue**
  or hit **Enter** (inputs/buttons are auto-focused) to move to the next
  card, in every scenario — including after a correct "retype the answer"
  step.
- Wrong answers (and answers marked "Override as incorrect") require
  retyping the correct answer. Once `gradeTyping()` says the retype is
  correct, a Continue button appears (Enter also works); advancing always
  counts as rating `'again'`.
- Override controls are labeled **"Override as correct"** /
  **"Override as incorrect"** / "Undo override" (renamed from "Actually mark
  right/wrong" this session).

### Persisted typed-answer overrides (migration 025, this session 2026-06-15)

`typed_answer_overrides` table (one row per `user_id, card_id, answer_side,
answer_text`, `answer_text` stored as `gradeTyping()`'s `normalizedUser`) +
`lib/data/typedAnswerOverrides.ts: SupabaseTypedAnswerOverrideRepository`
(`listForUser`/`add`/`remove`, imported directly — not re-exported from
`lib/data/index.ts`, same as `cardConfusions`).

- All 3 session pages load every override for the user once at session start
  into a `Map<string, Set<string>>` keyed by `` `${cardId}:${answerSide}` ``,
  and pass the relevant set to each `TypingMode` as `overrideAnswers`, plus a
  `handleOverrideAnswer(cardId, answerSide, answerText, accept)` callback as
  `onOverrideAnswer` (fire-and-forget, `.catch(console.error)`).
- In `TypingMode.tsx`: `check()` computes `gradeTyping()`'s `normalizedUser`
  and treats the answer as correct (`viaOverride: true`) if it's a naturally
  wrong answer that matches a persisted override — shown as "(remembered
  override)".
- `setOverrideAndPersist()` wraps the three override buttons:
  - "Override as correct" on a naturally-wrong answer → persists an add.
  - "Override as incorrect" on an answer that was correct *only* via
    `viaOverride` → persists a remove. Naturally-correct answers marked
    incorrect stay session-local (not persisted), as before.
  - "Undo override" reverses whichever of the above the current `override`
    state represents.

## Elective study mode (this session, 2026-06-15)

Two related additions, both scoped to `study/[deckId]/page.tsx` (deck detail)
and `study/[deckId]/session/page.tsx` (session) only — **not** `study/all` or
`study/folder/[folderId]`.

### Per-category "Study" buttons (deck detail page)

Each of the 4 stat boxes (Unlearned / Learning / Graduated / Due Now) now has
its own "Study" button below the existing clickable filter-link area, linking
to `/study/[deckId]/session?category={new|learning|graduated|due}`. The
button is disabled (greyed `<span>`, not a link) when that category's count is
0.

### `?category=` queue building (session page)

`study/[deckId]/session/page.tsx` reads `?category=` via `useSearchParams()`.
When present (`StudyCategory = 'new' | 'learning' | 'graduated' | 'due'`),
`load()` takes an early branch that builds the queue from **only** that
category — matching the deck-detail stat counts exactly — and skips all
new-card-budget / daily-limit logic entirely:

- `new` → cards with no `CardState` (via `initialCardState()`).
- `learning` → cards with a state where `!graduated`.
- `graduated` → cards with `state.graduated === true` (any due date).
- `due` → cards with `state.graduated === true && dueAt <= now`.

Each category's queue is shuffled and passed to the shared `finalizeQueue()`
helper (prefetch + confusion-promotion — extracted from the old inline logic
so it can run from multiple call sites). `electiveSession` is set to `true`
and the in-session banner shows a category-specific message
(`CATEGORY_BANNER`). If the category is empty, the "done" screen shows
`CATEGORY_EMPTY_MESSAGE[category]` instead of the generic "all caught up"
copy.

### Elective session batch cap (migration 027)

Elective and category sessions are capped at a configurable number of cards
per batch (default: 20). Controlled via `DeckPreferences.electiveSessionLimit`
(`user_deck_preferences.elective_session_limit`): `null` → 20 (default),
`0` → no cap, positive integer → cap at that value.

- **As of 2026-06-15 (refactor)**: `DeckSettingsPanel` no longer shows a
  separate "Cap elective/study-ahead sessions" section. The elective cap is
  now always set equal to `cardsPerSession` when batch mode is on, and 0
  (disabled) when batch mode is off. `handleSave()` sets
  `electiveSessionLimit = cardsPerSessionOn ? cardsPerSession : 0`.
- In `study/[deckId]/session/page.tsx`, after building any elective/category
  queue, the first `batchLimit` cards go into the session queue and the rest
  are stored in `remainingElective` state.
- The session done screen shows a "Study ahead (N more)" button when
  `electiveSession && remainingElective.length > 0`. Clicking it runs
  `continueElectiveSession()`, which pulls the next batch from `remainingElective`
  and calls `finalizeQueue()` without a page reload.
- `study/[deckId]/page.tsx`: when a category filter is active (`?filter=`),
  a "Study [Category]" button now appears above the filtered card list,
  linking to `?category=` on the session page.

### Elective picker (session page, no `?category=`)

Previously, when the normal new/due queue was empty, the session silently
auto-loaded not-yet-due graduated cards ("electiveCards"). This is now a
user choice:

- If `unlearnedCards` (beyond today's budget) and/or `electiveCards`
  (graduated, not yet due — "early review") are non-empty, `load()` sets
  `electivePickerData` and `showElectivePicker = true` instead of
  auto-starting.
- The `ElectivePicker` component (bottom of the session page file) shows a
  checkbox per non-empty category ("Unlearned" / "Early review"), each
  pre-checked, with a "Start studying" button (disabled if both are
  unchecked).
- `startElectiveSession({ unlearned, earlyReview })` combines the selected
  pools, shuffles, sets `electiveSession = true`, and calls
  `finalizeQueue()`.
- If *both* pools are empty, the old "Session complete!" screen is shown
  as before (nothing to elect into).

### TypingMode Enter-to-submit/Enter-to-continue — already correct, no change

Verified against the existing implementation (see "TypingMode never
auto-advances" above): the typing input's `onKeyDown` already calls `check()`
on Enter, and the resulting "Continue" / retype-Continue buttons are
`autoFocus`, so a second Enter press already advances. No code change was
needed for this.

## Wrong-answer ("confusion") tracking

`card_confusions` table (migration 021, extended by migration 026) +
`record_card_confusion` RPC + `lib/data/cardConfusions.ts:
SupabaseCardConfusionRepository.record()` /
`listForCard()`/`listForUser()`. Surfaced in the deck detail page's card
stats (CardEditModal-equivalent).

As of this session (2026-06-15), all 3 session pages' `handleAnswer` record
**every** wrong answer — multiple-choice pick or typed response, in either
direction — not just the original "English shown → pick Spanish, picked
wrong" case. The "confused with" card lookup uses `step.answerSide` to know
whether to match against `card.front` or `card.back` of the candidate cards.

### Confused words promoted to multiple-choice distractors (migration 026, this session 2026-06-15)

Addresses the former backlog item "Confusions aren't fed back into
distractors".

- `card_confusions` gained two columns: `answer_side` ('front'/'back' — which
  side the learner was asked to produce) and `is_word_mixup` (boolean —
  true if `confused_text` is a genuinely different word, not just a typo).
  `record_card_confusion()` now takes `p_answer_side` and `p_is_word_mixup`
  in addition to the existing params; on conflict, `is_word_mixup` is OR'd
  (once word-level, stays word-level) and `answer_side` is overwritten with
  the latest value. Existing rows (pre-migration) default to
  `answer_side='front'`, `is_word_mixup=true` (the original use case was
  always a multiple-choice pick on the front side).
- `engine/grading.ts: isDifferentWordMistake()` — new pure helper, true when
  `classifyWrongAnswer()` would return 1.0 for a non-blank answer (i.e.
  "essentially a different word", not a typo/spelling/accent/article slip).
  Has Jest tests in `engine/__tests__/grading.test.ts`.
- In each session page's `handleAnswer`, `isWordMixup` passed to `record()`
  is `true` for recognition-step wrong picks (always a real word) and, for
  typing steps, `isDifferentWordMistake(userAnswer, expected, gradingSettings)`
  — so repeatedly *mistyping* the same word doesn't count, but repeatedly
  typing a *different real word* does.
- `lib/distractors.ts`:
  - `CONFUSION_PROMOTION_THRESHOLD = 3` — how many times a word-level mix-up
    must recur before being promoted.
  - `promoteConfusionDistractor(card, side, confusions)` — pure function.
    If `card.choices[side]` already has a full cached distractor set
    (`OPTIONS_NEEDED - 1` entries) and the highest-count eligible confusion
    (`answerSide === side && isWordMixup && count >= THRESHOLD`, not already
    a distractor, not the correct answer) exists, returns updated
    `CardChoices` with that confusion word swapping in for the *last*
    existing distractor. Returns `null` (no-op) if `choices[side]` isn't
    fully populated yet — promotion is deferred to a later session once AI
    choices are cached, to avoid racing with `ensureChoicesGenerated()`'s
    cache write.
  - `promoteConfusionDistractors(items, confusionsByCard, onCached)` —
    background pass (same shape as `prefetchChoices`) that persists the
    above via `cardRepo.update({ choices })` and reports through `onCached`.
- All 3 session pages: at session load, fetch
  `SupabaseCardConfusionRepository().listForUser()` once, group by
  `cardId`, and run `promoteConfusionDistractors()` for every upcoming
  recognition step in the queue (not just `slice(1)` — no AI calls, so it's
  cheap), wired to the existing `handleChoicesCached` callback.

## Migrations

Sequential, in `supabase/migrations/`. Latest is `029`:

- `001_initial.sql` … `020_scheduler_v2.sql` — core schema, folders, language
  pairs, shared cards, scheduler v1→v2, lapse clustering.
- `021_card_confusions.sql` — `card_confusions` table + RPC.
- `022_typing_streak_redo.sql` — typing-mistake-streak → MC redo (pipeline
  logic was already generic; this migration's SQL content should be checked
  if you need the exact DDL).
- `023_pipeline_step5_recognition_redo.sql` — adds pipeline step 4 (final
  Spanish→English MC) to the default pipeline.
- `024_stage3_same_day_window.sql` — adds `card_states.stage3_entered_date`
  (DATE, nullable) for the stages 3-5 same-day-window rule.
- `025_typed_answer_overrides.sql` — adds `typed_answer_overrides` table
  (owner-RLS) for persisted typed-answer overrides.
- `026_card_confusion_word_mixups.sql` — adds `answer_side` and
  `is_word_mixup` to `card_confusions` and updates `record_card_confusion()`
  to accept them; used to promote recurring word-level mix-ups into
  multiple-choice distractors.
- `027_elective_session_limit.sql` — adds `elective_session_limit INTEGER`
  (nullable) to `user_deck_preferences`. NULL = default (20 cards/batch),
  0 = no cap, positive integer = cap at that value.
- `028_language_pair_flags.sql` — adds `flag TEXT` (nullable) to
  `language_pairs` for per-pair custom flag emoji. NULL = use the language's
  default flag from `lib/languages.ts`.
- `029_profile_timezone.sql` — adds `timezone TEXT` (nullable) to `profiles`.
  NULL = UTC. Controls which calendar day is "today" for daily study tracking.

**Migrations are not auto-applied.** When you add one, tell the user to run
it in the Supabase SQL editor (or via CLI) — don't assume it's live just
because it's committed. If a feature seems "not working" in the deployed
app, first check (a) was the migration applied, and (b) was the code
built/pushed/deployed.

## Standing operational rules (do not drop these)

- **Commit/push commands must always be given directly in the chat as a code
  block — never written to a file.** The user runs them locally.
- **Always use this exact commit pattern** — stage everything, one commit, push immediately:
  ```
  git add .
  git commit -m "Your message here"
  git push
  ```
- **All bracket-containing route paths** (e.g. `[deckId]`, `[folderId]`)
  **must be quoted** in every git command, due to zsh glob expansion.
- The `mcp__workspace__bash` sandbox has a persistent mount error for this
  project's folder (`failed to mount ... as Language Learning Application` /
  similar for `lexify`/`lang_learn_app`) — assume it's broken unless you've just
  verified otherwise. Give build/test/migration/commit commands as chat code
  blocks for the user to run locally and paste results back.

## Library pair-grid improvements (2026-06-15)

- `lib/languages.ts`: Added `nativeName` (language name in its own language, e.g. "Français" for French) and `flag` (emoji flag) fields to every `Language` entry. Added `langNativeName(code)` and `langFlag(code)` helpers. Signed languages (ASL, BSL) keep English abbreviations as their native name. The `Language` interface now includes these two new fields — any code importing it via `LANGUAGES` or the helpers should be checked if the type shape matters.
- `lib/data/languagePairs.ts`: Added `updatePositions()`, `updateFlag()`, updated `create()` to accept optional `flag`, updated `rowToPair()` to read `flag`.
- `lib/flagOptions.ts`: New file — ~130 country flags with names for the flag picker.
- `supabase/migrations/028_language_pair_flags.sql`: Adds `flag TEXT` (nullable) to `language_pairs`. **Must be applied in Supabase before flag-picker will persist.**
- `domain/index.ts`: `LanguagePair` now has `flag: string | null`.
- `app/library/page.tsx`: Library pair boxes show native language names + per-pair custom flag (falls back to default). Boxes are draggable — left half = insert before, right half = insert after; accent border shows drop position. Drag image = source language flag emoji. Flag picker modal to change existing pair flags. Flag picker inline in "New language" form. Fix: drag-and-drop uses refs (`draggingPairKeyRef`, `pairDropPosRef`) to avoid stale-closure bugs; `effectAllowed='move'` and `dropEffect='move'` suppress the green "+" cursor.
- **Fix (2026-06-15 continued): `← Library` back button now works.** Root cause: `LibraryPageBody` was relying on `useSearchParams()` in `LibraryPageInner` to re-render and change the `key` prop when navigating from `/library?source=X&target=Y` back to `/library`. In Next.js 16 + React 19 this re-render was not reliably firing for same-route navigation when removing all params. Fix: `LibraryPageBody` now manages `pairSource`/`pairTarget` as local state (initialized from URL props, synced via `useEffect` for browser back/forward). The "← Library" button sets state to null directly and also pushes URL. The pair-box `<Link>` onClick also sets state. The `key`-based remount in `LibraryPageInner` is kept as a fallback for programmatic navigation.

## Session features (2026-06-15 continued)

### "I don't know" button (all 3 session pages)

`components/session/MultipleChoiceMode.tsx`:
- New `onIDontKnow?: () => void` prop. Renders a subtle "I don't know" link
  below the prompt (before the learner commits to a choice). Clicking it calls
  the callback; the parent applies the penalty.

All 3 session pages (`study/[deckId]/session`, `study/folder/[folderId]/session`,
`study/all/session`):
- `handleIDontKnow`: runs `progressAfterReview` 3 times with `rating:'again'`
  (heavier SRS penalty than a single wrong answer), records 3 review events,
  upserts the final state, then re-queues the card `IDONTKNOW_REQUEUE_OFFSET = 4`
  slots ahead so it resurfaces this session.
- `handleUndoIDontKnow`: restores the pre-IDontKnow state via `stateRepo.upsert`,
  removes the re-queued copy (tagged `idontknow: true` on `SessionCard`), inserts
  the card at the current queue index, and clears the undo state.
- `iDontKnowUndo` state holds `{ cardId, prevState }`.
- An undo banner appears above the current card while `iDontKnowUndo` is set.
  Banner is cleared when any other answer is submitted.

### Timezone in settings (migration 029)

`supabase/migrations/029_profile_timezone.sql`: adds `timezone TEXT` (nullable)
to `profiles`. NULL = UTC.

`app/settings/page.tsx`: new "Time zone" panel with a select populated from
`Intl.supportedValuesOf('timeZone')` (falls back to a text input). Auto-detects
the browser's timezone as default. Saved to `profiles.timezone`.

`lib/dates.ts`: new `getToday(tz = 'UTC'): string` helper that returns the
current date as YYYY-MM-DD in the given IANA timezone.

All 3 session pages: load `profiles.timezone` at session start and use
`getToday(tz)` instead of `now.toISOString().slice(0, 10)` for the `today`
variable (used for `introducedToday` counts and in-code date comparisons).

**Migration `029_profile_timezone.sql` must be applied in Supabase before
timezone settings take effect.**

### Synonym-aware multiple choice (no migration needed)

`domain/index.ts`: `CardChoices` extended with optional `frontSynonyms?: string[]`
and `backSynonyms?: string[]` — lists of words/phrases that are valid alternate
answers and should be accepted as correct, not shown as distractors.

`app/api/distractors/route.ts`: updated prompt explicitly asks the AI for
non-synonym distractors (same semantic category, different denotation) and also
returns `frontSynonyms`/`backSynonyms` lists for the correct answer. The
response now includes these in `choices`. max_tokens bumped to 800.

`lib/distractors.ts`:
- `isPotentialSynonym(correct, candidate)`: heuristic filter — returns true if
  one string contains the other, or if they share a prefix of length ≥ 3.
- `deckFallback`: filters out potential synonyms before choosing random sibling
  values, so "puppy" doesn't get "pup" or "puppy dog" as distractors.
- `buildOptions`: strips known synonyms from the cached AI distractor pool
  before building options (prevents old cached synonyms from appearing).

`components/session/MultipleChoiceMode.tsx`:
- If the learner picks a synonym of the correct answer, it's accepted as correct
  and shown in amber with a "(synonym)" note. The green highlight remains on the
  exact-match correct answer.

## Graduated card review direction (2026-06-20)

Post-graduation ("due now") reviews always show **English (native / `card.back`) as the prompt** and ask the learner to **produce Spanish (target / `card.front`)**. This is enforced in all 3 session pages with:

```ts
const reviewPromptSide: CardSide = state.graduated ? 'back' : step.promptSide
const reviewAnswerSide: CardSide = state.graduated ? 'front' : step.answerSide
```

These two derived variables replace `step.promptSide`/`step.answerSide` everywhere for graduated cards: in `handleAnswer` (event recording, confusion tracking, `wrongSeverity` calculation), `handleIDontKnow` (event recording), and in the render (both `FlashcardMode` and `TypingMode` components). Pre-graduation steps continue to use the pipeline step's configured sides unchanged.

Background: when a card graduates from step 4 (the final recognition step, `prompt=front`/`answer=back`), `state.currentStepOrder` stays at 4. Without this override, graduated cards would continue showing Spanish and asking the learner to produce English — the opposite of long-term retention review.

## Study dashboard — "Study all due" button (2026-06-20)

`app/study/page.tsx`:
- **`totalDue`** is now `global.dueNow` only (previously included `global.learning`).
- **Button when `dueNow > 0`**: links to `/study/all/session?category=due` (was `/study/all/session` without the filter, which included learning pipeline cards).
- **Button when `dueNow === 0`**: renders a disabled `<button>` with text "No cards due" (was an opacity-dimmed link + separate "Nothing due right now" text).

## TypingMode Enter double-trigger fix (2026-06-20)

Pre-graduation typing cards were auto-advancing after a single Enter press. Root cause: pressing Enter on the text input called `check()`, React committed the render (showing the Continue button with `autoFocus`), and the browser's `keypress` event then fired on the now-focused button, triggering its click. Fix: removed `autoFocus` from the Continue button and replaced with `useRef` + `useEffect` + `setTimeout(100ms)`. The button only gets focus 100ms after the result appears — well after the original key event cycle has finished.

## Day turnover setting (2026-06-20)

Allows night-owl users to count late-night study sessions as part of the previous calendar day.

- **Migration `031_day_turnover_hour.sql`**: adds `day_turnover_hour INTEGER NOT NULL DEFAULT 0` to `profiles`. 0 = midnight (no adjustment).
- **`lib/dates.ts: getToday(tz, turnoverHour)`**: new optional `turnoverHour` parameter (0-23). If the current local hour is before `turnoverHour`, returns yesterday's date in the user's timezone — so studying at 3 AM with turnoverHour=4 counts as the previous calendar day.
- **Settings page**: "Day turnover time" select (12:00 AM to 12:00 PM in hourly steps) inside the Time zone panel. Loaded and saved with `day_turnover_hour` in `profiles`.
- **All 3 session pages**: load `day_turnover_hour` alongside `timezone` from profiles, pass both to `getToday()`.

## "I don't know" UX overhaul (2026-06-15)

- **No more banner**: removed the "Marked 'I don't know' — heavy penalty applied. Undo" banner and all undo state/logic from all 3 session pages.
- **Answer revealed in-card**: pressing `?` no longer auto-advances. Instead:
  - *MultipleChoiceMode*: `?` sets `revealed=true` and `selected=correct`, showing the correct answer highlighted green. Continue (via new `onAdvance` prop) advances.
  - *TypingMode*: `?` in corner of prompt card sets `revealed=true`, shows expected answer in the input (disabled, faded), shows a neutral "Answer: [expected]" panel. Continue via `onAdvance` advances. The old "Don't know" button is removed.
- **Penalty is context-sensitive** (as of 2026-06-20): pre-graduation cards get 3× `again`; graduated/due cards get 1× `again` (same as a regular "Again" rating — the triple penalty was too harsh for long-term review). The loop count is `const penaltyCount = state.graduated ? 1 : 3`.
- **`iDontKnowCount`**: `CardState.iDontKnowCount` (integer, default 0) tracks cumulative `?` presses per card. Requires migration `030_i_dont_know_count.sql`. `initialCardState()` initializes to 0. All 3 session pages increment and persist it on each press.

## TypingMode synonym detection (2026-06-15)

`components/session/TypingMode.tsx`:

- New `synonyms?: string[]` prop — accepted alternate phrasings for the answer side, sourced from `card.choices.frontSynonyms` / `card.choices.backSynonyms`.
- `result` state shape extended with `viaSynonym: boolean`.
- `check()` now also tests the typed input against each synonym using the same `gradeTyping()` normalization. If a synonym matches, `viaSynonym = true` and the answer is counted correct.
- Display: a synonym match shows "Correct! (synonym)" in amber, plus a "The original term is: [expected]" note below. The learner can still press "Override as incorrect" to force the card back (ensuring they can recall the exact canonical form, not just a synonym).
- When overridden as incorrect, the "(synonym)" note and "The original term is:" line are hidden (the card enters the wrong-answer retype flow as normal).

All 3 session pages pass:
```tsx
synonyms={step.answerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
```
to each `TypingMode` usage (2 per page — pre-graduation and graduated/graded-review).

## CardEditModal info panel additions (2026-06-15)

`app/study/[deckId]/page.tsx` — `CardEditModal` info (ℹ) panel:

- Added a **Distractors** section to the `showStats` panel (always shown, not gated on `state`). Displays the cached `card.choices` pools:
  - "Prompt [source] → pick [target]" — `choices.back` (wrong target-language options)
  - "Prompt [target] → pick [source]" — `choices.front` (wrong source-language options)
  - Target synonyms (green chips) — `choices.backSynonyms`
  - Source synonyms (green chips) — `choices.frontSynonyms`
  - If `choices === null`: italic "Not yet generated" message
- Section appears before "Often confused with".
- Uses `langName()` (imported from `@/lib/languages`) for language display names.

## DeckSettingsPanel UX refactor (2026-06-15)

`app/study/[deckId]/page.tsx` — `DeckSettingsPanel`:

- **Scrollable modal**: split into sticky header + `overflow-y-auto flex-1` body + sticky footer (Save/Cancel). `max-h-[85vh]` on the panel prevents it from overflowing the viewport.
- **Merged batch/elective cap**: removed the separate "Cap elective/study-ahead sessions" checkbox. The single "Study in fixed-size batches" checkbox now controls both `cardsPerSession` and `electiveSessionLimit` (both set to the same number). Updated description copy to reflect this.
- **Reset menu**: removed the two inline reset buttons at the bottom. Added a red ↺ icon button in the header (left of ✕) that opens a small dropdown with three options: "Reset backlog", "Reset distractors", "Reset all progress". Each triggers its own `ConfirmDialog`.
  - Reset backlog: calls existing `prefRepo.resetDeckBacklog()` (unchanged).
  - Reset distractors: clears `choices = null` for all cards in the deck via a direct Supabase `update().in('id', cardIds)`, then triggers background `prefetchChoices()` regeneration. Does NOT touch `card_states`.
  - Reset all progress: calls existing `deckRepo.resetProgress()` (SQL RPC, clears both `card_states` and `choices`), then triggers background `prefetchChoices()`.
- All three reset operations share `resetting`/`resetError` state (only one runs at a time).
- **Fix**: reset menu now uses `top-full mt-1 right-0` (drops below the header row) instead of `top-0 right-6` (which overlapped the ↺ button and prevented clicking it again to close).

## Disabled review tracks ghost their Due Now cards (2026-07-05)

When a language pair disables a review track (the "Enable review tracks"
checkboxes in the pair settings — Typed production / Recall self-grade /
Reverse recall), that track's due cards are now **filtered out of Due Now**
(ghosted) but their scheduling data is untouched, so re-enabling the track
brings them straight back.

- The three flags live on their own answer_field rows (`forward_typed_enabled`
  on the forward_typed row, `forward_recall_enabled` on forward_recall,
  `reverse_recall_enabled` on reverse_recall) — so reading them needs all three
  rows, not just forward_typed.
- `lib/sessionLimits.ts`: `buildEnabledTracksMap(rows)` →
  `Map<'${src}|${tgt}', EnabledTracks>` (built from
  `SupabaseUserSchedulerParamsRepository.listForUser()`), and
  `trackEnabled(tracks, reviewTrack, isReverse)` (legacy reviews count as typed).
- All 3 session pages gate every graduated due-push (`reviewTrack` 'typed' /
  'recall' / 'legacy', and the reverse-direction rows) on `trackEnabled(...)`,
  keyed by each card's deck pair (correct for multi-pair all/folder sessions).
- Note: the study-dashboard due **counts** are not yet track-filtered, so a
  ghosted card can still be counted there (session queue is correct).

## Card dormancy (2026-07-05)

A card can go **dormant** — stays in the deck, manually reviewable, but never
becomes due automatically. **Migration 068** adds `card_states.dormant` (bool) +
`dormancy_threshold` (int, null=never), canonical on the forward row.

- **Trigger**: after a graduated **production** review (typed/self-graded forward
  track — reverse ignored), if `reps >= dormancyThreshold` → `dormant = true`.
  Wired in all 3 session pages right before the production `stateRepo.upsert`.
- **i-menu** (`CardEditModal`): "Go dormant after N production reviews" (Set/Clear)
  + "Wake from dormancy" / "Make dormant now". Status shows **Dormant**.
- **Excluded from Due Now everywhere**: all 3 session queues (forward + reverse
  rows), the dashboard `dueNow` count + forecast (`buildForecastDays` +
  `forecastCards`), and `lib/folderStats.ts` counts. Reverse rows check the
  forward counterpart's `dormant` via the forward stateMap.
- **`?category=dormant`** studies dormant cards (they **stay dormant** — elective).
- **Dormant stat box** (neutral/white, after Due Now) + **"Dormant"** card-list
  label at deck detail, folder (`library/[folderId]`), and library-pair
  (`library/page`) views. `StudyCategory`/`FilterKey` unions extended with
  `'dormant'`; `FolderCounts` gains `dormant`.

## FSRS Due Now scheduler (Stage 2 complete, 2026-07-10)

Graduated cards are now scheduled by an FSRS memory model (Difficulty +
Stability + Retrievability) instead of the legacy interval-multiplier scheduler.
Learning (pre-graduation) is untouched — the ladder/pipeline still runs it.

- **`engine/fsrs.ts`** — pure FSRS-5 math: `retrievability`, `intervalForRetention`
  (retention clamped 0.70–0.97), `nextDifficulty`, `initialStability/Difficulty`,
  `stabilityAfterSuccess`/`stabilityAfterLapse`, `reviewCard`. `DEFAULT_FSRS_CONFIG`
  = 19-weight FSRS-5 defaults, requestRetention 0.9.
- **`engine/dueNow.ts`** — the Due Now decision layer over the math:
  - `reviewDueNow(state, grade, elapsedDays, cfg)` — clean Hard/Good/Easy advance
    (Hard grows slower, no auto-jump); Again → 5-min relearn loop. Relearn gate:
    Hard = 10-min loop (no exit/reset), needs **two Goods in a row** to escape
    (first Good = 20-min loop), Easy escapes immediately, **three Agains in a row
    → `sendToLadder`** (un-graduate).
  - `scheduleGraduatedFsrs(cur, grade, cfg)` — lazily seeds D/S for pre-FSRS cards
    (`seedDifficulty = clamp(5 + 0.7·lapses)`, `seedStability = max(0.5, interval)`),
    returns `{difficulty, stability, relearning, goodStreak, againStreak,
    intervalDays|null, dueInMinutes|null, sendToLadder}`.
  - `gradeFromTyped({status, slip, strictness, chosen})` — maps a typed answer to a
    grade using the 3-way strictness slider (penalize→Again, retype→Hard,
    accept→chosen; wrong→Again).
- **Data model** — `CardState` gained `difficulty|null`, `stability|null`,
  `relearning`, `goodStreak`, `againStreak` (migration **074_fsrs_state.sql** —
  **must be applied**). `initialCardState` + `lib/data/cardStates.ts` mappings updated.
- **Session-page wiring (all 3 pages)** — in `handleAnswer`, both the recall/reverse
  track and the forward graduated track call `scheduleGraduatedFsrs` instead of
  `scheduleNext`. `progressAfterReview` still runs for its production bookkeeping
  (typed accuracy window, forced-typing, reps/lapses); FSRS only overrides the
  schedule (D/S, dueAt, intervalDays, relearn gate). Relearn re-uses the existing
  10-min relearn pool (via `relearningStep = 1`). `sendToLadder` resets the forward
  row to `initialCardState` (un-graduate); the rare recall-track `sendToLadder` is
  treated as one more 5-min loop for v1.
- **Stage 3 (backfill) — migration `075_fsrs_backfill.sql`**: seeds D/S for all
  already-graduated rows up front (same formulas as the lazy seed), per direction
  (forward → typed interval, reverse → recall interval). Idempotent — only touches
  graduated rows with NULL difficulty/stability, so it never overwrites a card that
  already has a reviewed FSRS state. **Must be applied.**
- **Stage 4 (per-pair retention) — migration `076_fsrs_request_retention.sql`**:
  adds `user_scheduler_params.request_retention` (real, default 0.90), surfaced on
  `SchedulerParams.requestRetention` (canonical on the forward_typed row, like the
  strictness levels). The three session pages pass
  `{ ...DEFAULT_FSRS_CONFIG, requestRetention: schedulerParams.requestRetention }`
  to `scheduleGraduatedFsrs` (engine still clamps effective retention to 0.70–0.97).
  UI: a "Target retention" slider (80–95%) in the per-pair SRS settings modal in
  `app/library/page.tsx` (`handleSrsRetention`). **Must apply migration 076.**
  Note: all/folder sessions span multiple pairs but use the single loaded
  `schedulerParams` row for retention — same existing limitation as `scheduleNext`.
- **Polish pass (2026-07-10)** — four refinements on top of Stages 1–4:
  1. **Interval fuzz + redistribute.** `engine/fsrs.ts: fsrsFuzzRange(intervalDays)`
     returns the `[minDays, maxDays]` window (±5%, ≥1 day; no fuzz under 2.5 days).
     At scheduling time the session pages feed this window to `smoothDueDate`
     (density smoothing) so same-day batches don't pile up on one future day. The
     "Redistribute" buttons (`app/settings/page.tsx` global, `app/study/page.tsx`
     per-forecast-day) now compute each graduated card's movable window from
     `fsrsFuzzRange(scheduledIntervalDays)` — the same window it was scheduled in —
     instead of the retired legacy multiplier range.
  2. **`sendToLadder` → CURRENT ladder.** On a forward 3-Agains-in-a-row un-graduation,
     the session now deletes the card's `ladder_climb` row (`SupabaseLadderClimbRepository.remove`)
     so it restarts from whatever the ladder is configured as now, not a stale rung.
  3. **Only target-language production redoes the pipeline.** `sendToLadder` un-graduates
     only from the forward (production) path; the recall/reverse path never un-graduates
     (a would-be sendToLadder there just loops one more 5-min relearn).
  4. **Per-pair constants in all/folder sessions.** Both pages build a
     `paramsByPair` map (forward_typed row per `${src}|${tgt}`); `handleAnswer`
     derives `cardParams` from the reviewed card's pair and uses it for FSRS
     retention, `graduationIntervalRange`, `maxIntervalDays`, and `scheduleNext`.
     So a mixed "Study all due" session schedules each card with its own pair's
     constants. (Scoped picker rows already pass `?source=&target=` and were exact.)
     Known small gap: load-time `decideProductionMode` (typed-vs-self-graded odds)
     still uses the primary pair in a mixed session.

## Smart-typing review track (2026-07-10)

A fourth, independent forward-production review track alongside typed-production,
self-graded recall, and reverse recall. It is presented as **typed** while its
interval is below a per-pair threshold (default 20 days), then **self-graded** once
past it — and reverts to typing if a lapse drops the interval back under. Its own
FSRS schedule (`smart_due_at`/`smart_interval_days`), sharing the row's D/S.

- **Migrations** (must apply, in order): `077_smart_typing_track.sql` (adds
  `card_states.smart_due_at`/`smart_interval_days` + `user_scheduler_params.forward_smart_enabled`
  (default false) + `smart_typing_threshold_days` (default 20)); `078_migrate_typing_to_smart.sql`
  (moves every existing typed card's schedule into the smart lane — incl. legacy
  dueAt-only cards — and flips each pair's `forward_typed_enabled`→off /
  `forward_smart_enabled`←old typed value). **After 078, all existing cards are smart-typing.**
- **Data model**: `CardState.smartIntervalDays`/`smartDueAt`; `SchedulerParams.smartTypingThresholdDays`
  (canonical on the forward_typed row, like retention). `initialCardState`, cardStates
  repo, userSchedulerParams (`forwardSmartEnabled`), calibrate route all mapped.
- **Enabled tracks** (`lib/sessionLimits.ts`): `EnabledTracks.smart` (default false),
  `buildEnabledTracksMap` reads `forward_smart_enabled` off the `forward_smart` row,
  `trackEnabled(...,'smart',...)`, `dedupeDueReviews` rank typed<smart<legacy<recall.
  `smartProductionMode(smartIntervalDays, thresholdDays)` → 'typed' | 'self-graded'.
- **Session pages (all 3)**: `reviewTrack` union gains `'smart'`; queue building detects
  `isSmartDue` and pushes with `smartProductionMode(...)`; **typed pushes are now always
  'typed'** (the old probabilistic typed-vs-self-graded split is gone — that behavior
  moved into smart typing); the `legacy` due-check is guarded with `!smartDueAt`.
  `handleAnswer` has a self-contained early-return **smart branch** (mirrors the recall
  branch but writes `smart_*` columns, keeps `dueAt`/`intervalDays`/`scheduledIntervalDays`
  in sync, honors `sendToLadder` un-graduation + dormancy since it IS production).
- **Counts/forecast/redistribute** (`app/study/page.tsx`, `app/settings/page.tsx`):
  `smartDueOn` added to dueNow; forecast + forecastCards treat smart as production
  (shown under the "typed" filter); redistribute moves the active production column
  (`smart_due_at`/`typed_due_at`) alongside `due_at`. folderStats works unchanged via
  the synced `due_at`.
- **Settings UI** (`app/library/page.tsx`): the "Enable review tracks" list now has
  **Typed production (always type)**, **Smart typing** (with an inline integer
  "type until interval reaches N days" box), **Self-graded production (no typing)**
  (renamed from "Recall (self-grade)"), **Reverse recall**. `handleSrsToggle` enforces
  **Typed ⊕ Smart** mutual exclusivity (enabling one disables the other). The
  graduation-interval-by-error-count table + its handlers/`GradIntervalCell` were
  **removed** (dead with the ladder).
- **Charts**: the study-dashboard "Coming up" forecast REVIEW TYPE filter is now
  **Typed / Self-graded** (was Typed production / Recall) — a smart card's next due is
  classified typed if its interval < threshold, else self-graded; reverse counts as
  self-graded. `buildForecastDays`/`forecastCards` take a per-pair `thresholds` map.
  `components/analytics/DueForecastProjection.tsx` now draws **4 lines** (Total, Typed,
  Self-graded, Reverse); it reads the `forward_smart` row and routes each simulated
  smart review to typed-or-self-graded by interval vs threshold (new-card renewal splits
  via `stages(t, m, min(threshold, maxInt))` for the typed portion).
- **Card-info "i" panel** (`components/CardEditModal.tsx`): now recognises the smart
  track — the schedule section titles as "Smart typing track" and reads
  `smart_*` columns (falls back to typed/legacy).
- **Accelerated auto-self-grade** (migration `079_accelerated_typed_confirmed.sql`):
  `CardState.acceleratedTypedConfirmed`. An import-known card flips to self-graded
  presentation forever after its first correct **typed** review (set in the smart +
  forward FSRS branches when `acceleratedMode==='import_known' && wasTyped && wasCorrect`).
  Presentation goes through `sessionLimits.forwardProductionMode(state, track, threshold)`
  which applies the accelerated override, else the smart threshold rule, else always-type.
- **"Study all due" grouped by card type**: the dashboard popover now leads with
  **Typing** / **Self-graded** rows (counts from `dueNowTyping`/`dueNowSelfGraded`,
  split by presentation) above the by-language rows. They link to
  `/study/all/session?category=due&present=typing|selfgraded`; all-session filters the
  deduped queue by `productionMode` (`filterByPresent`). Typing = forward production
  shown typed (one direction); Self-graded = forward self-graded + recall + reverse.

## Card-editor agent: common-task buttons + deterministic De-dupe (2026-07-11)

`app/agents/page.tsx` gained a "Common tasks" row in the setup phase:
- **🧹 De-dupe** — deterministic, no AI. `lib/agents/cardEditor.ts: findDuplicates(cards)` groups cards
  whose FRONT **and** BACK match (normalized: NFC + trim + whitespace-collapse + case-insensitive, joined
  with a NUL separator so word-split can't collide) and proposes deleting all but the first of each group.
  Shared cards (same cardId in multiple decks) are collapsed to one first, so a card never dupes itself.
  Cards sharing only a gloss (세안하다 vs 세수하다, both "to wash face") are NOT duplicates. `runDedupe()`
  gathers the selected scope (or all decks if none selected), queues the deletes, and reuses the existing
  approve/deny review UI (`ProposalView` delete branch + `applyProposal` → soft `deleteCard`). Tested in
  `lib/agents/__tests__/findDuplicates.test.ts`.
- Two prefill buttons ("Strip 'to ' from verbs", "Add noun gender") that populate the instruction box for
  the normal AI flow.

Note: the agent's own "Duplicate of cardId…" delete reasons are free-form LLM rationale (matched on gloss,
so prone to false positives like the above) — the De-dupe button is the deterministic front+back alternative.

## Production-confusion detection + linkage + penalty (2026-07-11) — foundation

Typing a *different real word* (another card's target) on a typed production review is a discrimination
failure. New handling, built on the existing `card_confusion_links` table (migration **052** — verify
applied) + `SupabaseCardConfusionLinkRepository` (added `listForUser`):

- **`engine/confusion.ts`** (pure, tested in `engine/__tests__/confusion.test.ts`):
  - `findConfusedSibling(typed, expectedFront, currentCardId, siblings, settings)` → the matched card
    id (B), only when `isDifferentWordMistake` says it's a genuine different word (not a typo) and it
    exactly matches another card's `front`. `normalizeForMatch` (NFC, drop (f)/[note], lowercase).
  - `confusionPenalty(state, retention)` → recognition-track penalty: `stability ×0.5`,
    `difficulty +1` (clamped), and the resulting shorter interval. FSRS-native (persists), not a raw
    interval cut.
- **`lib/confusionResponse.ts: respondToProductionConfusion(...)`** — lazy whole-library {id,front}
  index (`cards.listFrontsForUser` via `owner_id`), detect, **link A↔B**, and **penalize BOTH cards'
  recognition (reverse) tracks** (cut D/S + pull recall due sooner). Never touches production. Returns
  B's id (for the future drill). Fire-and-forget.
- Wired into **`app/study/all/session`** `handleAnswer`: on a wrong typed production answer. **Not yet
  replicated to deck/folder session pages.**

Design decisions (from the user): respond **immediately, every time** (no escalation), **both A and B**,
**recognition track only**, **whole-library any-language** match. Note: morphological pairs (same root,
e.g. gato/gata) read as near-misses by `isDifferentWordMistake` and don't trigger.

**Intra- vs inter-language (migration 083 — adds `kind`, `tags` to card_confusion_links):**
- `confusionKind(srcA, srcB)` — **intra** = same learned language (`source_language`) → the full response
  above; **inter** = different languages → link stored with `kind='inter'`, **no penalty** (a future
  cross-linguistic feature acts on these). `listFrontsForUser` now returns `sourceLanguage` too.
- **Similarity tags** on intra links (for the future intra-language practice mode): `classifyIntraTags`
  computes the deterministic ones now — **phonetic** (NFD phoneme-level `editRatio ≥ 0.6`, e.g. 발/팔) and
  **temporal** (both cards' `introducedDate` within 2 days). **semantic** is NOT auto-detected (future
  AI/embedding tagger); **other** is left for that tagger too. Empty tags = not yet fully classified.
  Multiple of phonetic/semantic/temporal may apply; 'other' is exclusive. Tested in confusion.test.ts.

**Stage 2 (DONE):** detection wired into all 3 session pages (`all`, `[deckId]`, `folder/[folderId]`).

**Stage 3 — immediate A-vs-B drill (DONE):** on an INTRA confusion, `respondToProductionConfusion`
returns `{cardBId, cardBFront}`; the session `queueDrill`s a `components/session/ConfusionDrill.tsx`
(shows A's meaning, pick A's word vs B's word) `DRILL_OFFSET=3` cards ahead but before A or B recurs
(bounded scan). SessionCard gains `drill?: {otherFront, otherId}`; an `indexRef` tracks the live index
for the async insertion; a render branch shows the drill (pure practice — advancing schedules nothing).
Wired in all 3 session pages.

**Stage 4 — mutual distractors (DONE):** `lib/distractors.ts: injectForcedDistractor(card, side, word)`
forces a specific word into `choices[side]` (swap last when full, else append; skips dupes/correct/blank;
tested). On an intra confusion, `respondToProductionConfusion` loads A and B and injects each into the
other's `choices.front` (the "pick the target word" recognition pool) — best-effort, skipped if choices
aren't generated yet.

**STAGED next (consumers of the link):** (1) interleave linked pairs' recognition in sessions;
(2) the standalone distinguish-confusable-cards tool + semantic tagging (user-owned).

## Grammatical gender/number tags never graded (2026-07-11)

Typing a target word without its "(f)"/"(m)"/"(pl)" gender-number tag was scored as an "almost"
(spelling near-miss) when the deck had `requireParentheticalContent` on (the tag was treated as
required content, e.g. "особеност" vs required "особеност f"). Fix: `engine/grading.ts:
stripGrammaticalTags(text)` removes parentheticals whose content is a grammatical gender/number marker
(`m|f|n|mf|masc|fem|neut|pl|sg|sing|…`, optional trailing period), and `gradeTyping` strips both the
user answer and the expected answer up front — so these tags never count, regardless of
`requireParentheticalContent`. A REQUIRED word parenthetical like "(el) camello" is left intact (its
content isn't a grammatical marker). Applies to all typed grading (production/dictation/pre-grad).
Tested in `engine/__tests__/grammaticalTags.test.ts`.

## Scoped Due Now done screen: Back to study + Continue (2026-07-11)

The "Study all due → Typing / Self-graded" scoped sessions' completion screen now shows **Back to study**
(→ `/study`, was "Back to <pair>" → `/library`) and a conditional **Continue (N)** button when more cards
are due in the same scope + present filter. `app/study/all/session/page.tsx`: on `done` (for
`category === 'due'`) a re-check effect re-fetches the scoped decks' card states and counts still-due
cards (production via `activeProductionTrack` + `forwardProductionMode`, recall/reverse gated on
`trackEnabled`, filtered by `present`), stored in `moreDue`. Continue does `window.location.reload()`
(re-runs the load). Load context (`decksRef`/`enabledMapRef`/`paramMapRef`) is persisted for the re-check.
Applies to typing, self-graded, and reverse (all are `category=due` present buckets). Non-due elective
categories keep their "Back to <pair>" + "Study ahead" screen. (Usually `moreDue` is 0 right after
finishing, since a scoped session loads all due cards uncapped — Continue appears only when new cards
became due or a relearn timer elapsed.)

## Hint + Hard re-shows instead of advancing (2026-07-11)

In Due Now reviews, if a hint was used (any number of times) and the card is then rated **Hard**, the
recall wasn't "cold" — so the card is **re-queued this session** (~6 cards ahead) instead of being granted
a new interval. Only a hint-free Hard advances the FSRS schedule. Implemented as an early return at the top
of `handleAnswer` in all 3 session pages, gated on `state.graduated && rating === 'hard' && hintRef.current`:
it splices a copy of the current `SessionCard` `HINT_HARD_REQUEUE_OFFSET` (6) slots ahead and advances,
leaving the card's schedule untouched (so it stays due until answered cold). No review event is recorded for
the re-show — the graded review happens when it's answered without a hint. (`hintRef` is the existing
per-card hint tracker; Again already relearns, Good/Easy still schedule with the hint's reduced growth.)

## Ghost due cards fix #2 — typed/self-graded presentation parity (2026-07-11)

Follow-up to the production-lane unification: ghosts persisted in the **Typing** bucket specifically.
Root cause (confirmed against live data): legacy dual-track cards with `smart_due_at` AND `typed_due_at`
both NULL (production scheduled on `due_at`/`interval_days`, recall on `recall_due_at`) on a smart-enabled
pair. The **dashboard** presented them typed (with `smart_due_at` null it used the typed lane, always typed),
but the **session** queued them on the enabled smart lane where `smartProductionMode(smart_interval_days=NULL)`
returned self-graded → `present=typing` filter dropped them.

Fix — make the typed/self-graded decision use the card's **effective interval** and the **same lane** on
both sides:
- `lib/sessionLimits.ts: forwardProductionMode(...)` on the smart lane now falls back
  `smart_interval_days ?? typed_interval_days ?? interval_days` (tested in
  `lib/__tests__/forwardProductionMode.test.ts`).
- `app/study/page.tsx: forwardPresentedTyping` now uses `activeProductionTrack(en)` (the enabled lane)
  instead of `s.smartDueAt ? 'smart' : 'typed'` (the date column) — matching the session's queue logic.
Sessions already route production on `activeProductionTrack` (fix #1), so with the effective-interval
change both sides classify a `due_at`/`typed_due_at`-only card identically. (The forecast-day drilldown
block in study/page.tsx still uses the date-column pick — separate display feature, not a ghost path.)

## Ghost due cards fix — production lane unification (2026-07-11)

Bug: the dashboard counted a language as having N due cards, but studying it showed "Session complete,
0 reviewed." Root cause: after the smart-typing migration (078), a pair has typed **off** / smart **on**,
but ladder graduation writes `typed_due_at` (not `smart_due_at`). The dashboard counts production-due if
EITHER production track is enabled, but the session queue only surfaced a `typed_due_at` card when the
**typed** track was enabled — so those cards were counted yet never queued (ghosts).

Fix: `lib/sessionLimits.ts: activeProductionTrack(tracks)` → the single enabled production lane
(`'smart'` if smart on, else `'typed'`, else null), since typed/smart are mutually exclusive. All three
session pages' due-queue builders (`study/all`, `study/[deckId]`, `study/folder/[folderId]`, both the
category-`due` branch and the top-up/refill branch) now compute production due generically:
`prodDueDate = smart_due_at ?? typed_due_at ?? due_at`, and push one production entry on
`activeProductionTrack(en)` when that date is due — instead of separate typed/smart/legacy branches each
gated on their own track flag. This matches the dashboard's `prodDueOn` exactly (same date priority, same
`typed||smart` enable gate), and self-heals mis-placed cards (first review on the smart lane writes the
`smart_*` columns). The deck page's `electiveCards` (early-review) fallback now triggers on
`!prodDue && !isRecallDue`. Unit-tested in `lib/__tests__/activeProductionTrack.test.ts`.

## Forecast: per-language difficulty + rating mix (2026-07-11)

Extended the FSRS forecast (`components/analytics/DueForecastProjection.tsx`) to model each language's
actual behaviour instead of an all-Good average-difficulty path:

- **`lib/forecastFsrs.ts: fsrsScheduleMix(...)`** — mean-field FSRS stepper driven by a `RatingMix`
  (`{again,hard,good,easy}` fractions). Expected stability blends the success curve (weighted by the
  hard/good/easy mix) with the lapse curve (weighted by the again rate); difficulty drifts by the mix's
  expected delta; each step's `weight` is `1 + again` to approximate relearn reviews. `normalizeRatingMix`,
  `DEFAULT_RATING_MIX` added. Tested in `lib/__tests__/forecastFsrs.test.ts` (harder mix ⇒ more load).
- **Per-language measurement (pass 1):** rating mix from every graduated forward card's `lastRating`
  (proxy — review_events aren't cheaply aggregatable); **average difficulty** and **initial interval**
  from the **NON-accelerated** population only (new cards go through the normal pipeline; we don't assume
  future acceleration). **Existing accelerated cards keep their own real difficulty/stability** (pass 2
  seeds each card from `s.difficulty`/`s.stability`), so their distinct D/S is modelled as-is.
- New cards seed at the language's measured initial interval + average difficulty + rating mix; the old
  `÷ retention` lapse fudge was dropped (lapses now live in the step weights). Load = `dailyGoal · cum(t)`.
- The stat line now shows **initial interval AND average difficulty** per language; the progress-page
  blurb was updated. Study-page "Study all due" popover: the **Typing** bucket's per-language rows now
  read Native→Target (e.g. "English → Spanish") instead of the pair identity (which was backwards for a
  typing review).

## Projected Due Now forecast rebuilt on FSRS (2026-07-11)

`components/analytics/DueForecastProjection.tsx` was rebuilt to simulate the **live FSRS stability
model** instead of the old fixed interval multiplier (`goodIdeal`). New pure helper
`lib/forecastFsrs.ts` (unit-tested in `lib/__tests__/forecastFsrs.test.ts`):

- `fsrsSchedule({stability,difficulty,firstReviewDay,retention,maxInt,horizon})` — clean all-Good
  FSRS review-day sequence (each step also carries the `intervalDays` that led to it, for smart
  typed-vs-self-graded routing). Uses `reviewCard`/`intervalForRetention` from `engine/fsrs.ts`.
- `stabilityForInterval(intervalDays, retention)` — inverse of `intervalForRetention`, to seed a
  stability from a known interval.
- `estimateInitialInterval(intervalsByReps, fallback)` — **measured per-language initial interval**:
  median interval of the freshest graduated cards (`reps<=1`, widening to `<=3`, else fallback 3).

Component behavior:
- Existing graduated cards are simulated from their real per-track due dates, seeded from stored
  `stability`/`difficulty` (or derived from the stored interval when null), preserving dormancy
  (`maxReviews`), reverse-ghosting (`stopDay`), smart routing, and per-pair retention/maxInt.
- New cards (daily goals) seed at the **measured initial interval** per pair and contribute via
  `(dailyGoal / retention) · cumulativeReviews(t)`.
- **Language filter** (pill buttons: All + one per pair, keyed by source language) filters the whole
  chart. **Per-language pie on hover** of the chart line (only when no filter) — slices = each
  language's projected cards/day at the hovered day, labeled `flag Name N/day` (`PieChart` subcomponent).
- The **measured initial interval is displayed** as a stat line under the legend (all languages, or
  the filtered one).

## Relearn resurfacing by real clock time (2026-07-11)

The Due Now relearn pool (graduated card rated Again/Hard → 5/10/20-min loop) no longer
always flushes at the end of the session. New behavior, in all 3 session pages
(`study/[deckId]/session`, `study/folder/[folderId]/session`, `study/all/session`):

- **`lib/relearnPool.ts: partitionRelearnPool(pool, reviewCount, batchSize, now)`** — pure
  helper returning `{ due, keep, dropped }`. `due` = dueAt has elapsed (real clock) → resurface;
  `dropped` = not due but `reviewCount - relearnLapsedAt >= batchSize` → roll to a later session;
  `keep` = still waiting. Unit-tested in `lib/__tests__/relearnPool.test.ts`.
- **SessionCard gained `relearnLapsedAt?: number`** — the session's answer counter when the card
  lapsed. Each page keeps `reviewCountRef` (incremented at the top of `handleAnswer` +
  `handleIDontKnow`) and `batchSizeRef` (set in `load()` = `cardsPerSession` or the page's elective
  limit — 20 for all/folder). All four relearn-pool pushes stamp `relearnLapsedAt: reviewCountRef.current`.
- **The old "inject most-elapsed relearn card when the queue runs out" useEffect was replaced** with
  a real-clock effect (deps `[index, queue.length, done, loading, relearnPool]`; deck page also guards
  `showElectivePicker`). It splices `due` cards ~3 ahead of the current index, drops window-expired
  ones, and ends the session when the main queue is exhausted with nothing due (waiting cards roll
  to a future session via their persisted `dueAt`).
- Consequence: short sessions (few cards) will typically roll relearn cards to the next session
  rather than re-show them minutes later — intended trade-off of real-clock timing.

## Audio: TTS hardening + multi-source + per-deck speed (2026-07-10)

- **TTS route** (`app/api/tts/route.ts`): ElevenLabs `eleven_turbo_v2_5` with enforced
  `language_code` (multilingual_v2 auto-detected and mis-read Cyrillic as Russian);
  `cleanForSpeech()` strips `(f)`/`[notes]` annotations (they were being vocalised into
  nonsense); **anti-clip retry** — generates up to 3× (varying stability/seed) and keeps
  the first clip whose duration (bytes·8/128000, CBR 128k) is plausible for the text,
  else the longest (self-corrects onset/offset clipping of short words).
- **Multi-source audio** (migration `081_card_audio_sources.sql`): `Card.audioSource`
  (`'elevenlabs'|'forvo'|'browser'`) + `Card.audioSources` (base64 per provider). The
  `/api/tts` route takes a `source` param; **Forvo** (`ttsForvo`, real native recordings)
  needs `FORVO_API_KEY` (+ optional `FORVO_API_BASE`, default apifree.forvo.com). The
  card-info "i" panel (`components/CardEditModal.tsx`) has a **source picker** — play/fetch
  each of ElevenLabs / Forvo / Robotic and "Use this" to set the active one (mirrored into
  `audio_data` so all playback call sites keep working). `lib/speak.ts: fetchAudioSource`
  fetches a source without playing. Clear-audio reset wipes all sources.
- **Per-deck audio speed** (migration `080_deck_audio_speed.sql`): `DeckPreferences.audioSpeed`;
  applied at playback time via `lib/speak.ts: setAudioPlaybackRate` (playbackRate +
  preservesPitch), set from deck prefs by the ladder/session pages; control in Deck
  settings → Audio. (Cross-deck all/folder sessions use normal speed.)

## Known backlog / open issues

- **#55**: "Merge" action for duplicate cards creates a new duplicate instead
  of reusing the existing card.
- **#59**: Exact-duplicate cards can still get duplicated on save (separate
  from #55).

#55 and #59 have not been actioned yet as of 2026-06-15. (The
"confusions aren't fed back into distractors" item was addressed this
session — see migration 026 above.)

- **Partial (2026-06-15)**: `study/all/session` and `study/folder/[folderId]/session`
  now have `?category=` support and "Study ahead" (page reload), but still use
  the old auto-elective behavior (silently load not-yet-due graduated cards) when
  no `?category=` is given, and have no ElectivePicker. The ElectivePicker + in-memory
  remainingElective tracking + deck-prefs-driven batch limit are only in `study/[deckId]/session`.

## Verifying changes

```
cd "/Users/alexanderpapazov/Code/alex_creates/lexify"
npm run build
npm test
```

Both should pass before committing. `npm test` runs the `engine/__tests__/`
suite (pipeline, scheduler, grading, productionMode) — these are pure-logic
tests with no Supabase dependency.
