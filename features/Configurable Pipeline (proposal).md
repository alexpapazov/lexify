# Configurable Learning Pipeline — PROPOSAL (draft, near-final)

> Status: **discussion only — nothing built.** Plain-language spec. Round-2
> answers folded in; a few small confirmations left.

## The big idea

You build your own **ladder** of exercises. A card climbs it in order; once it
clears the top, it graduates into long-term review. One rung or many.

## Where you build it  *(decided)*

- **Per language pair.** One ladder for all decks in that pair.
- **A global default ladder** in main settings seeds every newly added language.
  Editing a language's own ladder detaches it from the default permanently.

## The catalog of rung types (four for now)

1. **Multiple choice** — pick from options. Distractors **smart** (AI) or
   **simple** (deck cards). Recognition; auto-checked.
2. **Typing** — type the answer. Auto-checked (with strictness); can also be
   self-rated (type → if right, rate; if wrong, auto-Again).
3. **Self-graded** *(new)* — just **reveal the answer and rate yourself**
   (Again / Hard / Good / Easy). No typing, no options, no auto-check — the rating
   is the whole outcome.
4. **Dictation** *(new)* — hear target audio, type it in the target language. If a
   card has no audio yet, **auto-generate it** (audio pipeline being fixed
   separately).

## What you configure on each rung

### a) Direction
Which side is shown vs. produced. Dictation is always *hear target → type target*.

### b) Automatic check + optional self-rating  *(decided)*
Every rung auto-checks the answer. A rung may *also* enable **self-rating**:
answer → if right, you rate **Again/Hard/Good/Easy**; if wrong, it's auto-**Again**
(overridable).

### c) Outcomes → what happens  *(decided)*
Each rung has a little rules table. For each way an attempt can land, you say what
it does:
- **Counts toward passing**, **just try again**, or **drop back to a specific
  earlier rung.**
- Outcomes available depend on the rung: a clean pass / an **"almost"** / a clear
  **miss** (typed & dictation); right / wrong (MCQ); or the four buttons (self-rated).
- Example: on rung 5, an *almost* → back to rung 4; a *miss* → back to rung 2.
- These drop-back rules apply to **self-rated rungs too** — e.g. an *Again* (or a
  rating happening a certain number of times) can send the card back to a chosen rung.

### d) Pass requirement
To leave a rung:
- **Auto-check rung:** a set number of clean passes **in a row**, or **total**.
- **Self-rating rung:** a rating you choose (e.g. "one **Easy**", "**Good** twice
  in a row"). Between tries the card returns on the short timers (see below).

### e) Strictness & consequences (typing & dictation)
Strictness levels that decide whether a slip reads as a clean pass / an "almost" /
a miss (which then feed the rung's outcome rules above). Likely reuses the
spelling / accents / articles three-way setting we just built.

## Graduation & the initial interval  *(decided)*

A word makes **two** review cards — **produce-target** and **produce-native** —
each with its own due date, graduating **independently**.

- **"Self-graded interval initialization"** flag: place **one per direction, at
  the end.** **Both must be finished for the word to graduate**, and each one's
  final rating sets **its own** direction's starting interval (via the table below).
- **An interval-setting rung must be a Typing rung or a Self-graded rung** — never
  Multiple choice, never Dictation. (Both of the allowed kinds end in a self-rating,
  which is what sets the interval.)
- If you *don't* use it, the card graduates with a **flat 1-day** interval for
  round 1. *(Deferred: a fully customizable "how graduation intervals are chosen"
  rule — by misses, ratings, etc. I'll circle back to design it once the pipeline
  works.)*

## The 12-hour completion window  *(decided)*

The **entire** climb must finish within **12 hours**, measured **from the moment
the card cleared its first rung** (one fixed deadline — clearing later rungs does
NOT extend it). If the window lapses before the word graduates, it **resets to the
very first rung**.

## Editing the ladder while cards are mid-climb  *(decided)*

- A rung added **after** a card's current spot → the card stays put.
- A rung added **at or before** the current spot → the card drops to the rung
  **just before** the newly added one (so it meets the new rung next).
- **Removing** the rung a card is currently on → it moves to the **previous** rung.

## Self-grading timing (Anki-style) — used by interval-init rungs

A **"mess-up"** = **Again** or **Hard**.
- **Again** → under a minute. Resets Good streak.
- **Hard** → under 5 minutes, always. Resets Good streak.
- **Good** → first: under 10 min. **Twice in a row → graduate at 1 day** (exact).
- **Easy** → graduate now, interval by history this sitting:

| Before Easy | Interval |
|---|---|
| Easy first try | 3–4 days |
| `good, easy` (no earlier mess-ups) | 3–4 days |
| `again, good, easy` (mess-up, then Good) | 3 days |
| one mess-up right before (`hard, easy`) | 2–3 days |
| two+ mess-ups (`again, hard, easy`) | 2 days (floor) |

**Choosing the exact day in a range** (e.g. 3–4): assign the card to whichever day
in the range currently has the **fewest** cards due (load-balancing). "Good twice
→ 1 day" is exactly 1 day.

---

## Resolved
1. One ladder per language pair; global default seeds new languages. ✔
2. Auto-check + optional self-rating; wrong = auto-Again. ✔
3. Per-rung outcome→consequence rules (pass / retry / drop back to a chosen rung),
   configurable per outcome. ✔
4. Pass requirement per rung (count-based, or a chosen rating). ✔
5. Two directions graduate independently; both interval-init rungs required;
   default interval = 1 day for round 1. ✔
6. 12-hour whole-climb window; lapse → reset to first rung. ✔
7. Mid-climb edits: keep spot if added after; drop to before the insert if added
   at/before. ✔
8. Dictation auto-generates missing audio. ✔
9. Ranges assigned to the least-busy day; "Good twice" = exactly 1 day. ✔

## Rating buttons — where they appear  *(decided)*
All four rung types may show **Again / Hard / Good / Easy**:
- **Self-graded** — always (it's the whole point).
- **Typing** — optional (type → if right, rate; if wrong, auto-Again).
- **Multiple choice** & **Dictation** — optional, and **only to drive movement**
  through the ladder (e.g. an Again sends you back a rung). They can **never** be
  interval-setting rungs.

## Spec is complete. Deferred (design later, after round 1 works)
- A fully **customizable "how graduation intervals are chosen" rule** (by misses,
  ratings, etc.). Round 1 uses: interval-setting rungs → Anki table; otherwise flat 1 day.
- More rung types: fill-in-the-blank, matching, write-a-sentence, etc.

## Build plan (staged) — for sign-off

**Stage 1 — Storage + the ladder editor (no change to studying yet).**
A ladder = an ordered list of rungs for a language pair, each rung carrying all
its settings (type, direction, distractor source, strictness, self-rating on/off,
pass requirement, outcome→drop-back rules, interval-init flag). Plus a global
**default ladder** in main settings that seeds new languages; editing a language's
ladder detaches it. Includes a visual editor (add / remove / reorder / configure)
with validation (e.g. interval-init only on typing/self-graded, one per direction).

**Stage 2 — The climb engine (pure, well-tested).**
Tracks each card's spot: current rung, its progress counters, the climb-start time
(for the 12-hour window), and per-direction graduation. Given an attempt's outcome
it decides advance / retry / drop-back, enforces the 12-hour reset, applies the
ladder-edit migration rules, and — when both interval-init rungs are cleared —
graduates each direction with its own starting interval (Anki table, else flat 1
day), placed on the least-busy day in the range.

**Stage 3 — The four exercise screens + session wiring.**
Build/adapt Multiple choice, Typing, Self-graded (reveal + rate), Dictation (play
audio + type). Each produces an outcome the engine consumes; the study session
renders the current rung's exercise and follows the engine.

**Stage 4 — Migrate existing in-progress cards + roll out.**
Decide how cards currently climbing the old fixed ladder map into the new one
(snap to nearest rung vs. restart), and retire the old fixed pipeline.

*(Note: this is the biggest change we've made — it reworks the core learning loop.
Staging keeps each piece testable and reversible.)*
