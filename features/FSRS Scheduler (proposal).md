# FSRS-style Due Now scheduler — PROPOSAL (draft, near-final)

> Status: **discussion complete, ready to spec into stages.** Adapts FSRS
> (difficulty / stability / retrievability) to Lexify while keeping interval
> ranges, the language-learning focus, varied mess-up penalties, and per-pair
> per-direction calibration. Plain-language.

## The idea

Replace the fixed rating multipliers (Hard ×1.2 / Good ×2.25 / Easy ×3.5) with a
proper memory model. Every graduated card carries two numbers:
- **Stability (S)** — how many days until your recall of *this* card falls to the
  retention target. (Essentially "the interval, as a memory property.")
- **Difficulty (D, 1–10)** — how hard this card is for you.

and a third is derived each time: **Retrievability (R)** — your predicted chance
of recalling it right now.

## Scheduling: interval from stability + a retention target

- **Retrievability** decays as `R = 0.90 ^ (days_since_review / S)`. When
  `days = S`, R = 90%.
- The **next interval** is the stability scaled to hit your chosen retention:
  higher target → shorter intervals (you review sooner), lower target → longer.
  (At 90% the interval ≈ S; at 80% ≈ 2×S; at 95% ≈ ½×S.)
- **Ranges stay.** The computed interval is fuzzed into a small min/max window and
  the existing density smoother picks the **least-busy day** — so cards don't pile
  up. *(Unchanged from today.)*

## Difficulty — cumulative, persistent

- Scale **1–10**, base **5**. Applied **cumulatively** on every rating (in learning
  *and* Due Now), then clamped.

| Rating / event | Δ difficulty |
|---|---|
| **Again** (or a mess-up graded as Again) | **+2.0** |
| **Hard** | +0.6 |
| **Good** | 0 |
| **Easy** | **−2.0** |

- **No auto-recovery on Good** (conscious choice): a hard card stays hard until an
  Easy pulls it back — this is the "slower growth so I stop re-failing" behavior.
- **Initialized at graduation** from the whole learning history: base 5 + the
  cumulative deltas of every self-rating on the ladder + every typed mess-up
  (each mess-up counts as an Again). So `again, hard, good, good` on the ladder →
  graduates around D ≈ 7.6; a clean `good, good` ≈ 5; an `easy` first-try dips low.

## Stability — grows on success, drops on lapse

Uses the **FSRS growth shape with its published default weights** (we don't train
the 19-weight optimizer — see Calibration). Difficulty is our custom number; it
feeds this formula as an input.

- **On a success (Hard / Good / Easy):** stability multiplies up. The increase is
  **bigger when difficulty is low**, **smaller as the interval already grows**
  (diminishing returns), and **bigger when you reviewed late** (R was low — you
  nearly forgot). **Hard** gets a penalty factor, **Good** the baseline, **Easy** a
  bonus — so **Easy always beats two Goods in a row automatically** (no special case).
- **On a lapse (Again):** stability is **reduced** based on difficulty and the prior
  stability (harder / longer cards fall further, but never to zero) — committed only
  once the relearn gate below is passed.
- **Initialized at graduation** from the graduating grade (Again small … Easy large).

## The relearn gate (Due Now) — must recover to advance

A mess-up doesn't let a card escape to a long interval on a limp "Hard."

- Triggered by an **Again** (or a slip graded as Again).
- **Loop timers:** Again → **5 min**, Hard → **10 min**, Good (first) → **20 min**.
- **Escape only on:** a **second Good in a row**, or a single **Easy** (which gives a
  better interval than two Goods, automatically).
- **Hard** keeps you in the loop, raises difficulty, and **never** resets you to the
  ladder.
- **Three Agains in a row → back to the learning ladder** (rung 0, un-graduated).
- A **Hard on a *clean* due card** (recalled with effort, no mess-up that session)
  advances normally — just with slower growth and difficulty updated. The gate is
  only for after a mess-up.

## Mess-up types → grade (varied penalties, via the strictness slider)

- **Wrong word → Again.**
- A **slip** (accent / article / typo), controlled by the per-category strictness
  slider: **strict → Again**, **middle → Hard**, **lenient → ignored** (graded
  purely by your rating).
- **Typed Due Now cards are rated** — type → check → then tap Again/Hard/Good/Easy,
  exactly as the current Due Now typed flow. (This is what lets typed cards produce
  the full four grades, including Easy.)

## Retention target — a per-language slider

- In each language's settings (gear icon): a **desired-retention slider, 80%–95%,
  default 90%.** Higher = shorter intervals / more reviews / better recall.

## Calibration — the happy medium (no heavy optimizer)

- Use **FSRS's published default weights** for the model shape.
- Keep **your per-language, per-direction calibration** tuning just **1–2
  interpretable knobs** per segment (the **retention target** and a **growth
  coefficient**), nightly, toward the retention band.
- **No full 19-weight per-user optimizer** — deferred (it needs thousands of
  reviews and a training pipeline).

## Graduation hand-off — unified

The ladder's interval-setting rung no longer assigns a first *interval* from the
old table. It assigns an initial **Stability** (from the graduation grade) and
**Difficulty** (from the cumulative learning history above). One model everywhere.

## Migrating your ~1,100 existing graduated cards

- **Stability ← each card's current interval** (it was already scheduled near 90%
  retention, so that's a good estimate).
- **Difficulty ← 5 + 0.7 × (past lapses), capped at 10** — so historically
  troublesome cards start appropriately hard. (Explicitly *not* "start neutral and
  converge.")

## Data-model changes (for the build)
- Add **difficulty** + **stability** to each card's review state (replacing the
  dormant "ease" number).
- Add a **desired-retention** setting per language pair.
- A migration to seed D/S for existing graduated cards as above.

## Suggested build stages
1. **Model + math** (pure, tested): difficulty/stability/retrievability update,
   interval-from-retention, post-lapse stability, difficulty deltas. No UI.
2. **Wire into Due Now**: the relearn gate + timers, typed→rate grading,
   mess-up→grade mapping, ranges/density kept.
3. **Graduation hand-off + migration** of existing cards.
4. **Retention slider** in language settings + calibration of the 1–2 knobs.

## Open (small)
- Confirm the exact **default weights** to seed (FSRS-5 vs FSRS-4.5) — I'll pick a
  well-tested set unless you have a preference.
- Whether the **growth coefficient** is the thing calibration nudges, or the
  retention target itself, or both.
