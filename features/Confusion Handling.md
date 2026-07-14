# Confusion handling — feature doc & remaining work

## The idea
When you type a **different real word** (another card's target word) on a typed **production** review,
that's a *discrimination* failure — you can't tell two words apart. Vanilla SRS handles this poorly
(each card can have high individual stability yet you still mix them up). Lexify treats it as its own
event: link the pair, penalize recognition, drill them, force mutual distractors, and interleave them.

Two flavours, handled differently:
- **Intra-language** (both words in the same learned language) → the full response below.
- **Inter-language** (word confused with one in a *different* language) → link **stored only** for a
  future cross-linguistic feature; no penalty/drill/etc.

## Data model
- Table `card_confusion_links` (migration **052**), extended by **083** with `kind` (`'intra'|'inter'`)
  and `tags` (`text[]`). Ordered pair (`card_a_id < card_b_id`), one row per pair. Repo:
  `lib/data/cardConfusionLinks.ts` (`link(userId,x,y,kind,tags)`, `listForUser`, `listForCard`, `unlink`).
- `tags` = similarity categories for the future practice mode: `'phonetic' | 'semantic' | 'temporal' |
  'other'`. Multiple of phonetic/semantic/temporal may combine; `'other'` is exclusive; empty = not yet
  fully classified.
- Detection matches the typed word against **every card the user owns** (`cards.listFrontsForUser`,
  keyed on `owner_id`), so it works across languages.

## What's BUILT (Stages 0–5)
- **`engine/confusion.ts`** (pure, tested in `engine/__tests__/confusion.test.ts`):
  `findConfusedSibling` (genuine different word via `isDifferentWordMistake` + exact front match),
  `confusionKind` (intra/inter by source language), `classifyIntraTags` (phonetic via NFD phoneme-level
  `editRatio ≥ 0.6`; temporal if both introduced within 2 days; semantic/other left to the future),
  `confusionPenalty` (recognition-track: stability ×0.5, difficulty +1, shorter interval),
  `interleaveConfusablePairs` (cluster both-due linked cards contiguously).
- **`lib/confusionResponse.ts: respondToProductionConfusion(...)`** — lazy whole-library index, detect,
  split intra/inter, tag, `link`, and for intra: penalize BOTH cards' recognition (reverse) tracks +
  inject mutual distractors (`injectForcedDistractor` in `lib/distractors.ts`, into `choices.front`).
  Returns `{cardBId, cardBFront}` (intra) for the drill.
- **Detection wired** into all 3 session pages' `handleAnswer` (fire-and-forget on wrong typed production).
- **Immediate A-vs-B drill** — `components/session/ConfusionDrill.tsx` (show A's meaning, pick A's word
  vs B's word; pure practice, reschedules nothing). Queued `DRILL_OFFSET=3` cards ahead, before A or B
  recurs (`queueDrill` + `indexRef`; `SessionCard.drill`). In all 3 session pages.
- **Interleave** — each session loads intra links once and wraps its built due queue with
  `interleaveConfusablePairs`.

Design decisions (from the user): respond **immediately, every time** (no escalation); affect **both A
and B**; **recognition track only** (never production); **whole-library, any-language** matching.

---

## REMAINING WORK

### Stage 6 — Standalone "distinguish confusable cards" practice mode  *(user-owned)*
A dedicated mode that drills confusable pairs on demand (not just reactively mid-session).
- **What to build:** a page/entry that reads `SupabaseCardConfusionLinkRepository.listForUser` (filter
  `kind==='intra'`), groups by similarity tag, and runs A-vs-B (or A-vs-group) discrimination drills
  (reuse/extend `components/session/ConfusionDrill.tsx`). Let the user filter by tag (phonetic / semantic
  / temporal / other) and by language.
- **What you need:** decide the drill format (2-option vs N-option; which direction; whether it reschedules
  or is pure practice), and how a pair "graduates out" of the confusable set (e.g., N correct drills →
  `unlink`, or a `resolved` flag — would need a small migration).

### Semantic + "other" tagging  *(needed by Stage 6)*
`classifyIntraTags` currently only sets `phonetic`/`temporal`. To complete the taxonomy:
- **Semantic:** needs AI/embeddings — compare the two cards' glosses (backs) for meaning similarity
  (e.g., an embedding cosine, or an LLM classifier). Likely an API route that backfills `tags` on the
  link. Reuse the AI-route pattern in `app/api/*`.
- **`other`:** assign definitively only once semantic has been checked — i.e., a link with no
  phonetic/temporal/semantic tag gets `['other']`. Do this in the same backfill pass (don't assign
  `other` at detection time, since semantic isn't known yet).
- **Where:** a batch/backfill job (or the practice-mode load) that reads links with incomplete tags,
  computes semantic, writes final `tags`.

### Inter-language cross-linguistic feature  *(future, user-owned)*
`kind='inter'` links are currently just stored. Decide what to do with them (a cross-language
distinguish mode? surface "false friends"?) and build a consumer that reads `listForUser` filtered to
`kind==='inter'`.

### Open decisions / limitations to revisit
- **Morphological pairs don't trigger.** `isDifferentWordMistake` reads same-root pairs (gato/gata,
  занаятчия/занаятчийка) as near-misses, so they never register as confusions. If you want them caught,
  loosen the detection gate in `engine/confusion.ts: findConfusedSibling` (e.g., also match a sibling
  front even when it's a near-miss, above some distance) — carefully, to avoid false positives.
- **Library scope is `owner_id`.** Cards owned by someone else and shared into your decks aren't in the
  match index. If that matters, switch `cards.listFrontsForUser` to gather via `deck_cards` for the
  user's decks instead of `owner_id`.
- **Distractor injection is best-effort.** `injectForcedDistractor` skips a card whose `choices` aren't
  generated yet. For a hard guarantee, teach `buildOptions` (in `lib/distractors.ts`) to always include
  a linked partner as a distractor by consulting `card_confusion_links` at option-build time.
- **Tag updates on repeat.** `link()` uses `ignoreDuplicates`, so the first confusion's `kind`/`tags`
  win; later confusions of the same pair don't update tags. Fine now; revisit if the practice mode wants
  fresher tags.

## Migrations to apply
`052` (link table — likely already live) and **`083`** (`kind` + `tags` columns).
