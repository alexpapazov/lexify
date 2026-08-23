# Catch Up

**Status: built 2026-08-22. Migration `121_catchup_plans.sql` — apply before deploying** (the study
dashboard and the all-session page both name `catchup_plans` in their `profiles` SELECT; both go
through `loadProfileRow` with a core-columns fallback, so an unapplied migration degrades to "no
plans" rather than blanking the page — but don't rely on that).

Pick a date you want to be level again by; the app works out how many reviews a day that costs, which
cards to serve, and in what order. Scoped per language, or per card type within a language, so you can
be aggressive about one and relaxed about another.

---

## 1. The one rule: only the target date is stored

`profiles.catchup_plans` is a JSONB map holding nothing but dates:

```json
{ "bg|en": { "targetDate": "2026-09-05" },
  "es|en:typing": { "targetDate": "2026-08-29" } }
```

Everything the feature displays or enforces — today's quota, how far behind you are, progress, which
cards — is **derived from the live backlog and recomputed each day**. This is the same rule as
full-debt goal carryover (`lib/goalCarryover.ts`) and it exists for the same reason: a stored "cards
remaining" counter goes stale the moment you overshoot, fall short, or a relearn lands, and the plan
then quietly lies. Recomputing self-corrects — overshoot today and tomorrow's number drops on its own.

**Do not add a progress counter, a "cards done" field, or a cached quota.** Every one of those
reintroduces the drift this design exists to avoid.

## 2. The quota

```
quota = dueToday + ceil(overdue / daysRemaining)
```

`catchUpQuota()` in `lib/catchUp.ts`. The split is shown to the user because the two halves mean
different things: `dueToday` is non-negotiable (skip it and the backlog grows), `overdue` is the debt
being drained.

The important property, unit-tested: this **trends downward** day to day and reaches exactly zero on
the target date. A naive `backlog / totalDays` climbs as new cards arrive, so the goal appears to run
away from you — that was the thing to avoid.

`daysRemaining` floors at 1. On the target date the quota becomes everything still owed; **past** the
target it holds there until the backlog actually clears. A plan never expires on a date — it ends when
the backlog does, then retires itself (see §6).

## 3. Ordering: deferral damage, and why it is not "most overdue first"

The cost of delaying a card is **not monotonic** in how forgotten it is. Since
`loss = R · (1 − 0.9^(d/S))`:

- **R ≈ 0.95, large S** — rock solid. Loses almost nothing by waiting.
- **R ≈ 0.7, small S** — about to slip. Loses a lot. *This is where a review does the most work.*
- **R ≈ 0.05** — already gone. Loses almost nothing more.

So the primary sort is projected recall lost over the remaining window, which peaks mid-band on its
own and leaves both extremes alone. "Most overdue first" is the intuitive choice and the wrong one: it
front-loads exactly the cards that have already been lost, which is the slowest, highest-lapse work.

### The lapsed stratum

Cards under `LAPSED_R = 0.30` are relearning, not reviewing. They are drained as a **separate
stratum** at their own steady rate — `ceil(lapsedPool / daysRemaining)`, the same derived formula one
level down — and capped at `MAX_LAPSED_SHARE = 0.25` of any session. Then `interleaveEvenly` spreads
them through the queue rather than concatenating them.

Both halves matter. Without the steady rate they pile up in the final days; without the cap a deep
backlog turns every session into a relearning slog; without the interleave they clump at one end.

**The cap can conflict with the deadline.** If the lapsed pool cannot drain at ≤25%/day within the
window, the cap wins and those cards finish after the target. That is surfaced *in the picker*
(`previewCatchUp().lapsedFinishesInDays`) at the moment the date is chosen — breaking the promise
quietly would be worse than pricing it honestly up front.

## 4. Scoping

Scope keys match the "Study all due" popover's own buckets, so the number a plan quotes matches the
row you clicked:

| Key | Covers |
|---|---|
| `bg|en` | the whole language |
| `bg|en:typing` | typed production only |
| `bg|en:sgForward` | self-graded, native → target |
| `bg|en:sgReverse` | self-graded, target → native |

`resolvePlan()` is **most-specific-wins**: a type key beats the language key, which covers whichever
types have no plan of their own.

## 5. Pieces

| Piece | Where |
|---|---|
| Quota, strata, interleave, preview | `lib/catchUp.ts` (pure, 32 tests) |
| Due rows → per-scope candidate pools | `lib/catchUpPools.ts` (11 tests) |
| Applying plans to a built session queue | `lib/catchUpSession.ts` (12 tests) |
| `overdue` vs `today` split, `daysOverdue` | `lib/dueStatus.ts` (`cardStateDueBucket`) |
| Measured review pace for the "~N min" | `lib/reviewPace.ts` (11 tests) |
| Panel + date picker | `components/study/CatchUpPanel.tsx` |
| Dashboard wiring, auto-retire | `app/study/page.tsx` |
| Session cap | `app/study/all/session/page.tsx` |
| Migration | `supabase/migrations/121_catchup_plans.sql` |

### `lib/reviewPace.ts` was extracted, not written

The recency-weighted, per-bucket review pace already existed inside
`components/analytics/PresentSnapshot.tsx`. It was lifted into `lib/` unchanged and PresentSnapshot now
imports it, so the "~N min/day" in the picker and the "~N min" on the Present tab cannot come from two
implementations of the same measurement.

The dashboard's own pace query is a **capped single request** (`limit(1000)`, newest first), not a
30-day window. 30 days of `review_events` is ~14k rows across several serial pages — precisely the
dashboard regression the 2026-07-27 perf pass removed. The 7-day recency half-life means the newest
reviews dominate anyway, so the tail would buy nothing.

## 6. Behaviour decisions (all made explicitly)

- **New cards are untouched.** Catch-up governs reviews only; daily goals stay independent. Same rule
  as goal carryover never touching the serving cap.
- **Past the target date, hold at the final quota.** Nothing stops serving on its own.
- **A plan retires itself** when its scope's `overdue` hits zero — a `useEffect` on the dashboard,
  guarded on a loaded page so an empty first render can't wipe every plan.
- **Only the all-session page is capped.** Deck and folder sessions are a deliberate narrow choice by
  the learner and are left alone; the work still counts, because tomorrow's quota is recomputed from
  the real backlog either way.
- **Due-ness comes from `lib/dueStatus.ts`, never the forecast.** Those two disagree by a handful of
  rows (1693 vs 1699 in the reported screenshot) and a quota that doesn't match the button reads as a
  bug. `cardStateDueBucket` is unit-tested to agree with `isCardStateDueNow` on every row.
- **Applied after the queue is built and deduped**, so an ungoverned scope is byte-identical to
  pre-catch-up behaviour. A governed scope skips the shuffle, because its order is the point.
- **`interleaveConfusablePairs` still runs afterwards** and may pull linked cards together, slightly
  perturbing the sprinkle. Accepted: confusion clustering is the stronger pedagogical signal and the
  sprinkle is approximate by nature.

## 7. Traps

- **`dueStatus.ts` now has one shared gate.** `activeDueDates()` backs `isCardStateDueNow`,
  `cardStateDueBucket` and `daysOverdue`. That file exists because five surfaces each had their own
  copy of this logic and drifted; don't add a fourth reader with its own version.
- **A forward and a reverse review of the same card are separate items** (`candidateKey` is
  `cardId:direction`). Collapsing them undercounts the backlog.
- **`applyCatchUpPlans` must never drop a card it cannot classify.** A `describe()` returning null, or
  a duplicate candidate key, passes the item through ungoverned — losing a due review silently would
  be far worse than serving one extra.
- **The inflow estimate in the picker excludes today.** Today's forecast bar *is* the backlog; counting
  it would inflate every estimate enormously.

## 8. Error log

*(nothing yet — first build)*
