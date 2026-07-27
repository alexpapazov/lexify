# Lexify — session handoff (2026-07-25)

Read `CLAUDE.md` first (full project context + house rules). This file is the "what's live, what's
half-done, what to do next" summary for the incoming agent. Everything committed & pushed as of writing.

---

## 0. Ground rules (do not skip)

- **Never run `git commit` / `git push` yourself.** OUTPUT a commit block for the user to run. Exact shape
  (see [[feedback-lexify-commits]] in memory):
  ```
  cd "/Users/alexanderpapazov/Code/alex_creates/lexify"
  git add -A
  git commit -m "…"
  git push
  npm run build:cap && npx cap sync ios
  ```
  Use `git add -A` (not `git add .`). **No `!` in commit messages** (zsh history-expansion silently fails the
  commit — it has burned us). Quote any `[bracket]` route paths.
- **Migrations are applied by hand** in the Supabase SQL editor — tell the user, don't assume. Numbering is
  sequential; `001`–`104` are in `supabase/migrations/archive/` (all applied). **Next migration = `105`.** The
  top-level `supabase/migrations/` folder is empty right now.
- **User logs in with `alex_papazov@college.harvard.edu`** (not the gmail in the profile).
- Verify before committing nontrivial work: `npm run build` + `npm test` (currently **418 tests green**).

## 1. Repo state

- Clean working tree, everything pushed to `origin/main`.
- Web deploys on push (Vercel, lexify-flax.vercel.app). Native iOS app updates only when the user runs
  `build:cap && cap sync ios` AND rebuilds in Xcode — so a "did the fix land?" question is usually a
  deploy/rebuild question. The user studies on **both** desktop web and the iPhone PWA/native app.

## 2. Open threads / unfinished work (highest priority first)

1. **CardEditModal mobile scroll — NOT finished.** On iOS, opening the ℹ menu during study scrolls the page
   behind the modal instead of the modal, so the Save button at the bottom is unreachable. I started but did
   not complete this. The modal is `components/CardEditModal.tsx`; outer is
   `fixed inset-0 … flex items-center justify-center` and the panel is
   `panel … max-h-[90vh] overflow-y-auto` (~line 787-789), with Save/Cancel inside the scroll area (~line 1911).
   **Plan:** (a) lock body scroll while the modal is mounted (useEffect toggling `document.body.style.overflow`),
   (b) add `overscroll-contain` to the scroll container to stop scroll-chaining, (c) ideally restructure the panel
   into `flex flex-col` + inner `flex-1 overflow-y-auto` + a **sticky/non-scrolling footer** so Save is always
   reachable. Nothing was committed for this — start fresh.

2. **Scheduling "Stage B" (the learned/gradient-descent interval model) — designed, DEFERRED.** The user wants
   to eventually minimize reviews via a per-feature model, but we shipped only **Stage A (damping)** and agreed
   to see if that alone suffices before building B. Do NOT start B unless the user reopens it. If they do, the
   agreed design (from chat, not written down): keep FSRS D/S; add a per-language **residual multiplier** from a
   regularized logistic **recall-probability model** trained by **online SGD + hierarchical (partial-pooling)
   prior**; pick the interval that **minimizes predicted workload** (retention becomes an output, floored at
   **0.80**) rather than pinning a fixed target; roll out in **shadow mode** first (log would-be intervals,
   check calibration) then live with a tight clamp.

3. **Timezone hardening is incomplete.** The study dashboard now survives a not-yet-migrated profile column
   (falls back to a core-columns select). **PresentSnapshot and the LadderStudy stop-at-goal cap do NOT** — they
   select `goal_deferrals`/full-debt columns and will null-out (→ turnover 0, carryover off) if a future profile
   column is added before its migration runs. Consider applying the same fallback, or better: split profile
   reads into "core (always-present)" + "features (best-effort)". Low urgency now (104 is applied) but it's a
   recurring landmine.

## 3. Backlog carried from before (still open)

- **`#55`** Merge duplicate cards creates a new duplicate instead of reusing the existing card.
- **`#59`** Exact-duplicate cards can still get duplicated on save.
- **Performance (diagnosed 2026-07-20, mostly NOT fixed)** — see the "Performance findings" section in
  CLAUDE.md. Biggest wins remaining: Postgres GROUP BY RPCs for analytics charts; lazy-load off-screen charts;
  a short-TTL cross-navigation cache. (The per-deck N+1 was fixed for Study/Library/card-search only.)
- **On-device sync-back leg unverified** — offline study → reconnect → outbox drain has never been confirmed on
  a real device (the risky data-loss leg). Everything else offline/PWA is device-verified.
- **Learning Pathways**: engine + config + study + visual editor all built (Phases 0–3 + drag/canvas). NOT
  runtime-verified with a real multi-day study run; auto-layout can get messy on complex graphs (no
  draw-arrow-to-connect beyond the double-click-drag gesture). The app ships NO prebuilt pathways by design.
- **Ladder Stage 3** (task list #29, "strip pre-grad pipeline from session pages + delete engine pipeline") —
  long-standing, untouched.

## 4. Things that WILL trip you up

- **`getToday(tz, turnoverHour)` / `localDateWithTurnover(...)`** own "what day is it" everywhere. Both default
  to UTC in their signatures, but every CALLER must pass `timezone || deviceTimeZone()` (never `?? 'UTC'`) —
  that fallback bug caused the "resets at midnight" reports. If you add a new "today"-bucketing site, use the
  device-timezone fallback.
- **Adding a column to a profiles `SELECT` before its migration is applied breaks the whole query** (see #2/#3
  above). Ship the migration first, or the query nulls out and takes turnover/carryover down with it.
- **Three session pages are near-identical** (`app/study/{all,deck,folder}/session/page.tsx`) — a `handleAnswer`
  / queue fix almost always needs to land in all three. The ladder (`components/ladder/LadderStudy.tsx`) is a
  separate pre-graduation engine; Due Now logic lives in the session pages.
- **`FlashcardMode` + `TypingMode` are shared** by the session pages AND the ladder. When you add a Due-Now-only
  affordance (like the Almost button), gate it via a prop the ladder never passes — don't branch inside the
  component on graduated-ness alone.

## 5. Fast orientation

- Core SRS math: `engine/fsrs.ts` (D/S), `engine/dueNow.ts` (Due Now decisions + seed), `engine/ladderEngine.ts`
  + `engine/pathwayEngine.ts` (pre-grad), `engine/grading.ts` (typed answers).
- Goal logic: `lib/goalCarryover.ts` (carriedGoal / fullDebtGoal / plannedGoalSum / owedGoalForDate /
  fullDebtExemptionAdjustment / isAutoGraduated — all pure + tested in `lib/__tests__/goalCarryover.test.ts`).
- Dashboards that show goals: `app/study/page.tsx`, `components/analytics/PresentSnapshot.tsx`,
  `components/analytics/ReviewCalendar.tsx`, and the cap in `components/ladder/LadderStudy.tsx`.
- Calibration: `lib/retentionCalibration.ts` + `app/api/calibrate/route.ts`.

Good luck. The user iterates fast and values honest pushback over agreement — if a request has a cleaner design
or a hidden gotcha, say so before building.
