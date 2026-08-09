# Goal Scheduler

**Status (2026-08-08): complete and wired.** Data model, engine, calendar editor, its own settings
page, and all four goal consumers read it. Migration **114 is applied**.
**Never verified against a real account** (§7).

A schedule answers the opposite question to a daily goal. `language_pairs.goals` says *"I want to do
8 words a day"*; a schedule says *"I want 200 words by December 1st"* and works the daily number out
for you, every morning, from what's left.

---

## 1. The one rule everything falls out of

> **Today's goal is RE-DERIVED from (words still to go ÷ capacity still available). It is never
> stored and never accumulated.**

100 words in 20 days is 5/day. Miss a day and the words left don't change while the days left do — so
it becomes 100 in 19, i.e. 6/day. **That is the entire make-up mechanism.** There is no debt ledger,
no carried shortfall, no spike.

This is the same statelessness `lib/goalCarryover.ts` depends on and for the same reason: a number
recomputed from history can never drift out of step with it. The 2.5× cap in the carryover system
only works because `plannedGoalSum` is derived; a schedule's ceiling only works because the daily
number is derived. **Do not "optimise" either into a stored running total.**

### Why re-spread rather than debt

Both were on the table (the user chose re-spread explicitly, 2026-08-08). Debt-style — keep the
number at 5 and drop yesterday's 5 on top of today — is spikier and makes a bad week compound into a
wall you then need a cap to escape. Re-spreading distributes the miss across every remaining day, so
falling behind raises the daily number by a fraction rather than doubling it, and the schedule
degrades gracefully right up to the point where it genuinely can't fit.

---

## 2. What supersedes what

**A live schedule OWNS that pair's goal.** While `goal_schedules` has a non-archived row for a pair:

- its `language_pairs.goals` weekday numbers are not used (they stay stored, and come straight back
  when the schedule is retired);
- **the carryover settings do not apply to it** — not the two yesterday toggles, not full debt.

That last point is not a nicety, it's a correctness requirement. The re-derived goal has **already
absorbed** the missed day; running full debt on top would charge for the same miss a second time.
This is the same relationship full debt already has to the two yesterday-only toggles — one mode at a
time, most specific wins. The Settings panel says so explicitly when any pair is scheduled.

---

## 3. The model

### Capacity — how much a day can hold

`dayCapacity(schedule, date)`, most specific first:

| # | Source | Notes |
|---|---|---|
| 1 | `dateExceptions[date]` | Wins **outright, including over the ceiling** — that's how "free Saturday, I'll do 30" works as well as "away on the 12th" (0) |
| 2 | `weekdayLimits[weekday]` | Clamped by the ceiling. **0 = a day off** |
| 3 | `dailyCeiling` | `null` → `Infinity` |

Dates outside `[startDate, deadline]` are always 0 — a schedule can't demand back-work or overtime.

`Infinity` is deliberate for "no ceiling set". Defaulting to 0 would read as "I can do nothing" and
make every fresh schedule look impossible.

### Spreading — water-filling, not proportional

`waterFill(remaining, caps)` splits the work as evenly as possible, then pins any day that can't
absorb an even share at its cap and redistributes the overflow across the days that still have room,
cascading until stable.

**The alternative that looks equivalent and isn't:** `remaining × cap(d) / Σcap`. That treats a limit
as a *weight*, so a Friday capped at 3 gets 3/43 of the total even when the even split is only 2. A
limit is a ceiling on a day, not a claim on a share of the work. There's a test named after this.

### Checkpoints — the tightest segment wins

`activeSegments` = every checkpoint dated today or later, plus the deadline itself. Each is its own
window with its own `remaining` and its own water-fill, and **today's number is the largest demand
among them** — you have to satisfy the soonest binding target as well as the eventual one.

Checkpoint counts are **CUMULATIVE**, which is what makes a missed checkpoint self-correcting: it
simply drops out of the active list on the day after, and its words are still inside the next
window's `remaining`. Nothing is forgiven and nothing needs to be tracked.

Checkpoints outside the schedule, or above the final target, are ignored by `activeSegments` and
reported by `validateSchedule` — flagged rather than silently obeyed.

### Feasibility — the point of the ceiling

A ceiling that merely clamped the number would quietly miss the deadline. Instead `waterFill` reports
a `shortfall` for whatever couldn't be placed, and `scheduleRemedies` names the three levers a
learner actually has:

| Remedy | How it's computed |
|---|---|
| **Raise the ceiling** to N/day | **Binary search**, not division — `weekdayLimits`/`dateExceptions` also cap each day, so raising the global ceiling past a Friday limit of 3 buys nothing on Fridays and the answer isn't `remaining / daysLeft` |
| **Reduce the target** to N | `doneSoFar + reachable capacity` |
| **Move the deadline** to D | Walk forward accumulating capacity until it covers `remaining`; null past a year |

`minimumCeiling` is **null when no ceiling helps** — i.e. the per-day limits or days off are what
bind. The editor says that in words rather than showing a button that would do nothing.

### Pace

`schedulePace` = `doneSoFar − expectedByNow`, where "expected" walks the target in proportion to
**capacity consumed, not calendar days** — so a scheduled weekend off doesn't read as falling behind.

**Today counts on both sides**, matching `goalStanding` in `lib/goalCarryover.ts`: the measure opens
each morning down by today's share and climbs back to level as you study, rather than sitting at a
flattering number all day and lurching at turnover.

With no ceiling every day's capacity is `Infinity`, which carries no information about how the work
divides, so the measure falls back to weighting each eligible day equally. Without that fallback the
whole thing is `Infinity/Infinity` and an uncapped schedule could never report being behind.

### What counts toward the target

| Kind | Measures | Auto-graduated (onboarded / fast-tracked) |
|---|---|---|
| `new_words` | Words learned through the ladder **during** the schedule | **Excluded** — same rule daily goals already apply |
| `total_words` | The pair's whole graduated vocabulary | **Included** — it measures what you know, not how hard you worked |

So onboarding 500 known words moves a `total_words` target by +500 and a `new_words` target by 0.
(User's explicit call, 2026-08-08.)

`baselineCount` is the **one** stored number, and it's a snapshot rather than a counter: the value
the measure had the day the schedule was created (0 for `new_words`, the vocabulary size for
`total_words`). It gives progress a floor to measure from. An existing `total_words` schedule keeps
its stored snapshot — re-reading it live would silently move the finish line.

---

## 4. Files

| File | What it owns |
|---|---|
| `lib/goalSchedule.ts` | **Pure, 52 tests.** All of §3. No React, no Supabase |
| `lib/data/goalSchedules.ts` | The repo + `scheduleProgress` / `currentVocabularySize`. Online only |
| `components/settings/GoalScheduleEditor.tsx` | The editor, its live preview and feasibility remedies |
| `components/settings/GoalScheduleCalendar.tsx` | The calendar: drag-select days, time off, per-date caps, checkpoints |
| `app/settings/goals/page.tsx` | **The whole Daily Goals page** — fixed goals, schedules, carryover |
| `domain/index.ts` | `GoalSchedule`, `GoalScheduleCheckpoint`, `GoalTargetKind` |
| `supabase/migrations/archive/114_goal_schedules.sql` | Applied 2026-08-08 |
| `lib/data/goalSchedules.ts` | Repo + `scheduleProgress` / `progressForSchedules` / `currentVocabularySize` |

**Entry point:** Settings → Language configuration → **Daily goals** → per language, the **Schedule**
tab. Daily Goals moved off the settings page into `/settings/goals` on 2026-08-08 (same pattern as
`/settings/ladders`) — a goal stopped being a number in a box, and a schedule needs the room.
Slotting Schedule into the existing Daily / Per weekday toggle is what makes "this replaces your
weekday goals" legible without a paragraph of explanation.

### The calendar

Dates are edited on a calendar, not in rows of date inputs: "I'm away that week" and "be at 120 by
here" are statements about particular days, and a grid is how you pick days.

- **Drag across days** → mark time off, cap them at N, or clear the overrides.
- **Click one day** → the same, plus hang a checkpoint on it.
- Each cell shows the words planned for that day. **Past days render from `plannedForDate`**, future
  days from the live plan — see the note in §3 about why those are different functions.
- The calendar EDITS `dateExceptions`/`checkpoints`, it does not own them: it renders the parent's
  draft and calls back, so the preview and feasibility check stay the single source of truth.
- The draft keys both by DATE (`Record<string, number>`), so a day can't get two conflicting entries.
- The drag release is bound to `window`, not the cells — a pointerup off-grid would otherwise leave
  the calendar stuck mid-drag.
- The weekday-limit row stays for the recurring case ("every weekend off"); the calendar is for
  one-offs. Precedence is documented in §3: a date exception beats the weekday limit AND the ceiling.

The editor **does not block an over-ambitious schedule.** Wanting 500 words in a fortnight is a
legitimate thing to type; the honest response is to show that it doesn't fit and offer the three
levers, not to refuse the input. Only *incoherent* schedules are hard errors — deadline before start,
checkpoint above the final target, checkpoint counts going backwards, every day set to 0.

`MAX_SCHEDULE_DAYS = 1830` (~5 years) bounds `eachDate`. Purely a guard: a mistyped year would
otherwise turn every keystroke's preview into a multi-million-iteration loop and freeze Settings.

---

## 5. How it reaches the goal surfaces

All four consumers branch on "does this pair have a live schedule" and, if so, ignore carryover
entirely. The branch is deliberately 3–8 lines in each — the seam already existed, because
`plannedGoalSum`/`owedGoalForDate` take a per-DATE `goalForDay(dateStr)` function (the 2026-07-25
deferrals change), so a schedule is just another source of that number.

| Surface | What it does |
|---|---|
| `app/study/page.tsx` | `pairsWithGoalsToday` returns `scheduleStatus(...).goal`. Scheduled pairs bypass the "no weekday assignment → not on the list" gate (their goal doesn't come from `goals[weekday]`) and drop off when the goal is 0 — a scheduled day off, or the target already met |
| `components/analytics/PresentSnapshot.tsx` | Same in the goals loop. **"Current standing" now shows scheduled pairs too, in every mode** — it reports `status.pace` rather than the full-debt balance, since a schedule always has a cumulative position |
| `components/analytics/ReviewCalendar.tsx` | Uses **`plannedForDate`**, NOT `scheduleStatus` — see §3 |
| `components/ladder/LadderStudy.tsx` | The stop-at-goal intake cap reads the schedule's number. Nothing else touches new-card serving: a goal is a target, not permission to be served more cards |

**`progressForSchedules`** (in the repo) is the shared loader: ONE paged read covers every
`new_words` schedule (a single window from the earliest start date, bucketed per pair) plus a cheap
head-count per `total_words` schedule. Per-pair would have been an N+1 on the dashboard's critical
path. It is deliberately **not** memoised through `readCache` — the answer must change the moment you
graduate a card.

Every schedule read is wrapped so a missing `goal_schedules` table (migration 114 unapplied) falls
through to the old carryover behaviour instead of blanking a page.

**The "→ tomorrow" defer button is hidden for scheduled pairs.** Deferring is what a schedule already
does: skip today and the remaining days absorb it. `goal_deferrals` only feeds `owedGoalForDate`, so
the button would have been a no-op.

### Still unbuilt

- A **checkpoint progress panel** on Analytics → Present (segments, per-segment feasibility). Today
  only the binding checkpoint surfaces, via the editor preview and the goals list.
- `listArchived` is written but nothing surfaces a **"past schedules" history**.
- **Offline**: none. The editor and both progress readers are online-only.
- A schedule spanning multiple decks of one pair is fine, but there is **no cross-language schedule**
  ("300 words across all my languages") — targets are per pair.

## 6. Error log

*(Nothing user-facing yet — the feature has not run against a real account. Entries below are bugs
caught during the build, kept because they're easy to reintroduce.)*

1. **`schedulePace` returned 0 forever on an uncapped schedule.** With no ceiling, every day's
   capacity is `Infinity`, so the capacity fraction was `Infinity/Infinity` → `NaN`, and the
   `isFinite` guard then short-circuited to 0. Fixed by falling back to equal per-day weights when
   the total is infinite. Any future measure built on `capacityWindow(...).total` needs the same
   fallback.
2. **The Settings `onChanged` callback toggled instead of setting.** It flipped the pair in and out
   of `scheduledPairs`, so saving a schedule twice removed it from the "these languages are on a
   schedule" note. The editor now reports the resulting state (`onChanged(hasSchedule)`) rather than
   the parent guessing. Applies to any "did this change" callback: report the state, not the event.
3. **Drag-select did nothing on touch.** Touch and pen pointers are IMPLICITLY captured by the
   element that received `pointerdown`, so `pointerenter` never fired on any other cell and a drag on
   a phone selected only the day it started on. Fixed with `releasePointerCapture` for non-mouse
   pointers. The release is also handled on `window`, not the cell, so a drag ending off-grid still
   commits instead of silently vanishing.
4. **The calendar was O(n²).** It called `plannedForDate` per past cell, and that function re-runs the
   whole water-fill for the entire span every time — fine for 30 days, a visible freeze on a
   multi-year schedule, on every keystroke. `assignedPlan(schedule)` now computes the map once;
   `plannedForDate` delegates to it. **Anything rendering many dates must use `assignedPlan`.**
5. **Rounding could push a day past a limit the user set explicitly.** `distributeIntegers` hands the
   largest-remainder deficit to the biggest fractional parts; without the cap check it would add a
   word to a day already at its ceiling. It now skips capped days.

---

## 7. Verification status

- `lib/goalSchedule.ts`: **55 unit tests, all green.** The whole model in §3 is covered, including
  the re-spread behaviour, the water-fill-vs-proportional distinction, checkpoint binding, missed
  checkpoints, all three remedies, and the day-off pace property.
- The calendar's date maths: **9 tests** (`lib/__tests__/goalScheduleCalendar.test.ts`) — month
  lengths, leap-year February, the year boundary, Monday-start padding. Hand-rolled calendars break
  exactly there, and none of it is visible in a screenshot of the current month.
- `npm run build` + `npm test` green (51 suites / 795 tests), `tsc --noEmit` clean.
- **NOT verified against a real account — nothing here has ever been clicked.** The editor is behind
  `AuthWall`, so it could not be exercised here. Unexercised: the save/update/retire round-trip, drag
  selection on a real pointer/touch device, both progress queries, the live preview against real
  graduation data, and every one of the four consumer branches in §5.
