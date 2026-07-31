# Card Connection Agent — design notes (PINNED, not built)

> **STATUS: designed 2026-07-30, PAUSED before implementation.** Nothing in this document is built.
> The infrastructure audit in §1 is the valuable part — it found one real bug that is worth fixing
> whether or not the agent is ever built. Resume by answering the open questions in §4.

An agent that walks a library and proposes **connections between cards** — synonym-group membership
and confusion links — rather than editing card text. Sits alongside the card-editor agent in the
agents tab.

---

## 1. Infrastructure audit (done — this is the part worth keeping)

The user's requirement: synonym links are symmetric AND transitive (A≡B plus C joining ⇒ one group
{A,B,C}); confusion links are symmetric but NOT transitive (A↔B and B↔C never imply A↔C).

### Confusion links — already correct, no change needed ✓

`card_confusion_links` stores ONE row per pair with `[a,b].sort()` normalisation and a unique
constraint on `(user_id, card_a_id, card_b_id)`; reads go through
`.or(card_a_id.eq.X, card_b_id.eq.X)`. There is no direction a caller could get wrong — symmetry is
structural. And nothing groups links: A↔B and B↔C are two independent rows and no A↔C is inferred.

*Caveat worth remembering:* `interleaveConfusablePairs` (engine/confusion.ts) DOES walk connected
components so A-B-C cluster together in a session queue. That is presentation only — the stored links
stay strictly pairwise. Don't "fix" it.

### Synonym groups — symmetric and transitive by construction, but MERGING IS BROKEN ✗

A card carries a single `cards.synonym_group_id` FK, so membership *is* the relation: "A adds B" and
"B adds A" are the same fact, and adding C to the group really does produce {A,B,C}.

**The bug:** `SupabaseSynonymGroupRepository.addMember(groupId, cardId)` (→ the
`link_card_to_synonym_group` RPC, migration 037) sets ONE card's `synonym_group_id`. It cannot merge
two groups. So if A is in G1 with X, and B is in G2 with Y, declaring A≡B moves only B into G1 — **Y
is stranded in G2** and the equivalence class {A,X,B,Y} never forms. `autoGroupByGloss` has the same
shape: it picks `members.find(c => c.synonymGroupId)` (the first group it happens to see) and
reassigns the other cards individually.

**The fix (do this regardless of the agent):**
- Add `mergeGroups(intoGroupId, fromGroupId)` — reassign every member of the smaller group, then
  delete the emptied `synonym_groups` row. Union-find semantics.
- Add a `linkAsSynonyms(cardA, cardB)` entry point that resolves the three cases: neither in a group
  (create one), one in a group (add the other), both in different groups (**merge**).
- Route `autoGroupByGloss` through it.
- `removeMember` can leave a 1-member group; a group with fewer than 2 members should be deleted.

**Also missing:** there is no `addSynonym` gateway op at all. `features/Agent Platform.md` lists it as
planned and `ChangeField` in `domain/index.ts` has a `'synonyms'` value, but nothing emits or applies
one. Any connection agent needs new gateway ops (`link_synonyms`, `link_confusion`) plus matching
`applyProposal` branches in `lib/agents/cardEditor.ts`.

## 2. Proposed design

**Candidate generation is deterministic and local; the AI only judges a shortlist.** All-pairs on a
1000-card library is 500k comparisons — it cannot be handed to a model.

- **Synonym candidates:** same language pair, backs that share a content word or are string-close.
  (Exact-normalised gloss matches are already auto-grouped at create time by `autoGroupByGloss`; the
  agent's value is near-matches like "to begin" / "to start".)
- **Confusion candidates:** same LEARNED language, fronts orthographically close — reuse
  `editRatio >= 0.6` from `engine/confusion.ts`, the same threshold that already tags a link
  'phonetic'. Skip pairs already linked.
- Prefilter by length delta / first-letter bucket before running `editRatio`, or the O(n²) sweep
  becomes seconds of main-thread work on a phone.

**UI:** an agent switcher at the top of `app/agents/page.tsx` (Card editor · Card connections),
reusing the existing scope tree and one-at-a-time approve/deny flow. The proposal card renders the
two cards being connected instead of a text diff.

## 3. Defaults chosen (unless the user says otherwise)

- Proposes **additions only** — no un-grouping or unlinking (destructive, and a much bigger agent).
- **Sets `semantic` tags** on confusion links it creates. `classifyIntraTags` computes 'phonetic' and
  'temporal' deterministically and explicitly leaves 'semantic' to "a future AI/embedding tagger" —
  this agent is that tagger.
- **One endpoint in scope, the other anywhere in the same learned language.** Confusion links are
  cross-deck by nature; requiring both ends in scope would make a single-deck selection useless.
- **Intra-language only.** `inter` links (Spanish *burro* vs Italian *burro*) are stored but carry no
  scheduling penalty, so they're low value for a first pass.

## 4. Open questions to resume on

1. Is deterministic shortlisting + AI judging the right shape, or should the AI read whole decks and
   free-associate (more thorough, much more expensive, prone to drift)?
2. Should it also propose REMOVING wrong connections ("whether cards are synonyms **or not**")?
3. Confirm the four defaults in §3.
4. Review UX for volume: a big library could produce hundreds of proposals. Keep one-at-a-time, or add
   batch-approve?

## 5. Prior art in the codebase to reuse

| Piece | Where |
|---|---|
| Orthographic similarity + tag classification | `engine/confusion.ts` (`editRatio`, `classifyIntraTags`, `normalizeForMatch`) |
| Existing agent scope tree + approve/deny loop | `app/agents/page.tsx` |
| Scoped/audited mutation path | `lib/agents/gateway.ts`, `lib/agents/cardEditor.ts` |
| Gloss-based auto-grouping (and the merge bug) | `lib/data/synonymGroups.ts: autoGroupByGloss` |
| Link storage | `lib/data/cardConfusionLinks.ts` |
