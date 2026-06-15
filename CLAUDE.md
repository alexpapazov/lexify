# Lexify — project memory

This file is the persistent context for working on Lexify across separate
chat sessions. Read it at the start of any session touching this codebase.
Update it (briefly) whenever you ship a feature or learn something a future
session would need.

## What Lexify is

A Quizlet-style vocabulary app with an Anki-style spaced-repetition engine,
intended to grow into a broader language-learning tool (spoken + signed
languages, AI-assisted features). Currently focused on a Spanish↔English
vocabulary pipeline, but the domain model is language-pair-generic.

## Tech stack

- Next.js App Router + TypeScript (strict mode), all pages are `'use client'`.
- Supabase (Postgres + Auth + RLS) as the backend. SQL migrations live in
  `supabase/migrations/`, numbered sequentially (`001_...` through
  `023_...` as of 2026-06-15).
- Tailwind for styling.
- Jest for engine unit tests (`npm test`).

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
3. **typing**, prompt=front, answer=back, requiredCorrect=2 —
   Spanish shown, type English.
4. **recognition**, prompt=front, answer=back, requiredCorrect=1 —
   *(new, migration 023)* one final Spanish→English multiple-choice check
   before the card graduates.

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

## Wrong-answer ("confusion") tracking

`card_confusions` table (migration 021) + `record_card_confusion` RPC +
`lib/data/cardConfusions.ts: SupabaseCardConfusionRepository.record()`.
Surfaced in the deck detail page's card stats (CardEditModal-equivalent).

As of this session (2026-06-15), all 3 session pages' `handleAnswer` record
**every** wrong answer — multiple-choice pick or typed response, in either
direction — not just the original "English shown → pick Spanish, picked
wrong" case. The "confused with" card lookup uses `step.answerSide` to know
whether to match against `card.front` or `card.back` of the candidate cards.

## Migrations

Sequential, in `supabase/migrations/`. Latest is `023`:

- `001_initial.sql` … `020_scheduler_v2.sql` — core schema, folders, language
  pairs, shared cards, scheduler v1→v2, lapse clustering.
- `021_card_confusions.sql` — `card_confusions` table + RPC.
- `022_typing_streak_redo.sql` — typing-mistake-streak → MC redo (pipeline
  logic was already generic; this migration's SQL content should be checked
  if you need the exact DDL).
- `023_pipeline_step5_recognition_redo.sql` — adds pipeline step 4 (final
  Spanish→English MC) to the default pipeline.

**Migrations are not auto-applied.** When you add one, tell the user to run
it in the Supabase SQL editor (or via CLI) — don't assume it's live just
because it's committed. If a feature seems "not working" in the deployed
app, first check (a) was the migration applied, and (b) was the code
built/pushed/deployed.

## Standing operational rules (do not drop these)

- **Commit/push commands must always be given directly in the chat as a code
  block — never written to a file.** The user runs them locally.
- **All bracket-containing route paths** (e.g. `[deckId]`, `[folderId]`)
  **must be quoted** in every git command, due to zsh glob expansion.
- The `mcp__workspace__bash` sandbox has a persistent mount error for this
  project's folder (`failed to mount ... as Language Learning Application` /
  similar for `lang_learn_app`) — assume it's broken unless you've just
  verified otherwise. Give build/test/migration/commit commands as chat code
  blocks for the user to run locally and paste results back.

## Known backlog / open issues

- **#55**: "Merge" action for duplicate cards creates a new duplicate instead
  of reusing the existing card.
- **#59**: Exact-duplicate cards can still get duplicated on save (separate
  from #55).

Neither has been actioned yet as of 2026-06-15.

## Verifying changes

```
cd "/Users/alexanderpapazov/Code/alex_creates/lang_learn_app"
npm run build
npm test
```

Both should pass before committing. `npm test` runs the `engine/__tests__/`
suite (pipeline, scheduler, grading, productionMode) — these are pure-logic
tests with no Supabase dependency.
