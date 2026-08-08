# Practice Mode

**Status: DESIGN + LABELING GROUNDWORK ONLY (2026-08-07). Migration `110_card_labels.sql` written,
pending application. No exercise generation, no UI beyond the Settings labeling panel.**

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

## 3. Not built yet (rough order)

1. Exercise generation (cloze + translate-the-sentence first — both gradeable with existing
   machinery), with the validator/repair loop and slider from §1.
2. Sentence bank caching + pre-generation.
3. Free-production exercises + their grading (grading design deferred — discuss before building).

---

## Error log

*(none yet)*
