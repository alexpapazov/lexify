# Learning Pathways — design proposal

> **Status: Phase 0 SHIPPED (engine only); Phases 1–3 not started.** The pure state-machine, validation,
> and ladder→pathway conversion exist and are tested; nothing is wired to the UI or DB yet. Living doc.
>
> **Phase 0 code:** `domain/index.ts` (Pathway/PathwayState/Transition/PathwayPredicate/… types),
> `engine/pathwayEngine.ts` (`stepPathway`, `initialRouteState`, `RouteState`, `PathwayEvent`),
> `lib/pathway.ts` (`validatePathway`, `ladderToPathway`). Tests: `engine/__tests__/pathwayEngine.test.ts`,
> `lib/__tests__/pathway.test.ts`.
>
> Two shapes were finalized differently than the early drafts below — both reflected in the code:
> - **`PathwayEvent = { outcome: RungOutcome|'pass'; errorTypes: ErrorType[] }`** (single raw outcome,
>   mirroring the ladder's `reviewRung(outcome)`), not `{ rating, correct }`. The `rating`/`correct`
>   predicates are *derived* from `outcome` in the evaluator.
> - **`stepPathway` returns `{ route, moved, graduated, reshowSeconds }`** — an explicit seconds delay
>   (from the transition's `waitSecondsOverride` or the global gap), not a `ReshowHint` enum.

## 1. The goal (why we're doing this)

The ladder marches every card through roughly the same linear sequence. That's inefficient at both ends:

- **Easy cards waste your time.** A word you clearly know still climbs 5–6 rungs.
- **Hard cards get too little targeted work.** A word you keep missing the article on gets the same
  generic "wrong → drop back" treatment as one you can't recall at all.

**Efficiency is achieved purely by ROUTING — not by any timing condition.** The thing we're reducing is the
*cumulative active time* you spend on a card (total seconds actively answering it, across all attempts),
but we get there by letting easy cards take *short routes*, never by checking a clock:

- **Very easy word:** an Easy rating / clean pass sends it down a 2-state express route → few active
  interactions → low cumulative active time. (Those two attempts are still spread over minutes by the
  between-state spacing, which stays.)
- **Standard word:** a few more states.
- **Genuinely hard word:** more active interactions are fine — but every one goes into the *right*
  corrective exercise (targeted by error type / streaks), not a generic redo.

So there are **no response-time or "answered in < N seconds" conditions.** A card signals "easy" by being
rated Easy or passing cleanly; that alone routes it short. Cumulative active time is an **analytics/report**
metric (derived from the per-attempt event log we already keep), so you can *see* the efficiency — it is
not an input to routing or graduation. The between-state spacing (minutes) is untouched.

A **pathway** is a directed state graph: a card occupies one **state**, and each answer fires a
**transition** to another state based on rich conditions (rating, error type, streaks, history, timing).
Easy cards take a 2-state express route; hard cards route into targeted corrective states and loop only
where it helps.

This is opt-in **per language pair**. Ladders stay exactly as they are; a pair is either in *ladder mode*
or *pathway mode*.

## 2. Vocabulary (lock this first — everything downstream uses it)

| Term | Meaning |
|---|---|
| **Pathway** | The whole configured graph for a pair (the pathway-mode equivalent of a `Ladder`). |
| **State** | A node: what the learner is shown + how it's graded. Superset of today's `Rung`. |
| **Transition** | A directed edge: a condition + a destination state (+ priority, delay, counter resets). |
| **Route** | The actual sequence one card took through the pathway (today's `rungHistory`). |
| **Graduation** | Reaching the terminal — hands off to the FSRS Due-Now scheduler, as ladders do now. |

A card *follows a route through a pathway.*

## 3. Relationship to ladders (the load-bearing decision)

**Recommendation: pathways run *parallel* to ladders, sharing the presentation layer, not a rewrite of it.**

- Keep `learning_ladders` + `engine/ladderEngine.ts` + `LadderStudy` + the ladder editor **untouched**.
- A **State reuses a Rung's presentation fields verbatim** (`type` mcq/typing/self_graded/dictation,
  `direction`, `strictness`, `selfRated`, `intervalInit`). So `components/ladder/LadderStudyCard.tsx`
  renders a pathway state with **zero changes** — only the *traversal* differs (graph vs. `rungIndex+1`).
- What's genuinely new is the **transition engine** and the **graph** structure/editor.
- **A ladder is a linear pathway.** We provide `ladderToPathway(ladder)` so (a) switching a pair to
  pathway mode seeds it from the current ladder instead of a blank canvas, and (b) we can reuse the
  ladder's test cases as pathway test cases.

Why not unify under the hood and make ladders "just a linear pathway view"? Because you explicitly want
ladders kept as-is, and the ladder engine is battle-tested (drop-backs, skip-aheads, the 12-hour window,
graduation intervals, reshow timing). Parallel-with-shared-presentation gets the reuse without risking the
working system. (We can revisit unification later once pathways are proven.)

## 4. Data model (domain types)

New types in `domain/index.ts`, alongside `Ladder`/`Rung`:

```ts
interface Pathway {
  id: string
  startStateId: string              // where a new card enters
  states: PathwayState[]
  transitions: Transition[]
  betweenStateWaitSeconds: number   // GLOBAL spacing between states (the "4–6 min" default)
}

interface PathwayState {
  id: string
  name: string                      // "Initial Production", "Accent Retype", …
  // ── presentation: identical to Rung, so LadderStudyCard renders it unchanged ──
  type: RungType                    // mcq | typing | self_graded | dictation
  direction: RungDirection          // produce_target | produce_native
  distractorSource?: DistractorSource
  strictness?: TypedStrictness
  selfRated: boolean
  intervalInit: boolean             // sets THIS direction's graduation interval (≤1 per direction)
  // ── pathway-specific ──
  minReshowSeconds?: number         // min delay before this state can re-appear for the card
  isTerminal?: boolean              // graduation sink (no outgoing transitions; hands to FSRS)
}

interface Transition {
  id: string
  from: string                      // source state id ('*' = "from any state", for global rules — optional, phase 2)
  to: string                        // destination state id (or a terminal state)
  when: Condition                   // see §5
  priority: number                  // lower = evaluated first; first match wins
  resetCounters?: CounterName[]     // e.g. reset consecutive_again on entering the new state
  waitSecondsOverride?: number      // per-BRANCH spacing override — see below
}
```

**Between-state spacing = one global number, overridable per branch.** `Pathway.betweenStateWaitSeconds`
is the default gap before the next state appears (your "4–6 min"). A transition's optional
`waitSecondsOverride` replaces that gap *for the edge that was taken* — so a corrective branch (e.g.
state 2 → A → B → C) can run on a different cadence than the main 1 → 2 → 3 line by setting the override on
that branch's edges. (In the editor's simple view we can set it once for a whole branch; the underlying
store is per-edge, which is maximally flexible.)

`RungType`, `RungDirection`, `TypedStrictness`, `DistractorSource` are **reused as-is**.

### Per-card runtime state (`RouteState`)

Today's `ClimbState` already tracks most of what you listed. The pathway version generalizes
`rungIndex: number` → `stateId: string` and adds error-type + timing tracking:

```ts
interface RouteState {
  stateId: string
  stateEnteredAt: number | null
  attemptsInState: number
  consecutiveGood: number
  consecutiveAgain: number
  totalGood: number
  totalAgain: number
  lastRating: Rating | null
  lastErrorTypes: ErrorType[]        // NEW: ['accent'] | ['article'] | ['wrong_word'] | ['spelling'] | []
  history: string[]                  // stateIds visited, in order (= today's rungHistory, but ids)
  // graduation intervals accumulated en route (same as ClimbState today)
  targetInterval: IntervalRange | null
  nativeInterval: IntervalRange | null
  graduated: boolean
}
```

The counters (`consecutive*`, `total*`) are what let the graph distinguish `Good → Good` from
`Good → Again → Good` — your key point. `resetPerState` clears the per-state ones on entry (mirrors
today's `resetPerRung`).

## 5. The condition language (this is the heart of it)

A `Condition` is the trigger on a transition. To stay both simple and powerful, use **a flat list of
predicates AND-ed together** (condition *groups* / OR can come in advanced mode later):

```ts
type Condition = Predicate[]        // ALL must hold (AND)

type Predicate =
  | { kind: 'rating';      is: Rating }                        // easy | good | hard | again
  | { kind: 'correct';     is: boolean }                       // clean pass vs any miss
  | { kind: 'errorType';   is: ErrorType }                     // accent | article | spelling | wrong_word | meaning
  | { kind: 'counter';     name: CounterName; gte: number }    // consecutive_good ≥ 2, total_again ≥ 3, …
  | { kind: 'attemptsInState'; gte: number }
  // NOTE: intentionally no timing predicates. "Difficulty" is emergent — it reveals itself through the
  // counters (consecutive_again, total_again, error types), never a tag or a stopwatch.
```

**Everything a predicate needs is already produced by the session today:**
- `rating` — the Again/Hard/Good/Easy the learner pressed (self-rated) or the mapped auto-check outcome.
- `errorType` — `engine/grading.ts` already returns `issueType` (`spelling`/`accent`/`article`), and the
  confusion system (`engine/confusion.ts`) already detects a *different real word* (`wrong_word`).
(No timing inputs — see the note in the type above. Cumulative active time is still *logged* per attempt
via the existing `ladder_events.duration_ms`, so analytics can report "active time to graduate by
difficulty," but the pathway never routes on it.)

**Determinism:** transitions out of the current state are sorted by `priority` (then array order);
**the first whose `Condition` fully matches wins.** Explicit priority, not "cleverest match" — predictable
and debuggable. If none match, the card stays (re-show after the state's `minReshowSeconds`).

## 6. Engine (`engine/pathwayEngine.ts` — pure, tested)

One entry point, mirroring `reviewRung`:

```ts
stepPathway(pathway, route, event, now) → {
  route: RouteState          // updated (new stateId or same, counters bumped, intervals set)
  reshow: ReshowHint
  moved: boolean
  graduated: boolean
}

// event carries everything a Predicate can read (no timing):
type PathwayEvent = { rating: Rating; correct: boolean; errorTypes: ErrorType[] }
// (durationMs is still logged to ladder_events for analytics, but isn't part of routing.)
```

Flow inside `stepPathway`:
1. Bump counters on the current state from the event (consecutive/total good/again, attemptsInState,
   lastErrorTypes).
2. If the current state is `intervalInit`, compute this direction's interval from the rating (reuse the
   ladder's `easyInterval`/Good-twice logic) and stash into `route.targetInterval`/`nativeInterval`.
3. Evaluate outgoing transitions by priority; first match → move to `to` (reset per-state counters +
   any `resetCounters`, set `stateEnteredAt`, append to `history`).
4. If the destination `isTerminal` → `graduated: true`; fill any unset direction interval with the flat
   1-day default (exactly as `advance()` does at graduation today).
5. No match → stay; reshow per timing.

This means **`LadderStudy` needs only a thin adapter**: build the `PathwayEvent` from the same data it
already computes in `onOutcome`, call `stepPathway` instead of `reviewRung`, and read `route.stateId`
to pick the next card's presentation. Graduation, `reviewTimer`, reshow delays, undo — all reuse the
existing plumbing.

## 7. Storage & schema

- **`language_pairs.learning_mode`** `TEXT NOT NULL DEFAULT 'ladder'` (`'ladder' | 'pathway'`) — the
  per-pair toggle. (Same table that already holds `goals`/`flag`.) A per-user default mode can live on
  `profiles` later; start per-pair.
- **`learning_pathways`** table, mirroring `learning_ladders` exactly (per-pair + `''/''` default row),
  with a single `pathway jsonb` column. `SupabasePathwayRepository` copies `SupabaseLadderRepository`.
- **Card runtime:** reuse **`ladder_climb`** (its `state jsonb` already stores the whole `ClimbState`
  and survives graduation). `RouteState` is a superset shape; the mode flag tells the loader which
  interpreter to use. No new table, no migration for runtime state. (Alternative: a discriminated
  `kind` field inside the JSON. Decide in §12.)

## 8. Session integration & safeguards

`LadderStudy` (or a light `PathwayStudy` wrapper around the same component) branches on the pair's
`learning_mode`. The graph creates risks a line doesn't, so **session-level guardrails** (independent of
graph validity):

- **Max immediate repeats** — a card can't show more than *N* times in a row without another card between.
- **Min delay between repeats** — the between-state spacing (global `betweenStateWaitSeconds` or a
  transition's `waitSecondsOverride`), plus an optional per-state `minReshowSeconds` floor.
- **Temporary suspension** — after *K* failures in one sitting, park the card for the rest of the session
  (reappears next session) so a hard word can't monopolize a session.

These reuse the existing reshow-pool / relearn-pool machinery in `LadderStudy`.

## 9. Guardrails & validation (editor-time)

`validatePathway(pathway)` (pure, tested) — mirrors `validateLadder`, returns human-readable problems:

- **A start state exists**, and **graduation is reachable** from every non-terminal state (BFS). This is
  the loop-safety check: loops are *allowed* (relearning needs them) but a state from which you can never
  reach graduation is an error.
- **No dead ends** — every non-terminal state has ≥ 1 outgoing transition.
- **No unreachable states** — every state is reachable from the start (warning, not a hard error).
- **Interval-init is ≤ 1 per direction** (reuse the ladder rule) — and warn if a direction's interval
  state isn't on *every* route to graduation (then some routes graduate that direction at the 1-day
  default; this is allowed and sometimes intended).
- **Accidental shortcut** — flag (warn) any route to graduation traversable with only wrong/again events.
  Warn, don't block — you're hand-authoring and may want it.

Ambiguity is handled by design (priority + first-match), so it's not an error — but the editor should
*show* the resolved order.

## 10. Editor UX

**The app ships NO pre-built pathways and no template generator.** You build your own from scratch (or from
your existing ladder as a starting point — see below). There is one editor with two views that grow in
sophistication over the phases:

- **State editor** — literally the current per-rung editor, one state at a time (type/direction/
  strictness/rating controls/interval-setting). Already built; extract and reuse per state.
- **Transition editor (Phase 1, list-based)** — per state, a list of "When … → go to State X (priority),
  wait N min" rows, like today's drop-back/skip-ahead rows but with the richer `Condition`. Fully usable
  with no canvas — this is how you author a graph at first.
- **Pathway canvas (Phase 3)** — the visual editor you want:
  - **Circles = states**, **squares = graduation-interval-setting states** (`intervalInit`), so the
    interval-determining nodes are visually distinct at a glance.
  - **Arrows = transitions**, clickable to open the transition editor; the terminal (graduate) node
    styled distinctly.
  - **Hover a node → a popover with that state's full spec** (type, direction, strictness, rating
    controls, spacing, whether it sets the interval).
  - Large front-end effort → deferred until the model is proven via the list editor. (Start as an inline
    read-only SVG/`mermaid`-style render, then add drag-to-connect editing.)

**Starting point (not a template):** when you flip a pair to pathway mode, we seed the editor with
`ladderToPathway(<your current ladder>)` — a mechanical 1:1 conversion of the ladder *you already built*,
not a designed template. From there you rework it into whatever branchy graph you want. You can also start
from an empty pathway (just a start state + a graduate state) if you prefer a clean slate.

## 11. What the model can express (illustration only — NOT shipped)

Purely to sanity-check that the types in §4–§6 can represent a branchy, efficient graph — **this is not a
default and won't be created for you.** A pathway *can* encode routes like:

```
Initial Production ──Easy──▶ Delayed Confirmation ──Good/Easy──▶ GRADUATE      (easy: 2 interactions)
  │  (produce target)                              (interval-init)
  ├─Good──▶ Target Dictation ──Good/Easy──▶ Delayed Confirmation                (standard: 3–4)
  ├─Again──▶ Retype Correction ──pass──▶ Initial Production                     (targeted corrective)
  ├─accent error──▶ Accent Retype ──pass──▶ Initial Production
  └─wrong_word──▶ Intensive Production ──Good×2 in a row──▶ Target Dictation
```

Easy cards take a short route; error types fork to the specific corrective state; loops clear only when the
streak counters recover. **You** decide the actual states, forks, spacing, and where the interval-setting
state(s) sit — that's how you tune Spanish for max efficiency.

## 12. Open decisions

**Resolved:**
- ✅ **No timing conditions at all.** Efficiency comes from routing (rating/correctness), not the clock.
  Cumulative active time is analytics-only (from the existing event log).
- ✅ **Difficulty is emergent** — it surfaces through the counters (consecutive/total again, error types).
  No difficulty tags, no explicit difficulty input.
- ✅ **Editor: list-based first, visual canvas later** (circles=states, squares=interval-setters,
  arrows=transitions, hover=full state spec — §10).
- ✅ **Directions are per-route.** A pathway need not graduate both; a direction with no interval-setting
  state on the taken route graduates at the **1-day default** (same as the ladder fallback).
- ✅ **Spacing:** one global `betweenStateWaitSeconds`, overridable per branch via a transition's
  `waitSecondsOverride`.
- ✅ **No shipped pathways / no template generator.** You author your own. A pair entering pathway mode
  seeds from `ladderToPathway(<your ladder>)` (a mechanical conversion of what you already made) or an
  empty start→graduate skeleton.
- ✅ **Graduation intervals come only from interval-setting states you place.** If a route reaches the
  terminal without passing your interval-setting state for a direction, that direction graduates at the
  **flat 1-day default** — no special Easy handling. Want a longer starting interval on an express route?
  Put an interval-setting state on it. This keeps the rule simple *and* puts the control in your hands.

**Still open (all internal/technical — my call unless you object):**
1. **Storage of runtime state:** reuse `ladder_climb` (superset JSON, mode flag disambiguates) vs. a new
   `pathway_route` table. Leaning **reuse**.
2. **`from: '*'` global transitions** (e.g. "3 Agains anywhere → Intensive Production"): MVP or later?
   Leaning **phase 2** (complicates validation).
3. **Graduation representation:** an explicit terminal `isTerminal` state vs. a `to:'GRADUATE'` sentinel.
   Leaning **explicit terminal state** (cleaner reachability checks).

## 13. Suggested phasing (each phase shippable + tested)

- **Phase 0 — Model + engine. ✅ DONE.** `domain` types, `engine/pathwayEngine.ts`, `lib/pathway.ts`
  (`validatePathway` + `ladderToPathway`), 20 unit tests. No UI, no DB. Core de-risked.
- **Phase 1 — Run it. ✅ DONE (needs live testing).** `language_pairs.learning_mode` + `learning_pathways`
  table + repo (migration 099); the ladder settings page has a Ladder|Pathway toggle + list-based
  `PathwayEditor`; `LadderStudy` branches on mode (additive) and runs `stepPathway`, reusing
  `LadderStudyCard` + all the queue/graduate/undo plumbing. Seeded from your ladder or empty.
- **Phase 2 — Guardrails.** Full `validatePathway` in the editor + session safeguards (max repeats,
  suspension). Error-type transitions wired to `issueType`/confusion.
- **Phase 3 — Canvas.** Visual graph editor (circles/squares/arrows, hover specs).

---

*Next step: with §12 resolved, the remaining work is to lock the exact Phase 0 `domain` types +
`stepPathway` signature, then I can start Phase 0 code whenever you say go.*
