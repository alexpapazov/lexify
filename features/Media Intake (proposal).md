# Media Intake — the vocabulary-buddy mission

> **Status:** Stage 0 (creation-time labeling) and the original Stage 1 (book-page parse flow)
> BUILT 2026-11-05. Spec revised 2026-11-06 with the user's log/maturity/implicit-credit design —
> the roadmap below supersedes the old stage list. Every decision here is the user's; build
> stages in order, each useful alone. Build order: **A → B → C → D → E** (maturity + credit
> first — they fix over-reviewing on their own — then the media log).

## Mission

Lexify as a vocabulary buddy that knows everything you know — fed by the media you actually
consume. A book page is EVIDENCE: the words you marked are words you didn't know; the words you
read and did NOT mark are passive proof you still know them. The media tab is a **log** of that
evidence, and the scheduler consumes it.

**The catch-up scenario (user, 2026-11-06):** six years of French, Lexify never updated. Reading
one book while logging pages should get Lexify up to speed — by the end of the book it knows
which words you know and which you don't, with no manual deck work. Everything below serves
that: lemma-keyed matching, chips for bulk known-marking, and auto-graduating stale cards.

## What's already built (2026-11-05)

- **Stage 0 — lemma coverage:** every freshly inserted card is labeled (pos + lemma) in the
  background at creation (`SupabaseCardRepository.labelInBackground`, bulkCreate + forkInDeck);
  Settings → Vocabulary labels is the backstop for legacy cards. Columns live since migration
  110 (`cards.pos` / `cards.lemma`, archived = applied). **2026-11-06: text edits relabel** —
  `SupabaseCardRepository.update` with `front`/`back` in the patch nulls pos/lemma IN THE SAME
  WRITE and relabels in the background (a card edited to a different word can never keep the old
  lemma; offline edits null the labels and the backstop catches them after sync).
- **Book-page parse flow** (`/create/book`): photos → client downscale → sliding page-pair
  windows → `/api/media/parse-page` (Sonnet vision, marker presets + per-book free text, images
  never stored) → `lib/mediaIntake.ts` (windowPages / collapseOccurrences with per-sentence
  answers / compareWithLexicon lemma-primary + bare-front fallback) → review (new words
  editable/selectable; lexicon matches get skip/attach/add/replace) → commit to a deck named
  after the book, book sentences stored via appendStoredCloze. **Stage C below restructures this
  into the media log; the parse pipeline is reused as-is.**

## Stage A — Maturity phases (two, not three) — BUILT 2026-11-06

`engine/implicitCredit.ts`: `maturityPhase(intervalDays)` / `LONG_TERM_THRESHOLD_DAYS = 30` (user decision 2026-11-06: lowered from 60 after trajectory simulation — reading volume takes over sooner),
classified on the lane's ideal interval. Card ℹ panel shows a Phase row per track group
("Long-term (earns reading credit)" / "Short-term (long-term at 30d)") plus a "Last reading
credit" row when set.

**User decision 2026-11-06: no medium band.** Exactly two phases, derived from the card's FSRS
state — pure classification:

- **Short-term:** scheduled interval < **30 days**.
- **Long-term:** scheduled interval ≥ **30 days**. Only long-term cards are eligible for
  implicit credit from reading.

Classify on the **scheduled interval** of the relevant row (production lane interval), not raw
stability, so what the user sees ("due in 3 months") is what gates credit. Surface the phase in
the card ℹ panel and as counts per pair (Today page or progress).

OPEN (user has not decided): the optional long-term **retention discount** (long-term cards
target a lower retention, lengthening their intervals independent of reading). Ask before
building it into this stage.

## Stage B — Implicit credit engine — BUILT 2026-11-06

Eligibility in `engine/implicitCredit.ts` (`rowSightingEligible` / `laneSightingEligible`),
application in `lib/implicitCredit.ts` (`creditCardSighting`). **Migration
`127_implicit_credit.sql` (card_states.last_implicit_at) must be applied before wiring a
caller.** Key implementation facts: ONE FSRS advance per ROW (lanes share D/S — a sighting must
never compound them), each eligible lane's interval recomputed from the new stability with its
own retention + calibration, intervals can only GROW (`Math.max` floor at the current value),
`lastReviewedAt` IS set to the sighting (the advance consumed the elapsed time — not setting it
would double-grow stability at the next real review), reps/lastRating untouched, **NO
review_events row** (the per-day cap uses `last_implicit_at`, ≥20h gap; the media entry log is
the audit trail — this keeps calibration + analytics honest by construction), disabled tracks
never credited, reverse credit requires the forward row graduated (forward dormancy does NOT
gate it — per-direction). No caller yet: Stage E wires sightings from media entries.

A **sighting** = the user read a page containing a lemma that maps to a card, and did NOT mark
it.

- **Long-term card + sighting → counts like a review** (a passive Good): advance the FSRS
  schedule from elapsed time, same stability-growth path as a Good rating, new due date pushed
  out accordingly.
- **Short-term card + sighting → nothing.** (The old half-strength medium rule is DEAD with the
  medium band.)
- Guardrails: graduated, non-dormant, non-relearning rows only; **max one credit per card per
  day**; an **overdue** card gets NO credit (it stays due — default pending user override).
- Logged as a review event with a distinct marker (`implicit`) that is **EXCLUDED from retention
  calibration and measured-retention displays** — a sighting is not a recall; letting it in would
  inflate measured retention and stretch intervals twice.

## Stage C — Media tab: the log

A new top-level **Media** tab (`/media`). The book flow becomes **entries in a log**, not a
create wizard:

- Entry list: book title, date, pages parsed, words marked, actions taken (words added, credits
  applied). "New entry" runs the existing photo → parse → review pipeline.
- **Migration: `media_entries`** — stores the extraction output (candidates with sentences,
  marker config, the unmarked-lemma list, stats; JSONB), NEVER the images. An entry saves first;
  word-list creation / add-known / credit are actions on the entry.
- Per-book marker memory moves from localStorage onto the entry/book record.
- `/create/book` redirects here (or the Create card links here).

## Stage D — Full-page extraction

Extend the parse-page prompt: alongside the rich marked items, return **`allLemmas`** — every
distinct printed lemma on the page(s), flat list, no gloss/sentence (cheap tokens, same single
Sonnet call). The entry then splits unmarked lemmas against the lexicon:

- unmarked + **in library, graduated** → credit candidates (Stage B feed);
- unmarked + **in library, NOT graduated** (added long ago, never studied, or mid-pipeline) →
  Stage E chips: painting one short/long-term **auto-graduates the EXISTING card** with that
  phase's seeding — no new card. This is the catch-up path for a stale library;
- unmarked + **not in library** → add-as-known candidates (Stage E chips, new cards).

## Stage E — Entry review: the three outcomes

For a page of ~100 words with 5 marked:

1. **Marked words (the 5)** — flagged "you didn't know these." Confirm → add to the library as
   UNLEARNED (normal learning pipeline), choosing **which set (deck) or a new set**. When the
   lemma matches an existing card, the per-row actions (user, 2026-11-06):
   - **Link into this set** — the SAME card (not a duplicate) linked into the book's deck via
     the existing shared-card deck_cards mechanism, book sentences attached;
   - **Attach** sentences to it where it lives (today's behavior);
   - **Delete** the existing card (it was wrong/stale) and add fresh — today's Replace;
   - **Keep as is** — today's Skip;
   - **Add anyway** — a separate card.
2. **Unmarked chips** — every unmarked lemma that is either not in the library OR in the library
   but not graduated, rendered as **chips** with bucket selectors on the right. Tap a bucket,
   then tap chips to paint them into it:
   - **Short term** → known, due dates **spread over the next ~2 weeks** (the existing
     bulk_known fast-track spreading — 14 days, never the old dynamic formula).
   - **Long term** → known with an initial interval of **~3 months** (90 days — above the
     30-day threshold, so immediately long-term phase and implicit-credit eligible). Spread
     within a window around 90d so a big page doesn't pile one future day.
   - **Words I don't know** (the forgot-to-underline correction) → joins bucket 1's add-as-
     unlearned flow.
   - A chip whose lemma matches an existing non-graduated card does NOT create a card: painting
     it short/long-term **graduates the existing card** with that seeding (another
     auto-graduation path — manual study is never required to mark something known); painting
     it don't-know leaves the existing card in its pipeline (and offers the bucket-1 actions).
   - Unpainted chips → ignored entirely (not added, no schedule change, no record beyond the
     entry log).
3. **Unmarked + in library** — credited automatically per Stage B, shown as a summary line
   ("boosted N long-term words; M short-term words seen, no change"). Nice-to-have: let the
   don't-know correction also target an in-library word — cancels its credit and (optionally)
   makes it due.

## Later stages (unchanged from the original plan)

- **YouTube intake:** transcript → lemma-match → same review. Caption provenance gate:
  `captions.list` (`trackKind` standard vs asr, plain `YOUTUBE_API_KEY`); manual track → Supadata
  `mode=native` (1 credit); ASR-only → default Supadata `mode=generate` (2 credits/min, ~$0.23
  per 20 min); always show what was found BEFORE spending credits; verify returned `lang` matches
  the pair. Free npm transcript libraries are blocked on datacenter IPs — not an option.
- **Media-sourced cloze:** `StoredClozeSentence.source: 'generated' | 'media'` (+ media ref);
  cloze prefers an authentic media sentence when present; ℹ panel badge.
- **Lemma normalization:** one lemma layer per pair (shared lemma table, cross-card links) —
  only if the intake channels prove the need.

## Rules carried from the rest of the app

- Intake writes are REVIEW-FIRST: nothing lands in the library or the schedule without the
  entry review's confirm. Adding known words is ALWAYS explicit (chips painted by hand) — never
  auto-known.
- Implicit credit is the ONLY schedule write outside sanctioned review paths, and it can only
  ever LENGTHEN an interval on a long-term card.
- Store occurrences/sentences/lemma lists as facts on the entry; derive counts and suggestions
  at render.
- Routes import from lib, never the reverse (Capacitor trap); wire types live in lib.
