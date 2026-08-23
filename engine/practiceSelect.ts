/**
 * engine/practiceSelect.ts — choosing which words a practice session drills.
 *
 * "Pick words" turned out to mean six different things: these specific words, this deck, this
 * folder, whatever's due soon, whatever I keep getting wrong, or a list I paste in. Each is a
 * `TargetSource`; they COMPOSE, so "this deck plus these three pasted words" is one session.
 *
 * Two rules hold across every source:
 *
 *   1. **One gate.** Every candidate passes `targetRejection` from `engine/practice.ts`, so a card
 *      can never be drillable via one route and not another.
 *   2. **Nothing disappears silently.** A source reports what it dropped and why. A picker that
 *      quietly returns 12 words when you selected a 400-card deck is how you end up debugging the
 *      wrong thing — the unlabeled-graduated-cards bug taught that lesson once already.
 *
 * Pure: no React, no Supabase, no clock. The caller supplies the cards, states and "today".
 */

import { targetRejection, toPracticeTargets, type PracticeTarget } from './practice'
import type { Card, CardState } from '@/domain'

// ─── Sources ──────────────────────────────────────────────────────────────────

export type TargetSource =
  /** Exactly these cards — the hand-picked list. Never capped; the choice was explicit. */
  | { type: 'manual';     cardIds: string[] }
  /**
   * Every card in these decks. Folders are selected by checking their decks — the scope tree
   * (`lib/scopeTree.ts`) already knows every deck beneath a folder, so expanding here too would be
   * the same logic in two places.
   */
  | { type: 'decks';      deckIds: string[] }
  /** Graduated cards falling due within `withinDays` (overdue included). */
  | { type: 'due';        withinDays: number }
  /** The `limit` hardest graduated cards, by FSRS difficulty. */
  | { type: 'difficulty'; limit: number }
  /**
   * A RANDOM sample of up to `limit` graduated cards whose FSRS difficulty falls in [min, max]
   * (1–10). Random rather than hardest-first so repeated sessions over the same band don't drill
   * the same handful of words; `seed` makes each draw reproducible, and bumping it re-rolls.
   */
  | { type: 'difficultyRange'; min: number; max: number; limit: number; seed: number }
  /** Every card the learner starred (migration 112) — an explicit choice, so never capped. */
  | { type: 'starred' }
  /** Free text — one word per line or comma-separated — matched against the library. */
  | { type: 'list';       text: string }

/** Everything the resolvers read. Assembled by the caller; all of it is plain data. */
export interface SelectionContext {
  /** Every card of the language pair, labeled or not (rejections are counted, not hidden). */
  cards: Card[]
  /** Forward card states by card id — graduation, difficulty, lapses and due date live here. */
  statesByCard: Map<string, CardState>
  /** Deck id → the card ids in it. Only needed for the `decks` source. */
  cardIdsByDeck: Map<string, string[]>
  /** Today as `YYYY-MM-DD`, turnover-aware — the caller passes `getToday(tz, turnover)`. */
  today: string
  /**
   * ISO timestamp → that moment's LOCAL calendar day (`YYYY-MM-DD`). Injected because this module
   * has no timezone; without it a due time of 23:00 UTC lands on the wrong day for most learners.
   * Defaults to the UTC day when absent.
   */
  localDayOf?: (iso: string) => string
  /**
   * Card id → the REVERSE row's due date (`recallDueAt ?? dueAt`), for cards that have one. The
   * `due` source treats a word as due when ANY of its reviews is — production, recall, or
   * recognition — and reverse rows live outside `statesByCard` (which is forward rows only).
   */
  reverseDueByCard?: Map<string, string>
  /**
   * Normalizes a written word to the library's match key. Injected rather than imported so this
   * module stays dependency-free; the caller passes `normalizeFrontKey(text, sourceLanguage)`, the
   * same key duplicate detection uses, so "el pan" finds the card whose front is "pan".
   */
  normalizeKey: (text: string) => string
}

export interface SelectionResult {
  /** The drillable words, deduped across sources, in the order the sources produced them. */
  targets: PracticeTarget[]
  /** Cards a source matched but which carry no usable label yet. */
  droppedUnlabeled: number
  /** Cards a source matched but whose word class isn't worth blanking (phrases, articles…). */
  droppedUndrillable: number
  /** `list` only: lines that matched nothing in the library. */
  unmatched: string[]
  /** Sources that hit `capPerSource`, by source type — the UI says so rather than quietly truncating. */
  capped: TargetSource['type'][]
}

/**
 * Default ceiling per bulk source. A 400-card deck should not silently become a 400-word session:
 * generation is one API call per handful of sentences, and nobody drills 400 words in a sitting.
 * Manual and pasted lists are exempt — those choices were explicit.
 */
export const DEFAULT_CAP_PER_SOURCE = 50

// ─── Small pure helpers ───────────────────────────────────────────────────────

/** `YYYY-MM-DD` plus N days. Date-only arithmetic in UTC, so no timezone can shift it. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Splits pasted text into candidate words: one per line, commas and semicolons also separate. */
export function splitList(text: string): string[] {
  return text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
}

/** The bounds FSRS keeps difficulty inside (see `clampD` in engine/fsrs.ts). */
export const MIN_DIFFICULTY = 1
export const MAX_DIFFICULTY = 10

/**
 * Deterministic shuffle. The engine has no clock and no `Math.random`, so randomness is SEEDED:
 * the same seed always yields the same draw, which is what makes the random-sample source testable
 * and lets the UI offer a "shuffle" button that visibly re-rolls.
 *
 * mulberry32 — small, fast, good enough for picking practice words.
 */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  let state = (seed >>> 0) || 1
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/** Card ids a single source matches, BEFORE the drillable gate. Order is the session order. */
function matchedCardIds(source: TargetSource, ctx: SelectionContext, byId: Map<string, Card>): {
  ids: string[]
  unmatched: string[]
} {
  switch (source.type) {
    case 'manual':
      return { ids: source.cardIds.filter(id => byId.has(id)), unmatched: [] }

    case 'decks': {
      const ids: string[] = []
      for (const deckId of source.deckIds) {
        for (const cardId of ctx.cardIdsByDeck.get(deckId) ?? []) ids.push(cardId)
      }
      return { ids, unmatched: [] }
    }

    case 'due': {
      // Overdue counts as due — no lower bound. Compared at LOCAL date level, matching how the rest
      // of the app decides what "today" contains.
      //
      // A word is due when ANY of its reviews is: the production lane (`smartDueAt ?? typedDueAt ??
      // dueAt`), forward recall (`recallDueAt`), or the reverse row's recognition (injected via
      // `reverseDueByCard`). Reading `dueAt` alone was the same drift `lib/dueStatus.ts` exists to
      // prevent — a card whose production review just pushed `dueAt` into the future was invisible
      // here even though its recall was due today.
      const localDay = ctx.localDayOf ?? ((iso: string) => iso.slice(0, 10))
      const horizon = addDays(ctx.today, Math.max(0, source.withinDays))
      const earliestDue = (s: CardState): string | null => {
        const dates = [s.smartDueAt ?? s.typedDueAt ?? s.dueAt, s.recallDueAt,
          ctx.reverseDueByCard?.get(s.cardId)].filter((d): d is string => !!d)
        if (dates.length === 0) return null
        return dates.reduce((a, b) => (a < b ? a : b))
      }
      const rows = [...ctx.statesByCard.values()]
        .flatMap(s => {
          if (!s.graduated || s.dormant || !byId.has(s.cardId)) return []
          const due = earliestDue(s)
          return due && localDay(due) <= horizon ? [{ cardId: s.cardId, due }] : []
        })
        .sort((a, b) => a.due.localeCompare(b.due))   // soonest first
      return { ids: rows.map(r => r.cardId), unmatched: [] }
    }

    case 'difficulty': {
      // FSRS difficulty, hardest first, lapses as the tie-break. Only graduated cards have a
      // meaningful difficulty; an unrated one would otherwise masquerade as easy.
      const rows = [...ctx.statesByCard.values()]
        .filter(s => s.graduated && s.difficulty != null && byId.has(s.cardId))
        .sort((a, b) =>
          (b.difficulty! - a.difficulty!) ||
          (b.lapses - a.lapses) ||
          a.cardId.localeCompare(b.cardId))          // deterministic
      return { ids: rows.slice(0, Math.max(0, source.limit)).map(s => s.cardId), unmatched: [] }
    }

    case 'difficultyRange': {
      const lo = Math.min(source.min, source.max)
      const hi = Math.max(source.min, source.max)
      // Sort before shuffling: the seeded draw must not depend on Map iteration order, or the
      // "same seed, same words" promise quietly breaks when the library is reloaded.
      const inBand = [...ctx.statesByCard.values()]
        .filter(s =>
          s.graduated && s.difficulty != null &&
          s.difficulty >= lo && s.difficulty <= hi &&
          byId.has(s.cardId))
        .sort((a, b) => a.cardId.localeCompare(b.cardId))
      const drawn = seededShuffle(inBand, source.seed).slice(0, Math.max(0, source.limit))
      return { ids: drawn.map(s => s.cardId), unmatched: [] }
    }

    case 'starred':
      return { ids: ctx.cards.filter(c => c.starred).map(c => c.id), unmatched: [] }

    case 'list': {
      // Build the lookup lazily — only this source needs it.
      const byKey = new Map<string, string>()
      for (const card of ctx.cards) {
        const key = ctx.normalizeKey(card.front)
        if (key && !byKey.has(key)) byKey.set(key, card.id)
      }
      const ids: string[] = []
      const unmatched: string[] = []
      for (const line of splitList(source.text)) {
        const id = byKey.get(ctx.normalizeKey(line))
        if (id) ids.push(id)
        else unmatched.push(line)
      }
      return { ids, unmatched }
    }
  }
}

/**
 * Sources a cap applies to — the ones that can balloon. Exempt: `manual` and `list` (explicit
 * choices), and the two difficulty sources (they carry their own `limit`).
 */
function isCapped(type: TargetSource['type']): boolean {
  // Only `decks` is capped: a whole-deck selection can be thousands of cards picked with one click.
  // `due` is deliberately NOT capped — "everything due today" is a complete answer or it is wrong,
  // and the session-size decision belongs to the sentence plan, not the picker.
  return type === 'decks'
}

/**
 * Resolves every source into one deduped target list.
 *
 * Order is source order, then match order within a source (deck order, soonest-due, hardest-first,
 * pasted order) — so a session reads the way the learner assembled it. The cap is applied per
 * source AFTER the drillable gate, so a deck full of unlabeled cards doesn't burn the allowance on
 * words that were never going to make it.
 */
export function resolveTargets(
  sources: TargetSource[],
  ctx: SelectionContext,
  capPerSource: number = DEFAULT_CAP_PER_SOURCE,
): SelectionResult {
  const byId = new Map(ctx.cards.map(c => [c.id, c]))
  const targetByCardId = new Map(toPracticeTargets(ctx.cards).map(t => [t.cardId, t]))

  const seen = new Set<string>()
  const targets: PracticeTarget[] = []
  const unmatched: string[] = []
  const capped: TargetSource['type'][] = []
  let droppedUnlabeled = 0
  let droppedUndrillable = 0

  for (const source of sources) {
    const match = matchedCardIds(source, ctx, byId)
    unmatched.push(...match.unmatched)

    let takenFromSource = 0
    let hitCap = false
    for (const cardId of match.ids) {
      if (seen.has(cardId)) continue          // already contributed by an earlier source
      const card = byId.get(cardId)
      if (!card) continue

      const rejection = targetRejection(card)
      if (rejection === 'unlabeled')   { seen.add(cardId); droppedUnlabeled++;   continue }
      if (rejection === 'undrillable') { seen.add(cardId); droppedUndrillable++; continue }

      if (isCapped(source.type) && takenFromSource >= capPerSource) { hitCap = true; break }
      const target = targetByCardId.get(cardId)
      if (!target) continue                   // unreachable: the gate just passed it
      seen.add(cardId)
      targets.push(target)
      takenFromSource++
    }
    if (hitCap) capped.push(source.type)
  }

  return { targets, droppedUnlabeled, droppedUndrillable, unmatched, capped }
}
