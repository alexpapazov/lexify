/**
 * engine/practice.ts — the deterministic half of Practice Mode (see `features/Practice Mode.md`).
 *
 * The design rule this file exists to enforce: **the model proposes, code decides.** Asking an LLM
 * to hard-satisfy "use only these 1000 words" fails — it leaks words, especially inflected ones. So
 * generation returns sentences with per-token lemma annotations, and everything in this file then
 * judges them against the learner's actual library: what share of the sentence they already know,
 * which words they don't, and whether their vocabulary can support the request at all.
 *
 * That inversion is also what makes the "% graduated" slider cheap: it's a SCORE this file computes,
 * not a constraint the model has to nail.
 *
 * Pure: no React, no Supabase, no clock, no network. Callers supply cards, states and annotations.
 */

import type { Card, CardState, PartOfSpeech } from '@/domain'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One token of a generated sentence, as annotated by the generation model and judged here.
 * `text` is the surface form as it appears in the sentence ("précipite"); `lemma` is its citation
 * form ("se précipiter") — matching cards by lemma is the whole point, since a sentence uses
 * inflections the library never stores.
 */
export interface AnnotatedToken {
  text:  string
  lemma: string
  pos:   PartOfSpeech
  /** Articles, prepositions, pronouns, conjunctions — always allowed regardless of the library. */
  isFunctionWord: boolean
}

/** A token after scoring: the same annotation plus this library's verdict on it. */
export interface ScoredToken extends AnnotatedToken {
  /** The lemma exists on some card in the learner's library (graduated or not). */
  inLibrary:  boolean
  /** The lemma exists on a GRADUATED card — what the slider's percentage counts. */
  graduated:  boolean
  /** One of the session's target words. Always allowed, never counted against the score. */
  isTarget:   boolean
  /**
   * True when the token is none of the above: not a function word, not a target, not in the
   * library. These are what the repair pass tries to replace, and what gets rendered in red with a
   * translation if repair can't. */
  flagged:    boolean
}

/** What `scoreSentence` reports back to the generation orchestrator. */
export interface SentenceScore {
  tokens: ScoredToken[]
  /** Content tokens that counted toward the score (excludes function words and targets). */
  countedCount:   number
  /** Of those, how many were graduated. */
  graduatedCount: number
  /**
   * `graduatedCount / countedCount` as a percentage, rounded. A sentence made up entirely of
   * function words and target words has nothing to judge and scores 100 — it satisfies any
   * threshold, which is correct: there is nothing unknown in it.
   */
  graduatedPct:   number
  /** Tokens needing repair (flagged), in sentence order. */
  offenders:      ScoredToken[]
  /** Whether the sentence meets the requested threshold with no unresolved unknown words. */
  passes:         boolean
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

/** A library digested into the lookups scoring needs. Built once per practice session. */
export interface LibraryIndex {
  /** Lemmas of every non-phrase card, lowercased. */
  all:       Set<string>
  /** Lemmas of graduated non-phrase cards (forward direction). */
  graduated: Set<string>
  /** POS → how many GRADUATED cards carry it. Drives the narrow-vocabulary check. */
  graduatedByPos: Map<PartOfSpeech, number>
  /** Graduated cards grouped by POS, for picking helper words and repair candidates. */
  graduatedWords: Map<PartOfSpeech, { lemma: string; front: string }[]>
  /** Cards that carry no label yet — the caller can offer to top them up before generating. */
  unlabeledCount: number
  /**
   * Of those, how many are GRADUATED. This is the number that explains an empty-looking library:
   * a graduated card with no label has no lemma, so it can't match a word or serve as raw material,
   * and coverage reads as though the learner knows nothing. Callers should prompt for labeling
   * before showing a narrow-vocabulary warning, which would otherwise be both alarming and wrong.
   */
  graduatedUnlabeledCount: number
}

// ─── Vocabulary coverage (the narrow-library pre-flight) ──────────────────────

/**
 * Word classes a sentence generator genuinely needs. A library of 1000 nouns and no verbs cannot
 * produce a sentence, and finding that out costs nothing here — no API call, no failed generation.
 */
export const ESSENTIAL_POS: PartOfSpeech[] = ['noun', 'verb', 'adjective']

/**
 * How many graduated cards of an essential class count as "enough to build from". Deliberately
 * small: the generator only needs a handful of real options per class, and the fallback path
 * (simple words from outside the library) covers the rest. Set low so the warning means
 * "genuinely can't", not "could be better".
 */
export const MIN_POS_COUNT = 5

export interface CoverageReport {
  /** 'ok' — generate normally. 'narrow' — warn, and fill gaps with simple non-library words. */
  verdict: 'ok' | 'narrow'
  /** Essential classes below MIN_POS_COUNT, in ESSENTIAL_POS order. Empty when 'ok'. */
  missing: PartOfSpeech[]
  /** Total graduated, non-phrase cards — the pool practice can actually draw on. */
  graduatedCount: number
}

// ─── Building the index ───────────────────────────────────────────────────────

/** A card contributes to the library only if it has a usable single-word label. */
function usableLemma(card: Card): string | null {
  if (!card.pos || card.pos === 'phrase') return null
  const lemma = (card.lemma ?? '').trim().toLowerCase()
  return lemma || null
}

/**
 * Digests the learner's cards into the lookups scoring needs.
 *
 * "Graduated" is read from the FORWARD card state only — the reverse (recognition) row graduates on
 * its own schedule, and production practice should key on whether the learner can PRODUCE the word.
 * Cards with no label yet are counted in `unlabeledCount` and otherwise ignored: an unlabeled card
 * has no lemma, so it can neither match a token nor serve as a helper word.
 */
export function buildLibraryIndex(cards: Card[], forwardStates: CardState[]): LibraryIndex {
  const graduatedCardIds = new Set(
    forwardStates.filter(s => s.reviewDirection !== 'reverse' && s.graduated).map(s => s.cardId),
  )

  const all       = new Set<string>()
  const graduated = new Set<string>()
  const graduatedByPos = new Map<PartOfSpeech, number>()
  const graduatedWords = new Map<PartOfSpeech, { lemma: string; front: string }[]>()
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
    if (!graduatedCardIds.has(card.id)) continue
    // A lemma can appear on several cards (synonyms, duplicates); count and list it once.
    if (graduated.has(lemma)) continue
    graduated.add(lemma)
    graduatedByPos.set(card.pos, (graduatedByPos.get(card.pos) ?? 0) + 1)
    const list = graduatedWords.get(card.pos) ?? []
    list.push({ lemma, front: card.front })
    graduatedWords.set(card.pos, list)
  }

  return { all, graduated, graduatedByPos, graduatedWords, unlabeledCount, graduatedUnlabeledCount }
}

/**
 * Can this library support sentence generation? Checks the essential word classes against
 * MIN_POS_COUNT — the "you have 1000 nouns and no verbs" case, caught before any API call.
 */
export function vocabularyCoverage(index: LibraryIndex): CoverageReport {
  const missing = ESSENTIAL_POS.filter(pos => (index.graduatedByPos.get(pos) ?? 0) < MIN_POS_COUNT)
  return {
    verdict: missing.length > 0 ? 'narrow' : 'ok',
    missing,
    graduatedCount: index.graduated.size,
  }
}

// ─── Helper words for the generation prompt ──────────────────────────────────

/**
 * Picks a POS-balanced sample of graduated words to show the generator as raw material.
 *
 * A SAMPLE, not the library: sending a thousand words costs tokens and measurably *worsens*
 * compliance, and the validator catches leaks anyway. Round-robin across word classes so a
 * noun-heavy library still offers the verbs and adjectives a sentence needs.
 *
 * `seed` rotates the starting offset within each class so repeated generations for the same word
 * don't always draw the same helpers — variety without a random source (this file stays pure).
 */
export function sampleHelperWords(index: LibraryIndex, limit: number, seed = 0): string[] {
  const classes = [...index.graduatedWords.entries()]
    .filter(([, words]) => words.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))          // deterministic order
  if (classes.length === 0 || limit <= 0) return []

  const out: string[] = []
  for (let round = 0; out.length < limit; round++) {
    let addedThisRound = false
    for (const [, words] of classes) {
      if (out.length >= limit) break
      if (round >= words.length) continue
      const word = words[(round + seed) % words.length]!
      if (!out.includes(word.lemma)) { out.push(word.lemma); addedThisRound = true }
    }
    if (!addedThisRound) break                        // every class exhausted
  }
  return out
}

/**
 * Graduated words of a given class, as replacement candidates for a flagged token. Same POS as the
 * offender, so the repaired sentence stays grammatical.
 */
export function repairCandidates(index: LibraryIndex, pos: PartOfSpeech, limit: number): string[] {
  const words = index.graduatedWords.get(pos) ?? []
  return words.slice(0, Math.max(0, limit)).map(w => w.lemma)
}

// ─── Scoring a generated sentence ─────────────────────────────────────────────

/** Word classes that are structural rather than vocabulary — always allowed in a sentence. */
const FUNCTION_POS: PartOfSpeech[] = ['pronoun', 'preposition', 'conjunction', 'determiner', 'numeral']

/** True when a token is structural: either the model said so, or its class is inherently so. */
function isFunctional(token: AnnotatedToken): boolean {
  return token.isFunctionWord || FUNCTION_POS.includes(token.pos)
}

/**
 * Judges one generated sentence against the library.
 *
 * Three kinds of token never count against the learner:
 *   - function words (no library can be expected to contain every article and preposition);
 *   - the session's TARGET words, which are the point of the exercise and may be brand new;
 *   - words the learner has in their library but hasn't graduated — they count as "not graduated"
 *     for the percentage, but they are not FLAGGED, because the learner has genuinely met them.
 *
 * `minGraduatedPct` is the learner's slider. A sentence passes when it clears that bar AND has no
 * flagged (fully unknown) words left.
 */
export function scoreSentence(
  tokens:          AnnotatedToken[],
  index:           LibraryIndex,
  targetLemmas:    string[],
  minGraduatedPct: number,
): SentenceScore {
  const targets = new Set(targetLemmas.map(t => t.trim().toLowerCase()))

  const scored: ScoredToken[] = tokens.map(token => {
    const lemma     = token.lemma.trim().toLowerCase()
    const isTarget  = targets.has(lemma)
    const inLibrary = index.all.has(lemma)
    const graduated = index.graduated.has(lemma)
    const functional = isFunctional(token)
    return {
      ...token,
      inLibrary,
      graduated,
      isTarget,
      flagged: !functional && !isTarget && !inLibrary,
    }
  })

  const counted        = scored.filter(t => !isFunctional(t) && !t.isTarget)
  const graduatedCount = counted.filter(t => t.graduated).length
  // Nothing to judge → 100. A sentence of only function words and target words contains nothing the
  // learner doesn't know, so failing it against any threshold would be wrong.
  const graduatedPct = counted.length === 0
    ? 100
    : Math.round((graduatedCount / counted.length) * 100)
  const offenders = scored.filter(t => t.flagged)

  return {
    tokens: scored,
    countedCount: counted.length,
    graduatedCount,
    graduatedPct,
    offenders,
    passes: offenders.length === 0 && graduatedPct >= minGraduatedPct,
  }
}
