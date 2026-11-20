# Due Now Redesign — Card Directions & the Program Builder

**ROUNDS CONCLUDED 2026-11-20.** Decisions locked (red-pen round 1 + chat round 2):

- **Part 1 (BUILT 2026-11-20):** directions per pair, single vs multiple. Multiple→single
  **DELETES** recognition rows (no ghosting — confirm dialog with count; review events stay).
  Single→multiple seeds recognition from production with the first due **spread** within each
  card's interval window. One production **modality** per direction (typed/smart/self-graded),
  compiled to the track flags. Setting lives in the pair's SRS modal, replacing the four track
  checkboxes. Existing pairs keep the status quo. Reverse surfaces hide (not "0") when off.
  Reverse rows never regrow on single-direction pairs (ladder graduation, chip seeding, the
  maturity buttons are all gated). `lib/directions.ts` + `deleteReverseForCards`.
- **Part 2 (TO BUILD):** Due page = batches per pair × direction; each batch runs a PROGRAM
  (ordered stages: Matching / Cloze / Active recall / Typed recall). Misses replay in-stage.
  **Credit model (user's design, round 3):** stage clears accumulate during the turnover-aware
  day; at DAY TURNOVER each word is automatically finalized with the boost of its highest
  cleared stage (grow-only interval push — no rating, no reps). Clearing the FINAL stage
  credits IMMEDIATELY as the one real FSRS review (rating from that stage). A per-card /
  bulk **"lock in this interval now"** button cashes out the current stage's boost early
  (multi-stage programs only). Strengths: Matching 0.4 · Cloze 0.75 · Recall 1.0 (tunable).
  Stage-by-stage over the batch, chunked like matching; tiny batches fine (1-card batches
  skip matching). Mid-day resume via persisted per-word stage progress; finalization runs
  lazily on the next app open after turnover (no server cron). Matching-only over a
  production batch allowed ("light credit"). Presets per pair + last-used. Graduated cards
  only; story stays separate; old express/cloze deep links map onto presets.

The original round-1 draft follows for reference.

---

**Design draft, round 1 — 2026-11-20.** Two linked changes: (1) card directions become an
explicit per-language choice with honest conversion rules, and (2) the Due Now page becomes a
batch view where you build each day's review out of exercise stages. Nothing here is built.
Questions are numbered; each has my recommendation so you can just confirm or strike it.

---

## Part 1 — Card directions as a per-language choice

### Where things stand today (so we agree on the starting point)

- A card has up to two schedules ("rows"): a **forward** row — you see the native side and
  produce the target word (typed, smart-typing, or self-graded) — and a **reverse** row — you
  see the target word and recall the meaning (recognition).
- The per-pair settings already have "Enable review tracks" checkboxes that gate what comes
  due. Disabling a track **ghosts** its due cards: the schedule is untouched and re-enabling
  brings everything straight back. Nothing is ever deleted.
- So directions already exist — but as fixed plumbing (always at most forward + reverse),
  dressed up as track toggles.

### Proposed

Per language pair, one **Directions** setting:

- **Single direction** — a card is one schedule: native → target production. No recognition
  reviews exist for this pair.
- **Multiple directions** — an explicit checklist of directions, each with its own schedule
  that diverges through your reviews. For two-sided cards the list is exactly:
  native → target (production) and target → native (recognition).

**Future-proofing for Chinese (NOT built now, but the design must not block it):** a direction
is an ordered pair of card **fields**. Today every card has two fields (target, native), giving
two sensible directions. A Chinese card would have three (character, pinyin, native), giving
six — character→pinyin, pinyin→character, character→native, native→character, pinyin→native,
native→pinyin — and the same checklist UI just grows. The work now is to name directions by
field pair in config and code rather than hardcoding "forward"/"reverse" any deeper.

### Conversion rules (your rules, spelled out)

- **Multiple → single:** the native→target schedule is kept as the card's one schedule; every
  other direction's schedule is scrapped.
- **Single → multiple:** each newly enabled direction initializes as a copy of the forward
  schedule (same difficulty/stability/interval), then diverges with your review pattern.

### Questions — Part 1

1. **"Scrapped" — delete or ghost?** Deleting reverse schedules is irreversible; the current
   track system ghosts instead (free, instantly reversible, invisible while off).
   **Recommendation: ghost.** It looks and behaves exactly like scrapping, but flipping back
   restores history instead of re-initializing from forward. If you want a true purge, it's a
   one-time cleanup button, not the default.
2. **Seeding a newly enabled direction:** copying the forward schedule exactly means both
   directions come due the same day — a review spike of 2× for weeks.
   **Recommendation:** copy difficulty/stability/interval, but spread each card's first due
   date randomly within its own interval window (same trick onboarding uses), so the new
   direction phases in smoothly.
3. **Where the setting lives:** **Recommendation:** the pair's SRS settings modal (Library →
   pair → settings), replacing the "Enable review tracks" list with: Directions
   [single / multiple], and under "multiple" the direction checklist.
4. **Modality per direction:** today typed/smart/self-graded applies only to forward. Under
   directions, each enabled direction should carry its own modality (typed / smart / self-
   graded / recognition-only) — Chinese will need this (character→pinyin typed, pinyin→native
   self-graded, …). **Recommendation: yes**, per-direction modality, defaulted from today's
   settings.
5. **Default for existing pairs:** multiple, with both current directions on and current
   modalities — i.e., the status quo, nothing changes until you touch the setting. Confirm.
6. **UI fallout:** for a single-direction pair, every reverse surface disappears for that pair
   (reverse boxes/filters on deck detail, library, study dashboard; the forecast's Reverse
   line; express matching and story launchers, which are recognition-only). Confirm that's
   what you want rather than them showing "0".

---

## Part 2 — Due Now as a program you build

### Where things stand today

- The dashboard's due picker splits due cards into Typing / Self-graded / per-language rows;
  each launch picks one mode for the whole run: normal session, cloze (`?cloze=1`), express
  matching, or story. A review is always one full-strength FSRS credit.
- Recent rule (already shipped): inside matching and cloze, a miss replays **in-mode** until
  cleared — nothing gets ejected to a default review.

### Proposed

1. **Batch view.** The Due page lists one batch per language pair — subdivided per direction
   when the pair has directions on — with its due count.
2. **Program builder.** For each batch you assemble today's program: an ordered chain of
   stages from an exercise palette — **Matching**, **Cloze**, **Active recall** (self-graded
   flashcard), **Typed recall** — with room for future stages (translate-a-sentence,
   dictation). Presets make the common days one tap.
3. **The pipeline.** A word must clear each stage once. Wrong answers replay within the stage
   (the rule you just set — never branching to another exercise). Clearing a stage promotes
   the word to the next; clearing the **final** stage is what assigns the schedule credit.
4. **Program strength.** The size of the credit depends on the program: a matching-only day
   keeps you current but can't extend intervals far; a program ending in real recall extends
   them fully. The builder shows what each choice is worth before you start.

The point: on a 100-word backlog day you can choose a 20-minute matching pass that counts,
instead of a 2-hour full session you'll postpone — accepting more frequent reviews as the
price.

### Scheduling model (the part we must get exactly right)

One FSRS review per word per program completion:

- **The rating** comes from the final stage: self-grade buttons where the stage has them;
  typed correctness maps through the usual grader; a clean matching finish counts as Good.
- **The growth cap** comes from the program's strength. Proposal: each exercise type has a
  strength factor applied to the interval growth (not to difficulty/stability bookkeeping —
  the memory model stays honest): e.g. Matching 0.4, Cloze 0.75, Active/Typed recall 1.0.
  Numbers to be tuned; the mechanism is a multiplier on the *growth portion* of the new
  interval, so even a matching-only day always moves a card forward, just less far.
- **Failure:** a word you mark "I don't know" (or that keeps failing) takes a real Again —
  relearn loop and all. Ordinary misses just replay in-stage, as now.

### Questions — Part 2

7. **Strength = final stage, strongest stage, or the whole chain?**
   **Recommendation: the final stage defines the strength**; earlier stages are warm-up. It's
   predictable ("ends in recall = full credit") and matches your description — matching first
   just gets you through the recall faster.
8. **Batch flow: stage-by-stage or per-word?** You described per-word promotion ("once I get
   it right in matching, it goes into the next stage"). Running stage-by-stage over the whole
   batch (everyone does matching; survivors then do cloze; …) is the same thing at batch
   granularity and fits matching's N-at-a-time nature.
   **Recommendation: stage-by-stage over the batch**, with big batches chunked into rounds the
   way matching already works.
9. **Quitting mid-program:** words that cleared the final stage are credited (credit lands
   per word, as express does today); words stuck mid-pipeline get nothing.
   **Recommendation:** also persist per-word stage progress for the rest of the day, so
   closing the app after the matching pass and resuming at lunch continues at cloze rather
   than restarting.
10. **Matching as the only stage for a production batch:** matching is recognition evidence.
    A matching-only program over a *recognition* batch is clean (it's today's express). Over a
    *production* batch it would credit production off a recognition exercise.
    **Recommendation:** allow it, at a harsher cap (it's exactly your busy-day case), and the
    builder labels it "light credit". Alternative: production batches require at least one
    production-flavored stage. Pick one.
11. **What replaces what:** the program builder replaces the due-picker's mode choice for
    graduated reviews — presets reproduce today's modes (Matching-only = express; Cloze chain;
    plain recall). Express/cloze/story deep links keep working by mapping onto presets.
    **Story:** fold in as a stage later, or leave as its own thing for now?
    **Recommendation: leave story separate for now.**
12. **Presets:** per-pair saved programs plus the last-used one remembered. Proposed starter
    presets: "Busy day" (Matching), "Standard" (Matching → Active recall), "Deep" (Matching →
    Cloze → Typed recall). Name/adjust freely.
13. **Scope:** graduated cards only — the learning pipeline (ladder) and new-word intake stay
    exactly as they are. Confirm.
14. **Exercise constraints** (for transparency, not really questions): Cloze needs labels —
    unlabeled/phrase cards do plain recall in a cloze stage; Matching needs ≥2 words and skips
    ambiguous identical wordings (those words silently start at the next stage); Typed recall
    only exists for production directions.

### Sequencing

15. Part 2 wants Part 1's batch subdivision, but only shallowly (a batch per direction is just
    a grouping key). **Recommendation:** build Part 1 first (it's smaller: config + conversion
    + UI fallout), then Part 2 on top. If you'd rather feel Part 2 sooner, Part 2 can start
    against today's forward/reverse split and pick up Part 1's config later.

### Build stages (what implementation would look like, post-agreement)

- **1A** — Direction config per pair (schema named by field pairs) + conversion flows (ghost +
  seeding spread) + settings UI replacing the track list.
- **1B** — UI fallout: hide reverse surfaces for single-direction pairs; counts, forecast,
  launchers.
- **2A** — Program model + engine: strength caps as pure, tested scheduling math.
- **2B** — The runner: stage orchestration over a batch, reusing MatchingGame, cloze prompts,
  Flashcard and Typing modes as stage renderers; per-word stage tracking + same-day resume.
- **2C** — The new Due page: batches, builder, presets, strength display; deep-link mapping
  from the old modes.
- **Later** — Chinese field model (third field + six-direction checklist); new exercise types
  (translate-a-sentence, dictation-as-stage); story as a stage.
