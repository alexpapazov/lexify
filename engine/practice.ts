/**
 * engine/practice.ts — the deterministic half of Practice Mode (see `features/Practice Mode.md`).
 *
 * What lives here: which cards are DRILLABLE (the single gate every selection source shares), and
 * the library digested into the lookups practice needs — matching a sentence's words back to the
 * learner's own cards, and knowing which cards still need labeling.
 *
 * What deliberately does NOT live here anymore: sentence scoring. Practice once steered generation
 * toward known words (score → repair → verify), which was slow — three model round-trips per batch —
 * and produced stilted sentences. Sentences are natural and unconstrained now; the library's job is
 * to annotate them (click a word → your card), not to censor them.
 *
 * Pure: no React, no Supabase, no clock, no network. Callers supply cards, states and annotations.
 */

import type { Card, CardState, PartOfSpeech } from '@/domain'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One token of a generated sentence, as annotated by the generation model.
 * `text` is the surface form as it appears in the sentence ("précipite"); `lemma` is its citation
 * form ("se précipiter") — matching cards by lemma is the whole point, since a sentence uses
 * inflections the library never stores.
 */
export interface AnnotatedToken {
  text:  string
  lemma: string
  pos:   PartOfSpeech
  /** Articles, prepositions, pronouns, conjunctions — grammatical rather than vocabulary. */
  isFunctionWord: boolean
}

/** One word the learner has chosen to drill, with everything the generator needs to use it. */
export interface PracticeTarget {
  cardId: string
  front:  string
  back:   string
  lemma:  string
  pos:    PartOfSpeech
}

/**
 * Word classes that read badly as a cloze answer — you'd be guessing "the" from context rather than
 * recalling vocabulary. Excluded from drilling everywhere, whichever way the card was selected.
 */
export const UNDRILLABLE_POS: PartOfSpeech[] = ['determiner', 'pronoun', 'conjunction', 'preposition']

/** Why a card can't be drilled, or null when it can. Every selection source reports through this. */
export type TargetRejection = 'unlabeled' | 'undrillable'

/**
 * The single gate every selection source passes through, so a card can never be drillable via one
 * route and not another. A card needs a real label (a phrase has no single citation form) and a
 * word class worth blanking out.
 */
export function targetRejection(card: Card): TargetRejection | null {
  // ORDER MATTERS. A phrase card IS labeled — the labeler deliberately gives it `lemma: null`
  // because a free phrase has no citation form. Testing the lemma first would report it as
  // unlabeled and send the learner off to re-run labeling that would change nothing.
  if (!card.pos) return 'unlabeled'
  if (card.pos === 'phrase' || UNDRILLABLE_POS.includes(card.pos)) return 'undrillable'
  // A content word with no lemma never got a usable label, whatever `pos` claims.
  if (!(card.lemma ?? '').trim()) return 'unlabeled'
  return null
}

/** Cards → drillable targets, dropping anything the gate rejects. */
export function toPracticeTargets(cards: Card[]): PracticeTarget[] {
  return cards
    .filter(c => targetRejection(c) === null)
    .map(c => ({
      cardId: c.id,
      front:  c.front,
      back:   c.back,
      lemma:  c.lemma!.trim(),
      pos:    c.pos!,
    }))
}

// ─── The library index ────────────────────────────────────────────────────────

/** A library digested into the lookups practice needs. Built once per practice session. */
export interface LibraryIndex {
  /** Lemmas of every non-phrase card, lowercased. */
  all:       Set<string>
  /** Lemmas of graduated non-phrase cards (forward direction). */
  graduated: Set<string>
  /** Cards that carry no label yet — the caller can offer to top them up before generating. */
  unlabeledCount: number
  /**
   * Of those, how many are GRADUATED. This is the number that explains an empty-looking library:
   * a graduated card with no label has no lemma, so it can't match a word, and the library reads
   * as though the learner knows nothing.
   */
  graduatedUnlabeledCount: number
}

/** A card contributes to the library only if it has a usable single-word label. */
function usableLemma(card: Card): string | null {
  if (!card.pos || card.pos === 'phrase') return null
  const lemma = (card.lemma ?? '').trim().toLowerCase()
  return lemma || null
}

/**
 * Digests the learner's cards into the lookups practice needs.
 *
 * "Graduated" is read from the FORWARD card state only — the reverse (recognition) row graduates on
 * its own schedule, and production practice should key on whether the learner can PRODUCE the word.
 * Cards with no label yet are counted in `unlabeledCount` and otherwise ignored: an unlabeled card
 * has no lemma, so it can't match a token.
 */
export function buildLibraryIndex(cards: Card[], forwardStates: CardState[]): LibraryIndex {
  const graduatedCardIds = new Set(
    forwardStates.filter(s => s.reviewDirection !== 'reverse' && s.graduated).map(s => s.cardId),
  )

  const all       = new Set<string>()
  const graduated = new Set<string>()
  let unlabeledCount = 0
  let graduatedUnlabeledCount = 0

  for (const card of cards) {
    if (!card.pos) {
      unlabeledCount++
      if (graduatedCardIds.has(card.id)) graduatedUnlabeledCount++
      continue
    }
    const lemma = usableLemma(card)
    if (!lemma) continue        // labeled as a phrase — real, just not a vocabulary word
    all.add(lemma)
    if (graduatedCardIds.has(card.id)) graduated.add(lemma)
  }

  return { all, graduated, unlabeledCount, graduatedUnlabeledCount }
}
