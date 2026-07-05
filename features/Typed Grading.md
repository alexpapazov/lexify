# Typed-answer grading — per-category strictness + error capture

Status: **backend + settings landed; session/TypingMode wiring pending** (see
"Remaining wiring"). Migration `066` must be applied before this works.

## Goal

Make typing the primary production mode and stop over-penalizing non-memory
slips. A wrong **spelling** is penalized; **accent** and **article** slips are
retyped but (optionally) not punished on the schedule; every slip is recorded
by category for future "spelling practice" and "gender/article assign" modes.

## Behaviour

Grade the typed answer in flexible mode with `ignoreAccents` /
`ignoreDefiniteArticles` / `ignoreMinorTypos` all **false** so every slip
surfaces as an `'almost'` with an `issueType`. Then `resolveTypedPenalty()`
(engine/grading.ts) applies the per-pair strictness:

| Deviation | issueType | Strict | Lenient | Retype | Colour |
|---|---|---|---|---|---|
| exact | none | full credit | — | no | green |
| accent | `accent` | 20% penalty | 0% | yes | amber / green |
| article | `article` | 20% penalty | 0% | yes | amber / green |
| spelling | `typo` | **30%** penalty | 0% | yes | amber / green |
| missing paren | `parenthetical` | 20% (fixed) | — | yes | amber |
| wrong word | (incorrect) | full "again", overridable | — | yes | red |

- "penalty" = a **weighted near-miss**: `review_events.near_miss_weight`
  (0.2 / 0.3). Calibration counts it as `1 − weight` of a success; the
  scheduler dampens interval growth accordingly.
- **Retype is always required** for any non-exact answer (existing retype flow).
- **In all cases the slip is logged** to `typing_error_marks` by category.
- Multiple categories at once → treat as one near-miss (strict if *any*
  applicable category is strict).

## Decisions (locked with user)

1. Penalties when strict: accents 20%, articles 20%, **spelling 30%**. Lenient
   = 0% for all three. Always retype.
2. Typo↔wrong-word threshold: reuse the engine's existing typo threshold.
3. Settings stored on `user_scheduler_params` (canonical: the `forward_typed`
   row), read from there regardless of track.
4. Tracks: no merge work — the existing "Enable review tracks" checkboxes
   already toggle `forward_typed / forward_recall / reverse_recall`. User
   disables self-graded recall themselves.

## What's implemented (this session)

- **domain/index.ts**: `TypedErrorCategory`, `TypedStrictness`,
  `DEFAULT_TYPED_STRICTNESS`, `TYPED_PENALTY_WEIGHTS`, `TypedPenalty`;
  `SchedulerParams.strict{Spelling,Accents,Articles}` (+ defaults true);
  `ReviewEvent.nearMissWeight` + `ReviewEvent.errorCategory`.
- **engine/grading.ts**: `resolveTypedPenalty(result, strictness)` +
  `issueTypeToCategory()`.
- **migration 066_typed_grading_categories.sql**: strict_* columns on
  `user_scheduler_params`; `near_miss_weight` REAL + `error_category` on
  `review_events` (backfills weight 0.2 from old `near_miss=true`);
  `typing_error_marks` table + RLS + `record_typing_error_mark()` RPC.
- **repos**: `userSchedulerParams` (reads strict_*), `reviewEvents` (reads/
  writes near_miss_weight + error_category), `interfaces.ts`
  (`CreateReviewEventInput` gains `nearMissWeight` / `errorCategory`),
  new **`lib/data/typingErrorMarks.ts`** (`SupabaseTypingErrorMarkRepository`,
  direct-import like cardConfusions).
- **app/api/calibrate/route.ts**: retention + grad-bucket + accel calibration
  now weight near-misses by `near_miss_weight` (0.2/0.3) instead of a flat 0.2.
- **app/library/page.tsx** (pair settings modal): three Strict/Lenient toggles
  (Spelling/Accents/Articles) saved to the forward_typed row; per-track
  **"Reset calibration"** button (un-pollutes a track — used to fix the
  reverse-recall calibration corrupted by the old miscategorization bug).

## Remaining wiring (next step)

1. **`components/session/TypingMode.tsx`**
   - New prop `strictness: TypedStrictness` (default `DEFAULT_TYPED_STRICTNESS`).
   - After grading, compute `resolveTypedPenalty(result, strictness)`.
   - An **accepted** slip (weight < 1) must advance as a *correct* rating with
     the near-miss weight — NOT the current `onRate('again')` from
     `advanceRetype()`. Still require retype. Colour green (lenient) / amber
     (strict) with a category message ("Accent — retype it").
   - Replace `onNearMiss(boolean)` with `onTypedPenalty(weight, category)` (or
     extend it) so the session gets the weight + loggable category.
2. **3 session pages** (`study/[deckId]`, `study/all`, `study/folder/[folderId]`)
   - Load the pair's `strictness` from `user_scheduler_params` (forward_typed
     row) and pass to each `TypingMode`.
   - In `handleAnswer`, stamp `nearMissWeight` + `errorCategory` on the review
     event; fire-and-forget `SupabaseTypingErrorMarkRepository.record(...)`
     when a category is present.
3. **Grading input**: pass a `GradingSettings` with `ignoreAccents` /
   `ignoreDefiniteArticles` / `ignoreMinorTypos` = false into the typed-
   production grade call so slips surface as `'almost'`.

## Explicitly future (not now)

- **Spelling practice mode** — reads `typing_error_marks` where
  `category='spelling'`.
- **Gender/article assign mode** — reads `category='article'`.

## Error log

- (none yet)
