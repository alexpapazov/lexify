# Goal Scheduler

**Status (2026-08-08): Pass 1 shipped — data model, engine, Settings editor. Pass 2 (wiring the
derived goal into the goal consumers) is NOT built; see "Remaining" at the bottom.**
Migration **114 is PENDING** — it must be run before the editor works at all.

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
| `components/settings/GoalScheduleEditor.tsx` | The editor and its live preview |
| `domain/index.ts` | `GoalSchedule`, `GoalScheduleCheckpoint`, `GoalTargetKind` |
| `supabase/migrations/114_goal_schedules.sql` | **PENDING** |
| `app/settings/page.tsx` | Third mode in the per-pair Daily/Per weekday toggle |

**Entry point:** Settings → Daily Goals → per language, the **Schedule** tab. Slotting it into the
existing mode toggle is what makes "this replaces your weekday goals" legible without a paragraph of
explanation.

The editor **does not block an over-ambitious schedule.** Wanting 500 words in a fortnight is a
legitimate thing to type; the honest response is to show that it doesn't fit and offer the three
levers, not to refuse the input. Only *incoherent* schedules are hard errors — deadline before start,
checkpoint above the final target, checkpoint counts going backwards, every day set to 0.

`MAX_SCHEDULE_DAYS = 1830` (~5 years) bounds `eachDate`. Purely a guard: a mistyped year would
otherwise turn every keystroke's preview into a multi-million-iteration loop and freeze Settings.

---

## 5. Remaining (Pass 2)

The derived goal is **not yet read by anything outside the editor.** All four goal consumers still
read `language_pairs.goals` + carryover, so a scheduled pair currently shows its old weekday number
everywhere except the Settings preview. To finish:

1. **`app/study/page.tsx`** — `pairsWithGoalsToday` should branch to `scheduleStatus` when the pair
   has a live schedule, instead of `carriedGoal`/`fullDebtGoal`.
2. **`components/analytics/PresentSnapshot.tsx`** — same branch, in both of its loops. Its "Current
   standing" panel has a natural schedule analogue in `status.pace`.
3. **`components/analytics/ReviewCalendar.tsx`** — past days should use **`plannedForDate`**, not
   `scheduleStatus`. A past day's goal is a historical record (the reasoning the calendar already
   applies to weekday goals); re-deriving it from today's remaining would rewrite history every time
   you study. `plannedForDate` exists for exactly this and is deliberately independent of progress.
4. **`components/ladder/LadderStudy.tsx`** — the stop-at-goal intake cap reads `goalToday`; feeding
   it the schedule's number makes the cap compose for free. **Nothing else should touch new-card
   serving** — per the standing rule, a goal is a target, not permission to be served more cards.
5. A **checkpoint progress panel** (segments, pace, feasibility) on Analytics → Present.

**The seam to use:** `plannedGoalSum` and `owedGoalForDate` already thread a **per-date**
`goalForDay(dateStr)` function through every consumer (the 2026-07-25 deferrals change). A schedule
is just another source of that function, so this should stay additive rather than becoming a rewrite.

Also unbuilt, in rough priority order: surfacing `listArchived` as a "past schedules" history; a
deferral (`goal_deferrals`) in schedule mode — it should mean "today is a day off", i.e. capacity 0
for that date, which redistributes for free; and offline support (there is none — the editor and
`scheduleProgress` are both online-only).

---

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
3. **Rounding could push a day past a limit the user set explicitly.** `distributeIntegers` hands the
   largest-remainder deficit to the biggest fractional parts; without the cap check it would add a
   word to a day already at its ceiling. It now skips capped days.

---

## 7. Verification status

- `lib/goalSchedule.ts`: **52 unit tests, all green.** The whole model in §3 is covered, including
  the re-spread behaviour, the water-fill-vs-proportional distinction, checkpoint binding, missed
  checkpoints, all three remedies, and the day-off pace property.
- `npm run build` + `npm test` green (50 suites / 783 tests).
- **NOT verified against a real account.** The editor is behind `AuthWall` and needs migration 114
  applied. Nothing has been clicked through: the save/update/retire round-trip, the progress queries,
  and the live preview against real graduation data are all unexercised.
