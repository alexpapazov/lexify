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
- `features/Confusion Handling.md` — production-confusion detection (typed a
  different real word), intra/inter split, link storage + similarity tags, the
  recognition penalty, A-vs-B drill, mutual distractors, interleaving. Stages 0–5
  built; Stage 6 (standalone distinguish mode + semantic tagging) + open items
  documented as remaining.
- `features/Agent Platform.md` — AI agent infra (shared gateway + scoped grants +
  agents-as-configs). Phases 1–2 built; Phases 3+ (grants UI, job queue/dispatch,
  triggers) planned. See its status header for what's live vs remaining.

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

**Stage 5 — interleave confusable pairs (DONE):** `engine/confusion.ts: interleaveConfusablePairs(queue, links)`
(pure, tested) reorders a session queue so linked cards that are BOTH due cluster contiguously (connected
components at the first member's position; non-confusable items keep order). All 3 session pages load the
user's INTRA links once in `load()` and wrap their built due queue(s) with it (learning/new-card queues
untouched).

**STAGED next:** the standalone distinguish-confusable-cards tool + semantic tagging (user-owned).

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

## FSRS: floor scheduled interval at 1 day (2026-07-14)

A hard card (maxed difficulty 10, tiny stability ~0.34) got a sub-day FSRS interval; `snapDueAtToStartOfDay`
then snapped it to **today's** start → the card was perpetually "due now" and reappeared every session despite
correct answers (looked like a stuck relearn loop, but `relearning=false`). Fix: `engine/dueNow.ts: scheduled()`
now floors the schedule interval at `Math.max(1, intervalForRetention(...))`, so a clean advance is always ≥1
day (due tomorrow, not today). Propagates to all 3 session pages via `scheduleGraduatedFsrs`. Note: difficulty
pinned at 10 still makes stability grow slowly (only Easy walks difficulty down) — a genuinely hard card reviews
daily until it stabilizes; that's expected, not a bug.

## Learning Pathways — Phase 0 engine only (2026-07-21)

A branched, state-machine successor to the linear ladder — **design + full plan in
`features/Learning Pathways (proposal).md` (read it before touching this).** Opt-in per pair; ladders stay
untouched. **Only Phase 0 (pure engine) is built; NOT wired to any UI or DB yet** — you cannot study a
pathway. Shipped so far:
- **`domain/index.ts`**: `Pathway`, `PathwayState` (superset of a `Rung`'s presentation fields),
  `Transition`, `PathwayPredicate`/`PathwayCondition` (AND-ed list; kinds: rating/correct/errorType/
  counter/attemptsInState — **no timing predicates by design**), `PathwayCounter`, `ErrorType`.
- **`engine/pathwayEngine.ts`**: `stepPathway(pathway, route, event, now) → {route, moved, graduated,
  reshowSeconds}`, `initialRouteState`, `RouteState`, `PathwayEvent = {outcome, errorTypes}`. Deterministic:
  bump per-state counters → (leaving an `intervalInit` state on a success) record that direction's interval
  (Easy → `easyInterval`, else flat 1 day) → fire the first-matching transition by `priority` → graduate on
  a terminal (`isTerminal`) state, filling any unset direction with 1 day. Reuses `easyInterval`/
  `IntervalRange` from `ladderEngine.ts`; the ladder engine is otherwise untouched.
- **`lib/pathway.ts`**: `validatePathway` (dead-ends, graduation-reachability, ≤1 interval-setter per
  direction, `canInitInterval` reuse; unreachable/no-interval are warnings) and `ladderToPathway`
  (mechanical scaffold, not a template — the app ships NO pre-built pathways). Tests:
  `engine/__tests__/pathwayEngine.test.ts`, `lib/__tests__/pathway.test.ts`.
**Phase 1a (config, 2026-07-21) — DONE.** You can now configure a pathway per pair, but **studying still
uses the ladder** — the study session is NOT wired to pathways yet (that's Phase 1b).
- **Migration `099_learning_pathways.sql`** (MUST APPLY): `language_pairs.learning_mode TEXT DEFAULT
  'ladder'` (`'ladder'|'pathway'`) + `learning_pathways` table (per-pair + `''/''` default, `pathway` JSONB;
  mirrors `learning_ladders`).
- **`domain`**: `LanguagePair.learningMode` + `LearningMode` type.
- **Repos**: `lib/data/pathways.ts` (`SupabasePathwayRepository`, online-only — pathways not in the offline
  bundle yet); `SupabaseLanguagePairRepository.updateLearningMode`; `lib/pathway.ts` gained
  `resolveEffectivePathway` + `emptyPathway`.
- **UI**: `app/settings/ladders/page.tsx` has a per-pair **Ladder | Pathway** toggle (persists
  `learning_mode`); in pathway mode it renders `components/settings/PathwayEditor.tsx` — a list-based
  state + transition editor (add states, per-state outgoing transitions with the AND-ed predicate rows,
  priority, per-branch wait override; validates on save). Switching a pair to pathway mode seeds the
  editor from `ladderToPathway(<their ladder>)` if no pathway is saved.
**Phase 1b (session, 2026-07-21) — DONE. Pathways are now studyable** (needs live testing — see caveats).
`components/ladder/LadderStudy.tsx` branches on the primary pair's `learning_mode`:
- **Additive, not a rewrite.** Every ladder code path is byte-identical; pathway logic lives in parallel
  branches gated on `isPathway` (`pathway !== null`). `states` map widened to `Map<string, ClimbState |
  RouteState>`; `SupabaseLadderClimbRepository.save` accepts either (opaque JSON).
- Load: if the primary pair is `learning_mode='pathway'` (online only — offline is always ladder), loads
  `resolveEffectivePathway(pair, default) ?? ladderToPathway(effLadder)`. Reconcile restarts a card whose
  stored climb is the *other* shape (`rightShape` checks `stateId` vs `rungIndex`).
- Derivations: `currentRoute`/`currentPathState` alongside the (now `!isPathway`-gated) `currentClimb`/
  `currentRung`; `presentationRung = stateAsRung(currentPathState)` adapts a `PathwayState` to the `Rung`
  shape `LadderStudyCard` reads.
- `onOutcomePathway` (sibling of `onOutcome`): runs `stepPathway`, reuses the exact queue/graduate/reshow/
  undo plumbing (`reshowSeconds*1000` for the delay). `onOutcome` early-returns into it when `isPathway`.
- Header shows the state name; progress bar falls back to the graduated fraction (a pathway has no fixed
  length). Undo works unchanged (opaque state).
- **KNOWN GAPS / to verify live:** (1) **error-type transitions don't fire yet** — `onOutcomePathway`
  passes `errorTypes: []`; wiring `issueType`/confusion through `onOutcome` is Phase 2. (2) No 12-hour
  window in pathway mode (`applyWindow` is ladder-only). (3) Pathway mode requires the primary pair; a
  multi-pair all/folder scope uses the primary pair's mode. (4) Not runtime-verified here — needs a real
  study run: set a pair to pathway, study, confirm states advance/branch/graduate correctly.

## Ladder: skip-ahead rules (2026-07-21)

The reverse of a drop-back: on a positive outcome N times (in a row or total this rung sitting), a card
jumps FORWARD to a later rung, skipping the ones between. `Rung.skipAheads?: SkipAheadRule[]` (domain),
`SkipAheadRule = { on: SkipTrigger; times; inARow?; toRungId }`, `SkipTrigger = 'pass' | 'good' | 'easy'`
(`'pass'` = a clean auto-checked correct; `'good'`/`'easy'` = self-rated ratings — these are what land in
`outcomeHistory` per rung type). Optional so ladders saved as JSONB before this load fine.

- **Engine** (`engine/ladderEngine.ts: reviewRungCore`): checked right AFTER the drop-back block and
  BEFORE the normal advance logic, so it's an alternative fast path. Matches against the per-rung
  `outcomeHistory` (in-a-row = last N all equal; total = count in the bounded window). Only fires when the
  target is a LATER rung (`idx > rungIndex`) — a same/earlier target is ignored (that's drop-backs).
  Jumping past the interval-init rung means that direction graduates at the flat 1-day default.
- **Editor** (`components/settings/LadderEditor.tsx`): an "If it goes well, skip ahead:" section mirroring
  drop-backs, shown only when a later rung exists. Trigger options via `availableSkipTriggers` (self-rated
  → Good/Easy, auto-checked → Correct=`pass`); target dropdown lists only later rungs.
- Tested in `engine/__tests__/ladderEngine.test.ts` (`describe('skip-ahead rules')`). NOTE: a skip "N
  times" only accumulates if the rung doesn't normally advance before N (e.g. it advances only on Easy but
  you skip on 2 Good) — a `times:1` skip is the common case and fires immediately.

## Ladder: per-card rung progression history (2026-07-17)

`ClimbState.rungHistory?: number[]` (0-indexed) records every rung a card occupied in order, drop-backs
included — e.g. `[0,1,2,3,2,3,4]` = "1→2→3→4→3→4→5". `engine/ladderEngine.ts`: `initialClimbState` seeds
`[0]`; `advance()` appends the new rung (unless it's the past-the-end graduation index) and `toRung()`
(drop-back) appends the target rung. **No migration** — the climb row stores the whole `ClimbState` in its
JSONB `state` column, and the row survives graduation (graduate() doesn't delete it). Shown in the card ℹ
stats panel as a "Rung progression" chip row (`CardEditModal` fetches the climb via
`SupabaseLadderClimbRepository.listForCards(userId,[cardId])`, displays rung+1). Cards climbed before this
shipped have no history (empty → section hidden). Tested in `engine/__tests__/ladderEngine.test.ts`.

## Day-turnover: fix pre-turnover due-date snapping + snap ladder graduation (2026-07-17)

Two linked fixes so a card graduating before the turnover hour is due at the start of the CURRENT study
day, not pushed a day late:
- **`lib/dates.ts: snapDueAtToStartOfDay` bug.** It mutated `local` (subtract a day when the time is before
  the turnover hour) and then computed the system↔target tz offset from the *mutated* value — corrupting it
  by 24h, so a pre-turnover due date snapped to the *next* study day. Fix: capture the offset BEFORE the day
  mutation. Only the before-turnover branch changes; after-turnover snapping is unaffected. Propagates to
  every caller (all FSRS session scheduling + the ladder).
- **Ladder `graduate()` now snaps.** It used the raw `now + days` timestamp (no turnover awareness). It now
  loads the profile tz + `day_turnover_hour` (`tzRef`/`turnoverRef`) and snaps both directions' due dates via
  `snapDueAtToStartOfDay`. So: graduate at 2:30am with a 1-day interval and turnover 4am → due at 4:00am the
  same calendar day (due once you cross 4am, not before). Tested in `lib/__tests__/graduationTurnover.test.ts`.

## Audio: global default source, robotic by default (2026-07-17)

The global audio default is now a 3-way **`profiles.audio_source_default`** ('browser' | 'elevenlabs' |
'forvo', **migration 088**, default **'browser'**) — superseding the `prefer_forvo` boolean (migration 084;
column left in place, no longer read/written; 088 migrates a true value to 'forvo'). **Robotic (device
speech) is the default and generates no clips** — playback falls back to the Web Speech synth. 'elevenlabs'
/'forvo' pre-generate real clips (forvo → ElevenLabs fallback). `lib/speak.ts`: `setAudioSourceDefault(src)`
/`getAudioSourceDefault()` (replaced `setPreferForvo`/`getPreferForvo`); `speakViaTts` returns null when
'browser' (no fetch); `lib/distractors.ts: fetchAndCacheAudio` early-returns when 'browser'. Set from the
profile on load in the ladder + all 3 session pages. Per-card `audioSource` (the ℹ picker) still overrides
per card. Settings: the "Prefer Forvo" checkbox became a **"Default audio source"** select. Also added a
per-deck **audio volume** slider (migration 087, `user_deck_preferences.audio_volume`; `setAudioVolume` in
`lib/speak.ts` applies it to clips + Web Speech).

## Smart typing: a lapse reverts to typed (2026-07-16)

A lapsed smart card now goes back to **typed** and stays typed until its interval climbs past the
threshold again — this now takes precedence over the accelerated self-grade shortcut.
`lib/sessionLimits.ts: forwardProductionMode` smart lane: **relearning → 'typed'** (during relearn the
interval hasn't dropped yet, so gate on the `relearning` flag, not just the interval), else
`smartProductionMode(interval, threshold)`. The accelerated (`import_known` + `acceleratedTypedConfirmed`)
override now applies only to the **typed (always-type) lane**, not the smart lane — so getting a smart card
wrong means you type it again even if it's import-known. All 3 session pages' smart branch now recompute
`productionMode = forwardProductionMode(smartNewState, 'smart', threshold)` when re-queuing a lapsed card,
so the revert shows up **immediately in-session** (the relearn re-show), not just next session. Tested in
`lib/__tests__/forwardProductionMode.test.ts`.

## FSRS: difficulty mean-reversion — escape "difficulty hell" (2026-07-16)

Cards that ratcheted up to difficulty 10 were frozen there: `DIFFICULTY_DELTA.good = 0`
(only Easy lowered difficulty), and at difficulty 10 the `stabilityAfterSuccess` growth factor
`(11 − D)` bottoms out at 1, so stability crawled and `intervalForRetention ≈ stability < 1 day`
→ floored to 1 → the card was due **every day forever**, no matter how many times you rated it Good.
(Confirmed from live data: e.g. `la tos` difficulty 10, stability 0.76, reps 11, last_rating hard.)
This is what the earlier "floor at 1 day" note called out as "expected" — it is NOT; it's now fixed.

Fix: `engine/fsrs.ts: nextDifficulty` now applies FSRS-5 **mean reversion** toward `BASE_DIFFICULTY`
(`DIFFICULTY_REVERSION = 0.1`): `D' = clamp((D + delta) + 0.1·(5 − (D + delta)))`. So a run of Goods
walks a maxed-out card back down (10 → 9.5 → 9.05 → …), which raises the `(11 − D)` factor and lets
stability — and the interval — grow. Again still climbs (5→6.8), Easy still drops fast (10→7.7), Hard
roughly holds near the top. Tests updated (difficulty assertions now mean-reverted, `toBeCloseTo`).
Already-stored difficulty-10 cards self-heal over subsequent Goods; a one-time SQL can lower pinned
`difficulty` (e.g. ≥9 → 7) to accelerate recovery.

Secondary observation (not yet changed): `isDueByDate` in the session pages compares the card's due
date via plain `toLocaleDateString` (no turnover) against a turnover-adjusted `today` — an asymmetry
that can make an early-morning (pre-turnover) review feel same-day. Left as-is for now.

## Ladder: "Learning" card_states count as pipeline + honest progress bar (2026-07-14)

Two ladder fixes in `app/study/ladder/[deckId]/page.tsx`:
- **Pipeline over-growth.** A card with a forward `card_state` that's `!graduated` but NO climb row (booted
  from Due Now, or a legacy learner — shows "Learning" in deck detail) was treated as **fresh** by the
  ladder, so batch mode saw an empty pipeline and introduced a whole new group of `cap` on top of it
  (13 learners with a cap of 12). Fix: a `learningStateSet` (forward `card_state`, `!graduated`) is now
  pushed to `learning` at the **initial rung** (`initialClimbState`), not `fresh`. So "Learning" = start
  of the pipeline, and the batch cap counts them.
- **Progress bar showed phantom %.** It counted the *absolute* rung positions of resumed cards, so it read
  ~48% before you'd done anything with only 1/7 graduated. Now it baselines the rung-steps already done at
  session start (`startStepsRef`) and reports `(stepsDone − start) / (totalSteps − start)` — 0% at start,
  100% when all graduate. Still monotonic.

## Relearn resurfacing — never slip a difficult card (updated 2026-07-14)

**Superseded the earlier "roll to a later session" behavior.** A lapsed graduated card (rated Again/Hard →
5/10/20-min relearn loop) **keeps coming back THIS session until it exits the relearn loop** (Good×2 /
Easy, or 3 Agains → ladder) — it is never deferred to a later session, so difficult cards can't slip by.
The relearn *gate* itself is in `engine/dueNow.ts: reviewDueNow` (Again keeps relearning, needs two Goods
in a row or one Easy to escape; the gate state — `relearning`/`goodStreak`/`againStreak` — persists on the
row so it continues correctly across sessions).

The relearn *effect* (all 3 session pages, deps `[index, queue.length, done, loading, relearnPool]`; deck
page also guards `showElectivePicker`):
- Resurfaces a relearn card mid-session once its real-clock `dueAt` has passed (spliced ~3 ahead).
- When the main queue empties while relearns are still pending, it **flushes the soonest-due relearn card
  to the end** (regardless of clock) instead of ending — the session doesn't finish with unresolved
  relearns.

`lib/relearnPool.ts: partitionRelearnPool` and `SessionCard.relearnLapsedAt`/`batchSizeRef` are now unused
(the batch-size "roll over after N cards" window was removed); left in place but dead.

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

## Offline mode (Stage 3 done, 2026-07-18)

Toggle-based, online-primary offline study. **The study path (ladder + Due Now) works offline;
sync-back (Stage 5) and the conflict popup (Stage 6) are NOT built yet — see below.**

- **Local store**: `lib/offline/localStore.ts` (Dexie/IndexedDB) + `getLocalStore()` singleton;
  tables for cards, cardStates, ladderClimb, decks/folders, ladders, schedulerParams, overrides,
  deckCards, meta, and an **outbox** (`++id, entity`) that captures every offline write.
- **Toggle**: `lib/offline/mode.ts` — `isOfflineActive()` (server-safe, reads localStorage
  `lexify-offline-mode`), `setOfflineMode(on)`. The reactive React hook `useOfflineMode()` lives in
  `lib/offline/useOfflineMode.ts` (SEPARATE file, `'use client'`) — do NOT put the hook back in
  `mode.ts`; `mode.ts` is imported into server bundles via the repo layer and must stay React-free.
- **Download**: `lib/offline/download.ts: downloadForOffline({scope, dueWindowDays, includeAudio})`
  gathers cards/states/climb/config for a scope (library/language/folder/deck), pre-generates
  distractors, strips audio unless includeAudio, and hydrates the local store. UI:
  `components/settings/OfflinePanel.tsx` (in Settings) — scope picker + due-window + audio toggle +
  Download + the **offline toggle** (shown once a bundle exists) + Clear. Outbox pending-count shown.
- **Repo router (Option B)**: the Supabase repos delegate to `lib/offline/localRepos.ts` when
  `isOfflineActive()` — guards added to `cardStates`, `ladderClimb`, `ladders`, `ladderEvents`,
  `userSchedulerParams`, `typedAnswerOverrides`, `decks`, `folders`, `cards`. So the study
  pages/ladder are UNCHANGED; offline is a flag with zero online impact when off. Every local write
  also `enqueue()`s to the outbox (undo of a ladder event removes its pending insert).
- **Ladder profiles fix**: `LadderStudy.tsx` skips the direct `supabase.from('profiles')` read when
  offline — uses the DEVICE timezone (`Intl…resolvedOptions().timeZone`), turnover 0, browser audio.
  Deck-prefs fetch also skipped offline.
- **AI gating**: an amber **offline banner** (Navbar) with "Go online"; the **Agents** and **Upload**
  nav links are hidden offline; `CardEditModal` blocks audio-provider fetch and the reset/regenerate
  actions offline (robotic/device TTS still works — it needs no network). Audio *generation* is
  already neutralized offline (browser default + `fetchAndCacheAudio` early-return).
- **Migrations**: `095_offline_updated_at.sql` (adds `updated_at` triggers to
  user_scheduler_params, card_confusion_links, typed_answer_overrides — for future conflict
  detection). USER CONFIRMED RAN 095.
- **Tests**: `lib/offline/__tests__/localStore.test.ts`, `download.test.ts`, `localRepos.test.ts`
  (fake-indexeddb). All green; tsc + `npm run build` pass.
### Sync engine + conflict resolution (Stage 5 + 6 done, 2026-07-18)

Toggling offline OFF now **syncs the outbox back to Supabase**.

- **`lib/offline/coalesce.ts`** (pure, tested): `coalesceOutbox(entries)` collapses the outbox — state
  entities (cardState/ladderClimb/override/card) are last-write-wins per key (accumulating all outbox
  ids to clear on success); events (ladderEvent/reviewEvent) stay distinct appends.
- **`lib/offline/sync.ts`**: `pushOutbox(userId, onProgress)` drains the outbox. Non-cardState writes
  (events, overrides, card edits, ladder climb) push unconditionally via the normal Supabase repos
  (which are online because the toggle flipped first). **cardState writes are conflict-checked**: it
  compares the server row's `updated_at` to the local download baseline (`serverUpdatedAt`, preserved
  across offline edits by `localUpsertCardState`); if the server changed too, the local write is held
  back as a `CardStateConflict`. `resolveConflicts(userId, conflicts, choices)` applies per-card
  keep-device (push local) / keep-cloud (adopt server locally). Reuses `cardStateToRow`/`rowToCardState`
  (now exported from `lib/data/cardStates.ts`).
- **`components/settings/SyncConflictModal.tsx`**: per-card device-vs-cloud diff (due/interval/reps/
  lapses/rating/graduated/dormant/difficulty/stability/reviewed) with per-card + bulk keep-device/
  keep-cloud, "Apply & finish sync", and "Decide later" (keeps the outbox for a later "Sync now").
- **`OfflinePanel`** toggle: ON → `setOfflineMode(true)`; OFF → `setOfflineMode(false)` then `pushOutbox`
  (progress line + conflict modal + result). A "Sync now (N)" link appears when online with a
  non-empty outbox.
- **reviewEvents offline guard (Stage 3 leftover, fixed here):** `lib/data/reviewEvents.ts` create/
  delete are now offline-guarded (`localCreateReviewEvent`/`localDeleteReviewEvent` — local id +
  outbox, undo removes the pending insert). Without this, offline **Due Now** reviews threw. (Ladder
  events were already guarded.)
- **Known v1 limits**: offline review_events push with server-default `reviewed_at` (push time, not
  study time — analytics timing only); conflict detection is cardState-only (climb/override/card edits
  are last-write-wins); `fetchServerState` uses `maybeSingle()` so duplicate forward rows would need
  cleanup first. Confusion-linking during offline study is best-effort (fire-and-forget, fails silently
  offline) — scheduling is unaffected.
### Offline: create decks + edit ladders (2026-07-18)

- **Create page** (`app/create/page.tsx`, formerly `/upload`): online form keeps the **AI agent**
  ("Format with AI agent") — it's online-only (the offline `OfflineUploadForm` has no AI). Offline mode
  is per-device localStorage (`lexify-offline-mode`); one device's offline state never affects another.
- **Offline deck creation** (`OfflineUploadForm`): full flow (name, languages, separators, paste,
  preview, exact+near dup check via the pure `analyzeDuplicate`, folder picker) writing to the local
  store + outbox (`deckCreate`/`folderCreate`/`deckCardLink`/`cardCreate`, pushed FK-safe order on sync).
- **Offline ladder editing**: `SupabaseLadderRepository.list/saveForPair/saveDefault/resetPair` are now
  offline-guarded → `localAllLadders`/`localSaveLadder`/`localResetLadder` (local + outbox
  `ladderSave`/`ladderReset`, synced on reconnect). `ladderKey('','')` = `'default'`. Every download
  ALWAYS bundles all pair ladders + the default (whole-user config, any scope) so downloaded cards run
  the pipeline accurately offline.
- **Download distractors** persist to the server for cards that had none (direct `cards.update`).
- **Download speed (2026-07-20)**: distractor pre-generation was strictly sequential — one AI round-trip
  per card, awaited one at a time — which made a few-hundred-card download take 10+ minutes (network
  latency, not local work). Now runs `AI_CONCURRENCY = 5` in flight via a `mapLimit` helper in
  `lib/offline/download.ts` (persist-back writes at `DB_CONCURRENCY = 10`). Deliberately not higher: a
  provider 429 silently falls back to deck-sibling distractors, so extra speed costs distractor quality.
  Also fixed an O(n²) — `siblings` was re-filtering the whole card list per card; now grouped by pair
  once up front, which mattered most on phone CPUs. Confirmed much faster on device.
- **Toggle gating**: the Online/Offline switch is disabled unless the download is up to date (no pending
  outbox + no server card/state edits since download); "Update" (renamed from Re-download) syncs then
  re-downloads. Nav "Analytics" links to Overview; hover dropdown = Connections/Logs only (no arrow).

### PWA — installable + offline app shell (Stage 7 done, 2026-07-18)

Lexify is now an installable PWA that boots offline from the home-screen icon.

- **`app/manifest.ts`** → served at `/manifest.webmanifest`: name/short_name Lexify, `start_url:'/study'`,
  `display:'standalone'`, portrait, theme/background `#12121a`, icons (192, 512, maskable-512).
- **Icons**: generated by `scripts/generate-icons.mjs` (a one-off Node script using the already-present
  `sharp`) into `public/icons/` (icon-192, icon-512, icon-maskable-512, apple-touch-icon-180) plus
  `app/icon.svg` (auto-served favicon). The mark is a white ladder on the indigo brand gradient. Re-run
  `node scripts/generate-icons.mjs` to regenerate.
- **`public/sw.js`** — hand-written service worker (no Workbox). Cache `lexify-shell-v1`: `/_next/static`
  + `/icons` + fonts/images = cache-first; navigations = network-first → cache → `/study` fallback;
  other same-origin GET = network-first → cache. **Cross-origin (Supabase) and `/api/` are never
  touched** (they hit network and fail-as-designed offline; the app handles that via offline mode).
  Registered by **`components/pwa/ServiceWorkerRegister.tsx`** (production only, after load) mounted in
  `app/layout.tsx`.
- **`app/layout.tsx`** metadata: `manifest`, `appleWebApp` (capable + black-translucent status bar +
  title), `apple-touch-icon`, plus an explicit `apple-mobile-web-app-capable: yes` (Next's own tag is
  `mobile-web-app-capable`; iOS wants the `apple-` one too). New `viewport` export: theme-color
  `#12121a`, `viewportFit:'cover'` (notch-safe).
- **To install**: iOS Safari → Share → Add to Home Screen; Android Chrome → install prompt / menu.
  (SW registers in production only, so test against the Vercel deploy, not `npm run dev`.)
- **VERIFIED ON DEVICE 2026-07-20** (iPhone, PWA from the home screen): install, offline download,
  toggle to Offline, **force-quit + relaunch → still offline and fully usable**. That proves the SW
  really is serving the shell from cache (not just an in-memory page), IndexedDB survives app kill, and
  the offline flag persists across launches. **Still unverified on device: the sync-back leg** — study
  offline, reconnect, confirm the outbox drains and counts reconcile. That's the leg where data loss
  would actually show up, so treat it as untested until someone does it.
- Bumping the SW cache: change `CACHE = 'lexify-shell-v1'` in `public/sw.js` to force old shells out.

### Native app: query-param routes + static export + Capacitor (Stage 8 in progress, 2026-07-18)

The bundled native app requires a fully static web export, which Next can't do with dynamic route
SEGMENTS (arbitrary `/study/[deckId]` ids hard-404 in export; `dynamicParams:true` is forbidden with
`output:export`; iOS Capacitor WKWebView can't run a service-worker SPA fallback). **Solution: all
data-driven routes were converted from path segments to QUERY PARAMS** — this works identically
server-rendered on Vercel AND as a static export, and client navigation to any id works (verified in a
served `out/`: `/study/deck?deck=<anyid>` renders, no 404).

- **`lib/routes.ts`** — the single source of truth for these URLs. ALWAYS build them via `routes.*`
  (`routes.deck(id)`, `routes.deckSession`, `routes.deckAdd`, `routes.deckEdit`, `routes.folderSession`,
  `routes.ladderDeck`, `routes.ladderFolder`, `routes.library`, `routes.agentsReview`), never hand-write
  the path. Extra query params go in the 2nd arg: `routes.deck(id, { filter, card })`.
- **Route moves** (old dynamic → new query-param):
  `/study/[deckId]`→`/study/deck?deck=`, `.../session|add|edit` similar; `/study/folder/[folderId]/session`
  →`/study/folder/session?folder=`; `/study/ladder/[deckId]`→`/study/ladder/deck?deck=`;
  `/study/ladder/folder/[folderId]`→`/study/ladder/folder?folder=`; `/library/[folderId]`→`/library/folder?folder=`;
  `/agents/review/[changeSetId]`→`/agents/review?cs=`. Each page reads its id via `useSearchParams()`
  (agents/review wrapped in `<Suspense>` for it). **No dynamic route segments remain** in `app/`.
- **`next.config.ts`** — `output:'export'` + `images.unoptimized` gated on `CAPACITOR_BUILD=1`; the normal
  Vercel build is unaffected (routes render server-side).
- **`scripts/cap-build.mjs`** (`npm run build:cap`) — stashes `app/api` + `app/manifest.ts` (can't be
  statically exported), runs the export with `CAPACITOR_BUILD=1` and `NEXT_PUBLIC_API_ORIGIN`
  (default `https://lexify-flax.vercel.app`), then restores. Output → `out/` (gitignored, + `.cap-stash/`).
- **`lib/apiBase.ts`** — `apiUrl(path)` prefixes `NEXT_PUBLIC_API_ORIGIN` (empty on web = relative; the
  deployed origin in the native bundle). ALL `fetch('/api/...')` call sites now use `fetch(apiUrl('/api/...'))`
  so the native app's online-only AI features (card gen, distractors, TTS, IPA, sync, agents) reach Vercel.
- **Capacitor** — `@capacitor/core`+`cli`+`ios` installed; `capacitor.config.ts` (appId `com.lexify.app`
  — CHANGE before `cap add ios`; `webDir:'out'`). npm scripts: `build:cap`, `cap:sync`, `cap:ios`.

- **REMAINING (user must run locally — needs their machine + account):**
  1. Install **Xcode** (full app) and **CocoaPods** (`brew install cocoapods`).
  2. Change `appId` in `capacitor.config.ts` to your own reverse-DNS id.
  3. `npx cap add ios` (generates `ios/` — commit it), then `npm run cap:ios` (builds export, syncs, opens
     Xcode). In Xcode: set the signing Team (needs an **Apple Developer account** — free tier runs on
     device 7 days; $99/yr paid tier for App Store + longer). Run on a simulator/device.
  4. Test offline study + reconnect sync ON DEVICE (can't be verified here).
  Optional polish later: splash screen / app icons for iOS (`@capacitor/assets`), Android platform,
  status-bar plugin.

## Retention auto-calibration — feed measured retention back into intervals (2026-07-19)

The stock FSRS weights aim every interval at the pair's TARGET retention (`request_retention`, the slider),
but a learner who consistently recalls *better* than target has intervals shorter than they need — the model
underestimates their memory. Now the calibrate route measures this per track and the scheduler stretches
(or shrinks) intervals to actually land near target, at NO change to target retention.

- **Migration `096_retention_calibration.sql`** (must apply): adds
  `user_scheduler_params.retention_calibration REAL NOT NULL DEFAULT 1.0` — **per answer_field** (each track
  has its own measured retention). `SchedulerParams.retentionCalibration` + `DEFAULT_SCHEDULER_PARAMS` (1.0) +
  both repo `rowToParams` mappings updated.
- **Calibrate route** (`app/api/calibrate/route.ts`): `calibrateBucket` now also stores
  `retention_calibration = clamp(ln(target)/ln(measured), 0.5, 2.5)` (`retentionCalibrationFactor`), where
  `target` = the pair's forward_typed `requestRetention` (passed down from `calibratePair`). measured > target
  → >1 (stretch); < target → <1 (shrink). Only set once a bucket has ≥ its minSample of reviews (same gate as
  `recent_retention_rate`); `measured` clamped to [0.5, 0.995] to avoid ln(1)=0 blow-ups.
- **Recency weighting (2026-07-20)**: `measured` retention is a **recency-weighted** mean, NOT a flat average
  — a review's weight halves every 7 days (`RETENTION_HALF_LIFE_DAYS`), so the past week dominates an earlier
  rough patch (80%→95% over a week measures ≈95%, and intervals stretch to match). The pure math lives in
  `lib/retentionCalibration.ts` (`recencyWeightedMean`, `recencyWeight`, `retentionCalibrationFactor`, moved
  out of the route; tested in `lib/__tests__/retentionCalibration.test.ts`). The route now pulls a BROADER
  pool (`poolSize = min(600, max(minSample·4, 200))`) than the calibrate gate (`minSample`, the old dynamic
  20–150) so the weighting has old-vs-recent reviews to discriminate; the half-life makes the stale tail
  contribute negligibly, so the larger pool never lets old data dominate. This also changes the displayed
  "Measured retention" (library SRS modal reads `recent_retention_rate`) to the recency-weighted value.
- **Engine** (`engine/fsrs.ts` + `engine/dueNow.ts`): `FsrsConfig.retentionCalibration?` (default 1). New
  `scheduledIntervalDays(stability, cfg)` = `max(1, cal · intervalForRetention(S, requestRetention))`, used by
  `scheduled()` and `scheduleGraduatedFsrs`. It multiplies the *scheduled interval only* — stored stability/
  difficulty are untouched (FSRS state stays pristine; the correction is re-applied fresh each schedule, a
  proportional controller that converges as `measured → target`).
- **Session pages (all 3)**: build a per-(pair,track) calibration map from `listForUser()` rows
  (`lib/sessionLimits.ts: buildCalibrationMap` / `calibrationFor`) and pass `retentionCalibration` into every
  `scheduleGraduatedFsrs` cfg — keyed by the reviewed track's answer_field (typed→forward_typed,
  smart→forward_smart, recall→forward_recall, reverse→reverse_recall). Deck session stores the 4 values in a
  ref (single pair); all/folder key by `${src}|${tgt}:${field}`.
- **Forecast reflects it**: `lib/forecastFsrs.ts` `fsrsScheduleSampled`/`monteCarloSteps` (analytics chart) and
  `fsrsScheduleMix` (dashboard "Coming up") take an optional `calibration` multiplier on the scheduled interval.
  `DueForecastProjection` (`PairCfg.{typed,selfg,smart,reverse}Cal`) and `app/study/page.tsx`
  (`PairForecastCfg` + `emit(...calibration)`) read `retentionCalibration` per track and pass it, so projected
  load drops to match the real schedule.
- **Transparency**: the per-pair SRS modal (`app/library/page.tsx`) "Measured retention" table gained an
  **Interval ×** column showing each track's calibration (green >1, amber <1, "—" at ~1).
- Tests: `engine/__tests__/dueNow.test.ts` (calibration scales interval, not stability) +
  `lib/__tests__/forecastFsrs.test.ts` (calibration>1 → fewer reviews in horizon). All green.
- Note: this is the fix for "does the system take my high retention into account?" — before this it did NOT
  (measured retention only fed the forecast/display, never scheduling).

## Per-track target retention (2026-07-19)

`request_retention` is now set + read **per answer_field** instead of only canonically on forward_typed —
so production, self-graded, and reverse recall can each aim for their own retention. No migration
(`request_retention` already exists on every row, migration 076; default 0.90).

- **Settings** (`app/library/page.tsx`): the single "Target retention" slider became **three** — "Typed /
  production", "Self-graded", "Reverse recall". `handleSrsRetention(fields: string[], value)` writes to the
  listed answer_field rows; the production slider writes **both** `forward_typed` + `forward_smart` (so
  whichever production lane is active picks it up).
- **Scheduling** (`lib/sessionLimits.ts` + 3 session pages): `buildRetentionMap(rows)` / `retentionFor(map,
  src,tgt,field)` (parallel to the calibration map). Each `scheduleGraduatedFsrs` cfg now uses the reviewed
  track's own target (`retRef`/`retMapRef`, keyed by answer_field: typed→forward_typed, smart→forward_smart,
  recall→forward_recall, reverse→reverse_recall) instead of the shared `schedulerParams.requestRetention`.
- **Calibration** (`app/api/calibrate/route.ts`): each bucket now calibrates toward its OWN
  `params.requestRetention` (dropped the forward_typed `target` passed from `calibratePair`).
- **Forecast** (`DueForecastProjection` + `app/study/page.tsx`): the projection's retention basis switched
  from **measured** (`recent_retention_rate`) to each track's **target** (`request_retention`) + calibration —
  which is exactly `interval = calibration · intervalForRetention(S, target)`, i.e. it now matches the live
  scheduler (the old measured+calibration basis double-corrected and under-counted the stretch). So the
  per-track sliders visibly move the chart. `PairCfg.{typed,selfg,smart,reverse}P` now hold target retention.

## Performance findings — NOT yet fixed (diagnosed 2026-07-20)

The app feels slow and shows "Loading…" often. Measured causes, worst first. Nothing here is
implemented; this is a work plan.

**The Analytics → Present tab is the worst offender.** Three components mount and fetch independently:
`PresentSnapshot` (2 queries PER DECK + 3 paged), `AccuracyTrend` (1 paged over 30d `review_events`),
`LearningEfficiency` (3 paged, incl. the SAME 30d `review_events` again). `fetchAllRows` pages
**sequentially**, so ~13,700 reviews = ~14 serial round-trips — done twice, because the two charts each
fetch the same window separately. Net: **~28 serial requests, ~27,000 rows shipped to the browser, to
draw lines with ~30 points.**

Ranked by impact per unit of effort:

1. **Aggregate in Postgres (biggest win).** Add RPCs that `GROUP BY day, language` for the accuracy,
   efficiency, and calendar charts. Returns ~180 rows in ONE request instead of ~13,700 in ~14, and
   deletes the client-side bucketing loops. This also removes the paging latency that the 1000-row-cap
   fixes introduced (those fixed real correctness bugs — see below — but cost round-trips).
2. **Lazy-load off-screen charts.** Only `PresentSnapshot` is above the fold; gate the other two behind
   an IntersectionObserver so they don't fetch until scrolled to. ~20 lines, no migration, biggest
   *perceived* win.
3. ~~**Kill the per-deck N+1.**~~ **DONE 2026-07-20 for Study + Library + card search.** Added
   `cardRepo.listAllForUser` / `cardRepo.deckIdsByCard` / `stateRepo.listAllForUser` /
   `climbRepo.listAllForUser` (all paged, all offline-guarded) plus `loadLibraryBulk()` in
   `lib/folderStats.ts`, which loads the whole library in FOUR queries and groups it by deck.
   `computeDeckCounts` takes an optional `bulk` and then does zero queries.
   - `app/study/page.tsx` was **3 requests per deck with a serial dependency** (climb waited on the
     cards response) → now 4 total.
   - `app/library/page.tsx` called `computeDeckCounts` once per root folder (each fanning out per
     deck) AND repeated a 2-per-deck fetch for the pairing totals → both now read from one bulk.
   - Library card search fired `listByDeck` per deck on the first keystroke → now one query.
   - STILL per-deck (not yet done): `LadderStudy`, `DueForecastProjection`, `VocabGrowthProjection`,
     `PresentSnapshot`, and the 3 session pages. Same fix applies — pass `loadLibraryBulk` output in.
4. **No cache across navigations.** Every page mount refetches from scratch, so Study → Analytics →
   Study pays full cost three times. A module-level cache with a short TTL would make tab-switching
   feel instant.

Counts (Unlearned/Learning/Graduated/Due/Dormant) are a special case of #1 — they pull every card and
state to display five integers. `count: 'exact', head: true` queries would do it without shipping rows.

### The 1000-row cap (fixed, but read this before adding queries)

PostgREST enforces `db-max-rows` (1000 on Supabase) and a client `.limit(n)` does **not** lift it — it
silently truncates. This caused four separate bugs before being caught: analytics charts starved to ~2
days of data, the offline download losing deck links AND conflict baselines, the ladder hanging on a
whole-pair scope, and the review calendar undercounting every day. Use `fetchAllRows`
(`lib/supabasePaged.ts`) for anything that can exceed 1000 rows, always with a deterministic `.order()`.
Also chunk large `.in()` lists (~400 ids) — a 1000+ element `.in()` builds a query string big enough to
be rejected outright.

## Goal carryover (2026-07-20)

Two opt-in toggles let yesterday's shortfall or surplus adjust today's per-language goal.

- **Migration `097_goal_carryover.sql`** (must apply): `profiles.goal_carry_shortfall` +
  `goal_carry_surplus`, both `BOOLEAN NOT NULL DEFAULT FALSE`.
- **`lib/goalCarryover.ts: carriedGoal({baseGoal, yesterdayGoal, yesterdayCount, carryShortfall,
  carrySurplus})`** → `{goal, delta}`. Pure, tested in `lib/__tests__/goalCarryover.test.ts`.
  Rules: a **rest day** (yesterdayGoal null or ≤0) yields neither credit nor debt; the goal **floors
  at 0** and the returned `delta` reports only the adjustment that actually landed (so a 50-card
  surplus against a goal of 20 reports −20, not −50).
- **Scope: yesterday only, deliberately.** Time off leaves you owing one day, never a spiral. This was
  an explicit user decision, as was **the goal NUMBER only** — the serving cap (`daily_new_cards`,
  per-deck) is untouched, so a raised goal is a target, not permission to be served more new cards.
  Do not "helpfully" wire this into the ladder's new-card budget without asking.
- **`app/study/page.tsx`**: the graduation query widened 48h→**72h** (with a 4am turnover the logical
  "yesterday" can start nearly 48h back, leaving no margin) and now buckets into both
  `todayGradCounts` and `yesterdayGradCounts`. `pairsWithGoalsToday` returns
  `{pair, key, goal, delta}` with carryover applied; the row shows a "+N missed yesterday" /
  "N carried over" note, and `pct` guards `goal <= 0`.
- **Settings**: two checkboxes at the foot of the Daily Goals panel (`app/settings/page.tsx`),
  wired through the same profile read/update as `spilloverDue`.
- Applied in two places: the Study page's "Today's goals", and `components/analytics/PresentSnapshot.tsx`
  (both the "Today's goals" list AND the "~N min to learn M new words" tile, whose `remainingNew`/`projNewMs`
  derive from the carried goal). Both read the two profile flags + yesterday's per-pair graduations.
  `ReviewCalendar` intentionally keeps raw per-day goals — a past day's target is a historical record.
- **The two "Today's goals" lists show DIFFERENT slices (2026-07-20, per user):**
  - **Study page** — only pairs that STILL need work (`todayCount < carriedGoal`), just name + `count/goal`.
    No delta note, no green. Met / surplus-auto-fulfilled pairs drop off. It's the "what do I still owe" list.
  - **Analytics → Present** — the FULL picture: every pair with a base goal today (filter on `baseGoal > 0`,
    NOT the carried goal), incl. surplus-auto-fulfilled pairs rendered `0/0 ✓` green, plus the
    "+N missed yesterday" / "N carried over" delta note. `PresentSnapshot`'s `goals` now carries `baseGoal`
    + `delta`. Don't "unify" these — the split is intentional.

## Two-stage Undo in Due Now sessions (2026-07-20)

Pressing Undo after rating a graduated card now has two stages, in all 3 session pages
(`study/all`, `study/deck`, `study/folder`):

1. **First press** — reverts the rating in the DB (restores `prevState`, deletes the review event,
   same as before) AND re-shows the just-rated card **answered** so a different rating can be picked
   without redoing the card. Implemented via a `reRate` state `{queueIndex, userAnswer, wasCorrect,
   selfGraded}`; the render, when `reRate.queueIndex === index`, swaps in `FlashcardMode` with a new
   `resumeAnswered` prop (mounts `revealed=true` → shows the answer + Again/Hard/Good/Easy),
   `autoPlayAudio={false}`. Re-rating calls `handleAnswer(rating, selfGraded ? rating!=='again' :
   wasCorrect, userAnswer)` from the reverted state — so a typed card re-logs a typed event with the
   original typed answer, a self-graded card recomputes correctness from the new rating.
2. **Second press** (while the answered view is up) — `handleUndo` early-returns `setReRate(null)`,
   which remounts the real card component **blank** for a full redo. No DB write (already reverted).

Wiring notes: the 3 `setUndoStack` record sites now also store `userAnswer, wasCorrect, selfGraded:
productionMode === 'self-graded'` on the `UndoEntry`. `handleAnswer` clears `reRate` at the top (a
fresh rating supersedes the view). `UndoFab show` is `undoStack.length > 0 || reRate !== null` so the
second press stays reachable when the first press emptied the stack. Not applied to the ladder
(`LadderStudy`) — its rung-outcome undo is a separate model; extend there only if asked.

## Due Now counts unified across all surfaces (2026-07-20)

The "Due Now" count differed by surface (deck detail showed 7, Library aggregate + dashboard showed 0)
because each surface re-implemented the due check inline and they'd drifted. Now there is ONE shared
helper and every surface routes through it.

- **`lib/dueStatus.ts`** (new, tested in `lib/__tests__/dueStatus.test.ts`): `isCardStateDueNow(state,
  {tracks, tz, today, forwardState})` + `isDueByLocalDate(dateStr, tz, today)`. The canonical
  definition, matching the session queue + dashboard: **date-level** (turnover-aware, not `dueAt <= now`
  wall-clock), reads the **real per-track columns** (`smart_due_at ?? typed_due_at ?? due_at` for
  production, `recall_due_at` for recall/reverse), **track-filtered** (a ghosted/disabled track never
  counts), dormancy- and reverse-aware (reverse rows need the forward counterpart graduated + not dormant).
- **The three legacy surfaces were fixed** to use it: `app/study/deck/page.tsx` (was `due_at`-only,
  date-level, NO track filter → over-counted 7), `lib/folderStats.ts: computeDeckCounts` and
  `app/library/page.tsx` pair box (were `due_at <= now` timestamp, forward-only), and
  `app/library/folder/page.tsx: countDeck` + card-list `'due'` filter. The dashboard (`app/study/page.tsx`)
  was already correct and is the reference the helper was extracted from (left as-is to avoid touching the
  forecast; its `prodDueOn`/`recallDueOn`/`reverseDueOn` are equivalent to the helper by construction).
- **Plumbing**: `LibraryBulk` (folderStats) now also carries `enabledByPair`, `pairByDeck`, `tz`, `today`;
  `loadLibraryBulk` loads scheduler-track flags + profile tz to build them. Its signature changed from
  `(userId, deckIds, ...)` to `(userId, decks, ...)`. Deck detail + folder view load the track flags +
  tz themselves (small extra fetches). The card-list `'due'` filters (library + folder) use a per-card
  "any row due" check so the list matches the stat box (which counts due ROWS).

## "Stop at daily goal" new-card cap (2026-07-21)

A per-deck toggle that caps new-card intake so a deck never introduces enough to graduate PAST the
language's daily goal (`language_pairs.goals` for today). Keeps topping the pipeline up toward the goal
but no further: goal 20 with 5 graduated-today + 5 in-pipeline → adds 10; goal 10 with 10 in-pipeline →
adds 0 (so you graduate exactly 10, not 11).

- **Migration `098_cap_new_to_goal.sql`** (must apply): `user_deck_preferences.cap_new_to_goal BOOLEAN
  DEFAULT FALSE`. `DeckPreferences.capNewToGoal` + repo mapping (`lib/data/deckPreferences.ts`).
- **UI**: "Stop at daily goal" checkbox in `DeckSettingsPanel` (`app/study/deck/page.tsx`), below the
  "Limit cards in learning" block. Independent of the pipeline cap.
- **Enforcement — `components/ladder/LadderStudy.tsx`**: on the DEFAULT queue for a single-deck ladder
  (`scope.kind === 'deck'`, category not new/learning, online only), it loads the pair's goal + counts
  graduated-today for the pair (72h window, turnover-bucketed, excludes accelerated), then caps the
  fresh POOL: `eligibleFresh = fresh.slice(0, max(0, goalToday − gradTodayPair − learning.length))`.
  Capping the pool (not the queue) makes the existing batch/rolling/refill logic respect it for free —
  the rolling `pendingFresh` refill draws from the same pool, so intake stops once the budget is spent.
  `goalToday === 0` (no goal today) → no cap. Composes with `cardsPerSession`/daily limit (extra ceiling,
  whichever binds first). `hasMore` uses `eligibleFresh.length`.
- **Known limitation**: `gradTodayPair` is pair-wide but `learning.length` is this deck's pipeline. Exact
  for one-deck-per-pair (the common case); a multi-deck pair could under-count other decks' in-flight
  pipelines. Offline is excluded (goal data isn't bundled).

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
