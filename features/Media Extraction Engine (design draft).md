# Media Extraction Engine — design (CONCLUDED + BUILT 2026-11-08)

> **Status: all rounds concluded; Stages A (server-side processing) and B+C (rating worklist,
> penalty, ×1.3 credit) are BUILT.** Decisions resolved in the user's annotations + chat:
> sentences per entry · server-side via Supabase Storage + media-worker Edge Function ·
> language mismatch warns-but-allows · nouns nominative singular (naturally-plural stays
> plural) with per-book article option · markers = circled/underlined ONLY, no free text ·
> unmarked-new chips pre-paint LONG TERM · penalty = the real FSRS Again at page-save, plus
> the card auto-links into the book's deck · credit = stability ×1.3 · chips gloss word-alone
> (single translation ~90%) · phrases kept verbatim, no lemma rules.

## 0. The experience, end to end

1. You open a book in Media, tap **Log pages**, pick the reading date, add photos **in any
   order**, tap send.
2. You leave. No waiting screen — the entry appears in the Media tab with a progress bar and
   processes in the background while you use the rest of Lexify.
3. When it finishes, the entry becomes a **rating worklist**: pages in reading order, each
   page showing only the words that still need something from you.
4. You rate page by page — or half a page — and leave. Progress saves as you go; coming back
   shows only what's still unrated.

## 1. Upload settings

- **Book** (existing record: title, pair, markers, deck).
- **Read on** date (past up to today).
- **Extract sentences** — a checkbox:
  - **ON**: pages are first put in reading order (printed page numbers), then parsed in
    consecutive pairs so a marked word's sentence is captured whole across page breaks.
  - **OFF**: no ordering pass at all. Pages process independently and immediately; no
    sentences are captured. ("Pages" in the rating UI are then in upload order.)
  - ❓ **Q1 — scope:** remembered per BOOK (like markers) or chosen per entry?

## 2. Processing (background)

Per page (pair when sentences ON), one vision call extracts:

- every printed **content lemma** (as now);
- which lemmas were **marked**;
- each lemma's **display form** — see §3;
- marked words' **sentences** — only when sentences ON.

Results land on the entry row page by page; the Media tab shows per-page progress. A failed
page is marked failed and the rest continue.

**Language guard (ALREADY BUILT in the current flow, carries over):** every parse call also
reports the language the printed text is ACTUALLY in. If it disagrees with the book's pair
(a French book filed under Bulgarian), the entry warns loudly BEFORE anything is saved, and
points you at the book's **Change language** control — which moves the book, its entries,
its deck, and every card in it to the right pair (language-derived caches — labels,
distractors, IPA, audio — clear and regenerate; schedules untouched).
- ❓ **Q2b — should a mismatch BLOCK saving entirely** (you must fix the book's language
  first), or warn-but-allow (what's built today)? I'd block in the new engine: a wrong-pair
  save pollutes the lexicon match for every later page.

- ❓ **Q2 — the background constraint.** Photos are never stored, so processing has to run
  inside the open app: it survives navigating anywhere in Lexify, but dies if you close the
  app mid-run (finished pages keep their results; unfinished ones show "failed — re-shoot or
  re-upload"). The alternative is uploading photos to temporary storage (deleted right after
  processing) so a server finishes the job even if you quit. Which do you want? My
  recommendation: in-app first (simpler, private); storage-backed later if dying mid-run
  actually bites.

## 3. Display forms (what you see and what goes on cards)

The **lemma** stays the bare citation form (what matching and dedupe key on). What you SEE on
chips — and what becomes the card's front — is the form you'd learn:

- **Nouns**: definite article + noun where that's how you card the language (French: *le
  sentier*, *la berge*, *l'eau*). Lemma stored: *sentier*.
- **Verbs**: infinitive (= lemma). **Adjectives**: masculine singular (= lemma).
- ❓ **Q3 — which languages get article+noun?** French yes. Bulgarian's definite is a suffix
  (книга → книгата) — do your BG cards carry it? Simplest: the extraction prompt is told
  "follow the learner's card style: SHOW IT like their existing fronts", or an explicit
  per-book free-text line ("nouns: definite article + noun"). Which?

## 4. Classification — what each page asks of you

For each page, every extracted lemma falls into exactly one of:

| Case | What happens |
|---|---|
| **Marked, not in lexicon** | Chip, pre-painted **"I don't know"** (changeable — accidental underlines happen). Saving creates a learning card in the book's deck (+ sentence when ON). |
| **Marked, IN lexicon** | **Recognition failure**: the card becomes **due today** and its interval/stability is cut drastically — you couldn't recognize it in context, long-term or not. (+ sentence attach when ON.) ❓ **Q4** below. |
| **Unmarked, not in lexicon** | Chip, unpainted — you choose **Short term / Long term / I don't know** (or ignore). |
| **Unmarked, in lexicon, graduated long-term** | Implicit credit, automatic, no rating needed. Shown as a per-page summary line. |
| **Unmarked, in lexicon, short-term or still learning** | Nothing (short-term words must earn their reviews in sessions; a word you underlined last week and sailed past today is exactly this case — correct that nothing happens). |

**Dedupe across the upload:** a lemma appears ONCE, on the earliest page it occurs. Rated on
page 1 ⇒ never shown on pages 2+. Credit fires at most once per upload (the ≥20h per-day cap
already guarantees this). Marked on page 1 + unmarked on page 3 = **marked** (no credit —
same upload, and it'd be short-term after rating anyway).

- ❓ **Q4 — the recognition-failure penalty, exactly.** Proposal: apply an FSRS **Again**
  (lapse) to every track of that card — stability collapses the way a failed review would
  collapse it, due today. That reuses the real lapse math instead of inventing a multiplier.
  OK, or do you want something gentler/harsher (e.g. stability × 0.2, due today, no lapse
  counted)?
- ❓ **Q5 — penalty timing.** You said marked chips are changeable (accidental underlines).
  So the penalty must apply when you SAVE that page, not at processing time — un-marking the
  chip first means no penalty. Confirm.
- ❓ **Q6 — the old matched-word actions.** Today a marked word already in your lexicon
  offers skip / attach sentences / link into this set / add anyway / replace. Under the new
  model it gets the penalty + automatic sentence attach instead. Do the other actions
  (link/replace/add-anyway) survive anywhere — maybe as a small "…" menu on the chip — or
  drop them?

## 5. Rating UI

- The entry page lists its pages in reading order: **p. 42 — 3 to rate · 2 don't-know · 14
  credited**, expandable.
- Within a page: the chip board as today (bucket painting), with marked chips already in
  "I don't know".
- **Save works at any granularity** — a page, half a page, one chip. Saved chips disappear
  from the worklist; the entry shows "N words left to rate" until empty.
- Saving a chip does what Stage E does now: short = 14-day spread, long = ~90d, don't-know =
  learning card; a chip matching an existing never-studied card graduates THAT card.
- ❓ **Q7 — credit timing.** Unmarked+known credit needs no rating from you — proposal: it
  applies automatically the moment that page finishes processing (summary line, no button).
  OK? (The alternative — credit only when you visit the page — just delays it for no reason.)
- ❓ **Q8 — gloss timing.** New-word chips need a translation when they become cards. Today
  that's one Haiku batch at save time. With partial saves there'll be one small batch per
  save — fine. But when sentences are OFF, glosses are generated from the word alone (no
  context). Acceptable, or should marked words' sentences ALWAYS be captured (making the
  toggle only about unmarked-word sentence quality… which it isn't used for anyway)? Note:
  sentences are currently only ever captured for MARKED words — so the toggle as specced
  only affects marked-word cards' cloze sentences and the ordering pass.

## 6. What's kept from the current engine

Lemma matching (lemma-primary + bare-front fallback), the chip seeding math (windows,
difficulty/stability, bulk_known), the implicit-credit engine and all its guardrails, the
gloss route, books/entries/read-on, the page-number ordering pass (now gated behind the
sentences toggle), photo decoding. The current one-shot review screen and its two-section
layout go away.

## 7. Contradiction / edge notes (read me)

- "Underlined later pages don't matter" vs dedupe: both hold — a lemma is ONE chip at its
  earliest occurrence; its mark state is the OR across the upload's pages.
- A lemma marked on p.1 (→ don't-know chip) that you rate, then appearing marked again on
  p.4: already rated, not shown again — p.4's mark changes nothing. Correct?
- Same word in two DIFFERENT uploads same day: credit capped by the 20h rule; a don't-know
  rating in upload 1 makes it "in lexicon, learning" for upload 2 (so: nothing happens).
- When sentences are OFF and pages are unordered, "p. 42" labels are unavailable — rating
  pages are labeled "Page 1..N" in upload order. Fine?
