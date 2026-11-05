# Media Intake (proposal — NOT built)

> **Status: designed 2026-11-05, deliberately not started.** The mission: Lexify as a vocabulary
> buddy that knows everything you know — fed by the media you actually consume (book pages you
> photograph and annotate, YouTube videos you watch), not just hand-typed decks. Every design
> decision below is the user's; build stages in order, each useful alone.

## Stage 0 — Lemma coverage (prerequisite, mostly exists)

Lemma-based duplicate detection is only as good as the lemmas on EXISTING cards. The practice
tab's labeler (`lib/labelCards.ts`, Haiku) already writes `pos` + `lemma`; what's missing:
run/offer it LIBRARY-WIDE (per pair), and show coverage ("N cards unlabeled — label them for
accurate duplicate detection") on the intake screens. No new machinery.

## Stage 1 — Book-page intake (the flagship)

Upload photos of the pages you read (in order). Parse with Claude VISION (Sonnet) — this replaces
a 10–15-minute manual ChatGPT workflow with ~30s of parallel per-window calls.

**Windowing:** sliding pairs (1+2, 2+3, …; last page alone) so sentences crossing a page break are
always captured whole. **Extract fully from BOTH pages of every window — duplicates are welcome**
(user decision: re-marking a word is real signal, and the same occurrence seen by two windows is
cheap to collapse later). Each occurrence: `{ word|phrase, lemma, markerType, exact sentence,
page }` — the model outputs the LEMMA here; that is what makes stages B/C mechanical.

**Marker instructions — prompt-engineered presets, not free prose:** checkboxes (circled ·
underlined · line/arrow to margin · question mark nearby · highlighted), each mapping to OUR
battle-tested prompt fragment, plus ONE optional free-text line ("other marks — describe") as the
escape hatch for idiosyncratic systems. Word-vs-phrase is NEVER user input — the model
classifies (feeds `pos: 'phrase'`). Marker config persists PER BOOK: configure once.

**Stage B — collapse within the pull (automatic, silent):**
- same lemma + same sentence = one occurrence seen twice (window overlap) → collapsed, no trace;
- same lemma + different sentences = genuinely re-marked → ONE candidate carrying ALL its
  sentences and a count. "Underlined 3×" sorts the review list, seeds the difficulty/band
  suggestion, and arrives with the stored-cloze set (`MAX_STORED_CLOZES = 3`) pre-filled from
  real text.

**Stage C — compare against the lexicon (by lemma, interactive):** a candidate whose lemma
matches an existing card shows that card's front/back + status + interval, with four actions:
- **Skip** (default for graduated),
- **Attach** — add the book sentence(s) to the existing card's stored cloze set (best default
  for learning/graduated: authentic context, no churn),
- **Add anyway** — separate card, mapped like the create-deck duplicate behavior,
- **Replace** — soft-delete the old card, create fresh (suggested when the old card is
  unlearned/never studied).
No match → marked words go to the book's deck (book sentence = active cloze); unmarked words are
NOT auto-known — they flow to Stage 2's onboarding path as candidates.

## Stage 2 — Onboarding mode setting

Per-user setting for what intake does with "probably known" words:
- `confirm` (default): the existing Vocabulary Onboarding band flow — quick swipe-through;
- `auto-known`: straight to bulk_known fast-track (14-day due-date spreading —
  [[project_fast_track_spreading]] rules apply, never the old dynamic formula).
Applies to every intake channel (book, YouTube, later reading tracker).

## Stage 3 — YouTube intake

Paste a link → transcript → tokenize → lemma-match against the library → frequency-sorted
unknown-candidate list → the same Stage C review + Stage 2 onboarding.

**Caption provenance gate (user requirement — auto-captions are often unreliable/wrong-language):**
1. Official YouTube Data API `captions.list` (plain API key, ~50 quota units of a free 10k/day):
   per-track `language` + `trackKind` (`standard` = manual, `asr` = auto).
2. Manual track in the pair's language → fetch via Supadata `mode=native` (1 credit) → trust.
3. ASR-only → default to Supadata `mode=generate` (AI speech-to-text from the AUDIO, 2 credits
   per video minute, ~$0.23 for 20 min on the $17/3k plan; ~100 credits/month free) rather than
   ingesting YouTube's own ASR; setting can flip to accept-ASR-with-warning or abort.
4. The import screen always shows what was found BEFORE spending credits ("manual French
   captions ✓" / "auto only — will AI-transcribe, ~$0.23").
Supadata responses carry `lang` + `availableLangs` — verify the returned language matches the
pair before ingesting. Secrets: `YOUTUBE_API_KEY`, `SUPADATA_API_KEY`. Free npm transcript
libraries are NOT an option in production (YouTube blocks datacenter IPs).

## Stage 4 — Media-sourced cloze

`StoredClozeSentence` gains `source: 'generated' | 'media'` (+ a media ref — book/video title);
JSONB, no migration. Cloze exercises get a preference: use a media sentence when the card has one
(100% authentic), else generated. ℹ panel shows a source badge per sentence.

## Stage 5 — Lemma normalization (later, noted 2026-10 & 11-05)

One lemma layer per pair so *marché*/*marcher* collide at intake with "this lemma is in your
vocabulary — add as a separate card?". Stage 0 + Stage C are the light version; full
normalization (shared lemma table, cross-card links) waits until the intake channels prove the
need.

## Rules carried from the rest of the app

- Intake writes are REVIEW-FIRST: nothing lands in the library without the review screen's
  confirm (auto-known mode still shows a summary count before committing).
- Intake is schedule-neutral except through the sanctioned paths (deck creation, onboarding
  bands, fast-track).
- Store occurrences/sentences as facts; derive counts and suggestions at render.
- Routes import from lib, never the reverse (Capacitor trap); wire types live in lib.
