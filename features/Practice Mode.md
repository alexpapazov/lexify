# Practice Mode

**Status (2026-08-07): Phase 0 DONE (migration 110 applied, labels backfilled) · Phase 1 DONE
(`engine/practice.ts`). No AI generation and no practice UI yet — Phase 2 is next.**

A planned mode where the learner picks from exercise types (cloze, translate-the-sentence, use the
word in a sentence, …) generated from their own vocabulary. This doc records the agreed design so a
future session can build generation without re-deriving it, plus what is already built.

---

## 1. Agreed design (from the 2026-08-07 conversation)

- **Generate → validate → repair, never pure prompting.** The LLM proposes sentences; deterministic
  code checks every content word's lemma against the learner's library. Don't ask a model to
  hard-satisfy "only use these 1000 words" — it will leak. Function words are always allowed.
- **The "graduated %" slider is a validator SCORE, not a model constraint.** The learner sets a
  minimum share of words that must come from their graduated library; the validator computes the
  actual share and generation retries/repairs until the threshold is met.
- **Repair loop:** an offending word gets one replacement attempt (model picks a substitute from a
  POS-matched candidate list drawn from the library). If no substitute works after the retry budget,
  the word is KEPT but flagged — rendered in red with the native translation in parentheses after
  it — unless it is the target word being practiced.
- **Target words are exempt.** The word(s) being practiced are always allowed even when not yet in
  the library (the learner may be drilling brand-new words).
- **Narrow-vocabulary detection is deterministic and pre-flight.** POS coverage of the graduated
  library (e.g. 1000 nouns, 3 verbs) is computed from the labels BEFORE any generation call; if
  sentence-building is impossible at the requested constraint, say so and fall back to filling gaps
  with simple high-frequency words outside the library (validator relaxed + prompt instruction).
- **The English gloss does not constrain generation.** If the target word appears, ANY sense of it
  counts — the card's single translation is not binding on usage. (Labeling is the one place the
  gloss IS used — as a sense-disambiguation hint; see §2.)
- **Phrases:** cards whose front is a whole sentence/free phrase get `pos = 'phrase'`. Generation may
  include them verbatim as optional material but never has to build around them; they don't count as
  single vocabulary words.
- **Cached sentence bank** (later): per-word generated exercises stored and reused so most practice
  sessions cost zero API calls — same pattern as `choices`/audio caching.
- **Model: Haiku** (`claude-haiku-4-5-20251001`) for generation and labeling — the validator provides
  the reliability, so the cheapest tier suffices. Grading open production ("use the word in a
  sentence") is the one place a stronger model may be warranted; grading design is EXPLICITLY
  DEFERRED — cloze reuses `gradeTyping`, the rest TBD.
- **Vector embeddings for replacement candidates: DEFERRED.** POS-filtered candidates + model choice
  is expected to be enough; embeddings would add a second vendor (Anthropic has no embeddings API)
  plus pgvector setup. Revisit only if replacement quality disappoints.

## 2. Built: vocabulary labels (migration 110)

Every card gets `pos` + `lemma` for its FRONT:

- **`pos`** ∈ `noun | verb | adjective | adverb | pronoun | preposition | conjunction | determiner |
  interjection | numeral | phrase | other` (`PartOfSpeech` in `domain/index.ts`). Multi-word fronts
  that function as one unit (reflexive/phrasal verbs, article+noun, fixed compounds) get the head
  word's class; everything else multi-word is `phrase`. Value set enforced in application code only.
- **`lemma`** — dictionary citation form: leading article stripped, `(f)`/`(m)`/`[note]` annotations
  ignored, lowercase unless proper noun, reflexive pronoun kept ("se précipiter"). `null` for
  `phrase` cards and until labeled.
- **The gloss is a labeling input** — sent to the model purely to pick the right sense of a homograph
  ("pesca"/"peach" → noun; "pesca"/"he fishes" → verb). The label reflects the sense the learner is
  studying, which is what exercise selection needs (verb card → conjugation cloze).

### Pieces

| Piece | Where |
|---|---|
| Migration | `supabase/migrations/110_card_labels.sql` — `cards.pos`, `cards.lemma`, `set_card_labels(jsonb)` bulk-write RPC (owner-scoped) |
| Domain | `PartOfSpeech` + `Card.pos`/`Card.lemma` in `domain/index.ts` |
| Repo | `cardRepo.setLabels()` (chunked RPC calls); `pos, lemma` added to BULK and SESSION column lists; mapped in `rowToCard` |
| API route | `app/api/cards/label/route.ts` — Haiku, batches ≤ 80, same raw-fetch fail-soft pattern as `/api/cards/verify`; hallucinated indices dropped; invalid pos → `other` |
| Client | `lib/labelCards.ts` — groups by language pair (one prompt names one pair), chunks of 60, 4 in flight, **persists each batch as it lands** so an interrupted backfill keeps its progress |
| UI | Settings → "Vocabulary labels" panel — shows the unlabeled count, one idempotent button (only `pos === null` cards are sent), progress in cards, failed count surfaced with "run again to retry" |

New cards are NOT auto-labeled at creation (too many intake paths to hook); the Settings button is
the top-up, and practice mode should itself top up unlabeled cards when it starts.

### ⚠️ Deployment order

`pos, lemma` are in the card SELECT column lists, so **migration 110 must be applied before this
code deploys** — otherwise every card query in the app fails (the profiles-SELECT trap from
CLAUDE.md, but on `cards`, which is load-bearing everywhere). Run the SQL first, then push.

## 3. Decisions locked 2026-08-07 (asked and answered)

- **Target words are MANUALLY SELECTED** each session (search + multi-select over the pair's
  library). No auto-focus queue; convenience filters (learning / due / recently lapsed) may assist
  the picker but the user always chooses.
- **Practice never touches scheduling.** No FSRS writes, no due-date or difficulty changes.
  (Analytics logging can come later; the memory model stays clean.)
- **V1 ships CLOZE ONLY** — fill-in-the-blank graded by `gradeTyping`. Other modes follow.
- **The graduated-% slider is stored PER LANGUAGE PAIR** (column on `language_pairs`).

## 4. Implementation phases

Each phase is shippable on its own; read this doc in full before starting one.

**Phase 0 — Label backfill (built; needs a real run).** Apply migration 110, run Settings →
Vocabulary labels, spot-check French reflexives + homographs. Everything below assumes labels exist.

**Phase 1 — Practice engine (pure, no AI, no UI). ✅ BUILT 2026-08-07** — `engine/practice.ts`,
29 tests in `engine/__tests__/practice.test.ts`. The API:
- `buildLibraryIndex(cards, forwardStates)` → `{ all, graduated, graduatedByPos, graduatedWords,
  unlabeledCount }`. **Graduation is read from the FORWARD row only** — practice is production, and
  the reverse row graduates on its own schedule. Phrase cards are excluded from the vocabulary
  (they're real, just not single words); unlabeled cards are counted, not indexed, so the UI can
  offer a top-up. A lemma shared by several cards counts once.
- `vocabularyCoverage(index)` → `'ok' | 'narrow'` + which classes are missing. Thresholds:
  `ESSENTIAL_POS = [noun, verb, adjective]`, `MIN_POS_COUNT = 5` — deliberately low, so "narrow"
  means *genuinely can't build a sentence*, not "could be richer". Only graduated cards count.
- `scoreSentence(tokens, index, targetLemmas, minGraduatedPct)` → `{ tokens (scored), countedCount,
  graduatedCount, graduatedPct, offenders, passes }`. Three exemptions, and the middle one is the
  subtle one: **function words** never count (structural, no library has them all); **target words**
  never count (that's the exercise, and they may be brand new); and a word that's in the library but
  NOT graduated lowers the percentage yet is **never flagged** — the learner has genuinely met it,
  so there's nothing to repair. A sentence of only function + target words scores 100 (nothing
  unknown in it). `passes` requires clearing the slider AND having zero flagged words.
- `sampleHelperWords(index, limit, seed)` — POS-balanced round-robin sample for the generation
  prompt (a sample, not the library: big lists cost tokens and *worsen* compliance). Deterministic
  per seed; the seed rotates so repeat generations vary without a random source.
- `repairCandidates(index, pos, limit)` — same-class graduated words for the repair pass.
- `AnnotatedToken` (what the model returns) vs `ScoredToken` (what this engine adds:
  `inLibrary`, `graduated`, `isTarget`, `flagged`). The model annotates; the engine judges.

**Phase 2 — Generation + repair (API + orchestration).**
- `/api/practice/generate` — Haiku, same fail-soft raw-fetch pattern: takes target words
  (front/lemma/pos), a POS-balanced SAMPLE of graduated helper words (30–50, not the whole
  library), pair languages, count → cloze exercises with per-token lemma annotations + blank
  position + expected answer.
- `/api/practice/repair` — sentence + offending token + POS-matched candidates → replacement.
- `lib/practiceGenerate.ts` — generate → validate (Phase 1) → one repair round per offender →
  keep-and-flag leftovers (red text + native translation in parentheses). Narrow-vocab fallback:
  validator relaxed + "prefer simple high-frequency words" prompt line.

**Phase 3 — V1 session UI (first playable).**
- Migration 111: `language_pairs.practice_graduated_pct` (the slider).
- `/practice` page (routes.ts helper + nav entry): word picker (reuse `cardMatchesSearch`),
  slider, exercise count; coverage warning from Phase 1 shown before generating.
- Cloze player: `gradeTyping` grading with the pair's grading settings, target word highlighted,
  flagged words red with parenthesized translations. Online only (`OfflineUnavailable`).
  NO card_states writes of any kind.

**Phase 4 — Sentence bank (cost + latency).**
- Migration 112: `practice_sentences` (user, pair, target lemma, annotated-sentence JSONB,
  created_at, use count). Read the bank first, generate only the gap; background top-up via the
  existing prefetch idiom. Stored sentences are RE-SCORED against the current library at read time
  (the library grows; annotations make re-scoring pure) — never store the pass/fail verdict.
- Practice start also tops up unlabeled cards (calls `labelCards` on the gap).

**Phase 5 — More modes + grading design (STOP AND DISCUSS FIRST).**
- Translate target→native, native→target, free production ("use the word"). Grading for these is
  explicitly undesigned — the user wants a conversation before it's built (AI-graded answers have
  a per-answer API cost, unlike the fully-cacheable v1).
- Practice analytics (weak-word surfacing), if wanted.

Parked indefinitely: embeddings for replacement candidates (§1), any scheduling feedback (decided
against), auto-focus target selection (decided against — manual picking).

---

## Error log

*(none yet)*
