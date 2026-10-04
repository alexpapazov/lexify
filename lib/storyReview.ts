/**
 * lib/storyReview.ts — story mode for due REVERSE reviews: the day's due words woven into short
 * generated stories, read with the target words highlighted. Recognition evidence only, same
 * contract as express matching (and the same credit function): a target you read past untapped
 * earns a reverse-track Good behind the per-story Finish button; tapping one to reveal its
 * meaning writes NOTHING — the card stays due. A story can never lapse or un-graduate a card.
 *
 * Pool = the express pool (due reverse rows, minus relearning, minus ambiguous duplicates) minus
 * FUNCTION WORDS — prepositions, pronouns, determiners, conjunctions appear in every sentence of
 * any prose and are read past without being tested, so they stay in normal review. Everything
 * excluded at any stage simply stays due; nothing is ever lost.
 *
 * Batches keep deck-mates adjacent (decks are thematic, so the model gets a coherent word set),
 * and generation is per batch so reading starts after story one. Wire types + the defensive
 * parser live HERE because the client must never import from app/api/** (the Capacitor trap);
 * the route imports them from this file.
 */

import type { Card, CardState, PartOfSpeech } from '@/domain'
import { buildExpressPool, type ExpressCandidate } from '@/lib/expressReview'
import { primaryGloss } from '@/lib/practiceSchema'
import { displayText } from '@/lib/cardText'
import { stripGrammaticalTags, stripLeadingArticle } from '@/engine/grading'
import type { EnabledTracks } from '@/lib/sessionLimits'

/** Targets per story — big enough to be worth a read, small enough for coherent prose. */
export const STORY_BATCH_SIZE = 40

/** 'target' = the whole passage in the learned language (every word tappable for its meaning);
 *  'native' = the passage in the learner's language with ONLY the target words in the learned one. */
export type StoryPassageMode = 'target' | 'native'

/** POS that reading can't test — the eye glides over them in any sentence. */
const FUNCTION_POS = new Set<PartOfSpeech>(['preposition', 'pronoun', 'determiner', 'conjunction', 'interjection', 'numeral'])

export interface StoryPool {
  pool: ExpressCandidate[]
  /** Dropped as express would: duplicate fronts/backs (coin-flip meaning). */
  skippedAmbiguous: number
  /** Dropped because prose can't test them (see FUNCTION_POS). */
  skippedFunctionWords: number
}

/** The story pool: express pool minus function words. Relearning rows never reach here
 *  (buildExpressPool drops them), so a credit always lands in the schedule branch. */
export function buildStoryPool(
  cards: Card[],
  states: CardState[],
  opts: { source?: string | null; target?: string | null; tracksByPair: Map<string, EnabledTracks>; tz: string; today: string },
): StoryPool {
  const { pool: base, skippedAmbiguous } = buildExpressPool(cards, states, opts)
  const pool = base.filter(({ card }) => !card.pos || !FUNCTION_POS.has(card.pos))
  return { pool, skippedAmbiguous, skippedFunctionWords: base.length - pool.length }
}

/** Split the pool into story batches, keeping deck-mates adjacent (decks are thematic). */
export function batchStories(
  pool: ExpressCandidate[],
  deckIdByCard: Map<string, string>,
  size = STORY_BATCH_SIZE,
): ExpressCandidate[][] {
  const sorted = [...pool].sort((a, b) =>
    (deckIdByCard.get(a.card.id) ?? '').localeCompare(deckIdByCard.get(b.card.id) ?? ''))
  const batches: ExpressCandidate[][] = []
  for (let i = 0; i < sorted.length; i += size) batches.push(sorted.slice(i, i + size))
  return batches
}

// ─── Wire shape (route ↔ client) ───────────────────────────────────────────────

export interface StoryTarget {
  /** The card's front as stored (may carry an article / gender tag). */
  front: string
  /** Citation form the usage report must echo — the card's lemma, else its bare front. */
  lemma: string
  pos:   string
  /** ONE sense (deterministically the first listed translation), as a hint — never a constraint. */
  gloss: string
}

export function storyTargets(batch: ExpressCandidate[]): StoryTarget[] {
  return batch.map(({ card }) => ({
    front: card.front,
    lemma: card.lemma ?? stripLeadingArticle(stripGrammaticalTags(displayText(card.front)), card.sourceLanguage).trim(),
    pos:   card.pos ?? 'word',
    gloss: primaryGloss(card.back),
  }))
}

export interface StoryUsage {
  /** The target's citation form, copied from the request. */
  lemma:   string
  /** The word exactly as the story uses it (inflections allowed). */
  surface: string
}

export interface GeneratedStory {
  title:   string
  story:   string
  usages:  StoryUsage[]
  /** Every word of a target-language story with a short native gloss (tap-a-word); [] in native mode. */
  tokens:  { text: string; gloss: string }[]
}

/** Defensive parse of the model's JSON — null when the story can't be trusted at all.
 *  Malformed usages/tokens are dropped individually; their targets just aren't credited. */
export function parseStory(raw: unknown): GeneratedStory | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const story = typeof r.story === 'string' ? r.story.trim() : ''
  if (!story) return null
  const usages = (Array.isArray(r.usages) ? r.usages : [])
    .map(u => (typeof u === 'object' && u !== null
      && typeof (u as Record<string, unknown>).lemma === 'string'
      && typeof (u as Record<string, unknown>).surface === 'string')
      ? { lemma: ((u as Record<string, unknown>).lemma as string).trim().toLowerCase(), surface: ((u as Record<string, unknown>).surface as string).trim() }
      : null)
    .filter((u): u is StoryUsage => u !== null && u.surface.length > 0)
  const tokens = (Array.isArray(r.tokens) ? r.tokens : [])
    .map(t => (typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>).text === 'string')
      ? { text: ((t as Record<string, unknown>).text as string).trim(), gloss: typeof (t as Record<string, unknown>).gloss === 'string' ? ((t as Record<string, unknown>).gloss as string).trim() : '' }
      : null)
    .filter((t): t is { text: string; gloss: string } => t !== null && t.text.length > 0)
  return { title: typeof r.title === 'string' ? r.title.trim() : '', story, usages, tokens }
}

// ─── Locating targets in the story text ────────────────────────────────────────

export interface TargetSpan {
  cardId:  string
  start:   number
  /** Exclusive end — the span covers the WHOLE word around the match. */
  end:     number
  surface: string
}

/** Lowercased, apostrophe-unified copy for searching — same length, or null when a locale case
 *  mapping changes the length (indices couldn't be trusted then). Mirrors lib/reviewCloze. */
function searchable(s: string): string | null {
  const lowered = s.replace(/[’ʼ]/g, "'").toLowerCase()
  return lowered.length === s.length ? lowered : null
}

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{M}]/u.test(ch)

/**
 * Finds each batch target in the story, via the model's reported surface (preferred) or the
 * card's bare front. Whole-word expansion (the "озаглавен"-inside-"озаглавена" lesson from
 * cloze); every position is claimed at most once, longest surfaces first, so two targets can't
 * share a span. Targets that can't be located are simply absent — they stay due, never credited.
 */
export function locateTargets(story: string, usages: StoryUsage[], batch: ExpressCandidate[]): TargetSpan[] {
  const hay = searchable(story) ?? story.toLowerCase()
  const surfaceFor = new Map<string, string>()
  for (const u of usages) surfaceFor.set(u.lemma, u.surface)

  const wanted = batch.map(({ card }) => {
    const lemma = (card.lemma ?? stripLeadingArticle(stripGrammaticalTags(displayText(card.front)), card.sourceLanguage)).trim().toLowerCase()
    const bare = stripLeadingArticle(stripGrammaticalTags(displayText(card.front)), card.sourceLanguage).trim()
    return { cardId: card.id, needle: (surfaceFor.get(lemma) ?? bare).trim() }
  }).filter(w => w.needle.length > 0)
  // Longest needles first, so "la educación física" claims its span before "la física" could.
  wanted.sort((a, b) => b.needle.length - a.needle.length)

  const claimed: Array<[number, number]> = []
  const overlaps = (s: number, e: number) => claimed.some(([cs, ce]) => s < ce && e > cs)
  const spans: TargetSpan[] = []
  for (const w of wanted) {
    const key = searchable(w.needle) ?? w.needle.toLowerCase()
    let from = 0
    while (from <= hay.length - key.length) {
      const at = hay.indexOf(key, from)
      if (at < 0) break
      let start = at, end = at + key.length
      while (isWordChar(story[start - 1])) start--
      while (isWordChar(story[end])) end++
      if (!overlaps(start, end)) {
        claimed.push([start, end])
        spans.push({ cardId: w.cardId, start, end, surface: story.slice(start, end) })
        break
      }
      from = at + 1
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}
