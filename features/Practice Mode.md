# Practice Mode

**Status (2026-08-08): Phases 0–4 DONE.** Migration 110 applied and labels backfilling;
`engine/practice.ts` (scoring) and `engine/practiceSelect.ts` (six composable target sources);
generate + repair routes and orchestration; `/practice` page with the cloze player.
**Migration `111_practice_slider.sql` is PENDING — apply it before deploying.** The generate/repair
round trip has still never run against the real API (everything is verified by build, unit tests
with mocked fetch, and a 200 on the route), so expect prompt tuning on the first real session.
Phase 5 (sentence bank) is next.

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

New cards are NOT auto-labeled at creation (too many intake paths to hook). Three places top up:

| Where | Scope | Use when |
|---|---|---|
| Settings → Vocabulary labels | Whole library | Blanket catch-up |
| Practice page prompt | The current language pair | You're about to practise |
| **Agents → 🏷 Label vocabulary** (2026-08-08) | The scope tree (pair / folder / decks) | Big backfills you want to do in controlled chunks |

**The agent action is deliberately NOT a change-set flow.** The review queue exists because editing
a card's front or back destroys content the user wrote, so a human should see each proposal. A label
is derived metadata — a wrong `pos` costs one odd practice sentence and is fixed by re-running.
Queueing thousands of label proposals would only train the habit of hitting "accept all" unread,
which is worse than no review at all. So it applies directly, like the deterministic de-dupe scan:
scoped, immediate, reportable. All three entry points share `lib/labelCards.ts`, are idempotent
(only `pos IS NULL` cards are sent), and persist batch by batch.

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

**Phase 2 — Generation + repair (API + orchestration). ✅ BUILT 2026-08-07** — 23 tests across
`lib/__tests__/practiceSchema.test.ts` and `practiceGenerate.test.ts` (fetch mocked; no API calls
in CI).

- **`lib/practiceSchema.ts`** — the wire shape, plus a parser that drops malformed entries instead
  of throwing (one fumbled sentence shouldn't lose the other nine). The key split: **`sentence` is
  the display truth** (a natural string, punctuation and all) while **`tokens` is the analysis**
  (one entry per vocabulary word, no punctuation). Keeping them separate sidesteps the
  rejoin-the-tokens problem entirely — no guessing where spaces go around commas or French
  elisions. Validation rejects an `answer` that doesn't occur in `sentence` (the cloze blank would
  be unrenderable); an unknown `pos` becomes `other` rather than dropping the word, so it can still
  be flagged and never becomes silently exempt.
- **`/api/practice/generate`** — Haiku. Takes targets (front/lemma/pos/gloss — the gloss picks the
  right sense of a homograph), the POS-balanced helper sample, count, and a `narrowVocabulary`
  flag. Returns sentence + answer + translation + per-word annotations **including a native gloss
  per word**, so a word that survives repair already has its translation for the red-flag display —
  no second call.
- **`/api/practice/repair`** — returns the **whole rewritten sentence**, not just a replacement
  word: swapping a word drags agreement, tense and word order with it ("une grande maison" → "un
  grand jardin"), so the model rewrites and re-annotates, and the result is re-scored rather than
  trusted.
- **`lib/practiceGenerate.ts`** — the loop. Scores every sentence, then one repair attempt per
  offending word, always re-reading the CURRENT offender list (a successful rewrite changes it).
  Two guards: a rewrite that doesn't reduce the unknown-word count is **rejected** (no trading
  `tonnerre` for `foudre`), and a failed repair call **stops** the loop rather than paying for more
  calls that aren't landing. Leftovers stay in the sentence, flagged with their gloss.
  Narrow-library fallback: the prompt allows simple outside words and the percentage bar drops to 0
  — unknown words are still flagged, but a sentence isn't failed for a score it could never reach.
  **Subtlety worth keeping:** only a sentence's OWN target is exempt from scoring; the session's
  other target words are ordinary vocabulary when they turn up in someone else's sentence.

**Phase 3 — V1 session UI (first playable). ✅ BUILT 2026-08-07** — 11 tests in
`lib/__tests__/practiceRender.test.ts`. **Migration `111_practice_slider.sql` must be applied
before this deploys** (`language_pairs` SELECTs name the new column).

- **Migration 111** — `language_pairs.practice_graduated_pct`, NULL = never set so the UI owns the
  default (70) rather than the schema. Repo: `updatePracticeGraduatedPct`, clamped 0–100.
- **`app/practice/page.tsx`** — setup then play. All the deterministic work happens **before** any
  API call: the library index and coverage check run locally, so "you have 400 nouns and two verbs"
  is free and a doomed generation is never paid for. Also surfaces unlabeled cards with an inline
  "Label now" button (calls `labelCards`), since an unlabeled card can't appear in a sentence.
  Target words are hand-picked from a searchable list; function-word classes (determiner, pronoun,
  conjunction, preposition) are excluded from the picker — "guess the missing *the*" is not an
  exercise. Slider persists per pair on session start, fire-and-forget so a write failure can't
  block practice.
- **`components/practice/ClozePlayer.tsx`** — blank, type, check, continue. Two deliberate
  departures from a study session: it **writes nothing** (no `card_states`, no review events, no
  due dates — practice is exposure, not assessment, and mixing it into FSRS would double-count),
  and grading is **flexible with capitalization ignored regardless of the pair's strictness**,
  because the sentence around the answer is machine-generated and failing someone on an accent in a
  word they weren't drilling is noise. Translation is behind a Hint button so the default is recall,
  not transcription.
- **`lib/practiceRender.ts`** — pure: `splitForBlank` (sentence around the cloze gap) and
  `segmentFlagged` (word-level, case-insensitive, punctuation-preserving runs so unknown words
  render red with their gloss without mangling the sentence).
- Nav entry added and hidden offline; the page itself renders `OfflineUnavailable`.

**Verified so far:** build, 46 suites / 652 tests, and `GET /practice` → 200 with no console
errors. **Not yet verified: anything past the auth wall** — the real generate/repair round trip has
still never run. First real session is where prompt tuning happens (annotation quality, lemma
agreement with the labels).

**Phase 4 — Flexible target selection. ✅ BUILT 2026-08-08** — `engine/practiceSelect.ts`,
29 tests in `engine/__tests__/practiceSelect.test.ts`. No migration.

**The one gate.** `targetRejection` in `engine/practice.ts` is now the single place that decides
whether a card can be drilled, so a card can never be drillable via one route and not another.
`PracticeTarget`, `UNDRILLABLE_POS` and `toPracticeTargets` moved from `lib/practiceGenerate.ts`
into the engine for the same reason.

> ⚠️ **Check order inside `targetRejection` is load-bearing.** A phrase card *is* labeled — the
> labeler deliberately gives it `lemma: null`, since a free phrase has no citation form. Testing the
> lemma before the `pos` reports phrases as "unlabeled" and sends the learner off to re-run labeling
> that would change nothing. `pos` missing → unlabeled; phrase/function word → undrillable; only
> then a missing lemma → unlabeled.

**Six sources, composing.** `TargetSource` is a union; `resolveTargets(sources, ctx, cap)` unions
them into one deduped list in source order, then match order within a source:

| Source | Ordering | Notes |
|---|---|---|
| `manual` | as clicked | Never capped — the choice was explicit |
| `decks` / `folders` | deck order | Folders expand via `descendantDeckIds` |
| `due` | soonest first | Graduated only (unstudied cards aren't review-scheduled); **overdue included**, no lower bound |
| `difficulty` | hardest first | FSRS difficulty, lapses as tie-break, card id for determinism. Cards with `difficulty: null` are skipped, not treated as easy |
| `list` | pasted order | Matched via injected `normalizeFrontKey`, so "el pan" finds "pan" |

- **Nothing disappears silently** — the result carries `droppedUnlabeled`, `droppedUndrillable`,
  `unmatched` (list source) and `capped`, and the UI renders all four. A picker that quietly returns
  12 words for a 400-card deck is how you end up debugging the wrong thing.
- **The cap is applied after the gate**, so a deck full of unlabeled cards doesn't burn the
  allowance on words that were never going to make it. `DEFAULT_CAP_PER_SOURCE = 50`, on the bulk
  sources only.
- **Purity:** the engine takes `normalizeKey` as an injected function rather than importing
  `lib/duplicates`, and `today` as a string rather than reading a clock.
- UI: six tabs feeding one target set, resolved words shown as removable chips. Removing a word
  that arrived from a bulk source pins the whole selection down to an explicit list minus that word
  — otherwise the source would just re-add it on the next render.

**Phase 5 — Sentence bank (cost + latency). NEXT.**
- Migration 112: `practice_sentences` (user, pair, target lemma, annotated-sentence JSONB,
  created_at, use count). Read the bank first, generate only the gap; background top-up via the
  existing prefetch idiom. Stored sentences are RE-SCORED against the current library at read time
  (the library grows; annotations make re-scoring pure) — never store the pass/fail verdict.
- Matters more after Phase 4: deck- and due-based selection means far larger sessions, so the
  cache is what keeps a 30-word session from being 30 generation calls.

**Phase 6 — More modes + grading design (STOP AND DISCUSS FIRST).**
- Translate target→native, native→target, free production ("use the word"). Grading for these is
  explicitly undesigned — the user wants a conversation before it's built (AI-graded answers have
  a per-answer API cost, unlike the fully-cacheable v1).
- Practice analytics (weak-word surfacing), if wanted.

Parked indefinitely: embeddings for replacement candidates (§1), any scheduling feedback (decided
against). **Note:** "auto-focus target selection" was decided against in the sense that the app
never picks *for* you — but Phase 4's due/difficulty sources are assisted selection you invoke
deliberately, which is a different thing and is wanted.

---

## Error log

| Date | Error | Fix |
|------|-------|-----|
| 2026-08-07 | Practice reported "You have no graduated words in this language yet" for a pair with plenty of graduated cards. Not a scoring bug — the cards were graduated but **unlabeled**, and an unlabeled card has no lemma, so `buildLibraryIndex` correctly excluded it from the vocabulary. The message conflated "no graduated words" with "no *labeled* graduated words", and the narrow-vocabulary warning fired above the labeling prompt, burying the actual cause | Added `LibraryIndex.graduatedUnlabeledCount`; the practice page now leads with the labeling prompt when it's non-zero (naming that count) and **suppresses** the coverage warning until labeling is done — coverage can't be judged from an unlabeled library. Note for future surfaces: any "your library is empty" message must check the unlabeled count first |
