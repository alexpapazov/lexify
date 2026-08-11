/**
 * lib/agents/cardOrganizer.ts — the card-organizer agent's brains.
 *
 * Two ways to say where a card belongs:
 *
 *   1. **Word documents** (the deterministic path, NO AI). A `.docx` whose headings describe a
 *      folder tree and whose lines are words is already parsed by `lib/docx.ts` for batch import.
 *      Here the SAME plan is read as a destination map — "wherever this word appears in the
 *      document, that's the folder/deck it should live in" — and every scoped card is matched
 *      against it by front. Cards already in the right place produce no move.
 *
 *   2. **Natural language** ("put all the food words in Food/Ingredients"). The model only ever
 *      chooses a DESTINATION PATH per card; it never touches card text and never invents an id.
 *
 * **They combine.** With documents AND an instruction, the documents are authoritative for every
 * word they list — a deliberate placement must never be second-guessed by a model — and the
 * instruction governs the LEFTOVERS, with the document's own folder/deck names offered as
 * destinations so "put the rest where they fit" lands inside the structure you just described.
 *
 * Both paths converge on the same `MoveProposal[]`, which the review UI approves one by one and
 * `applyMove` executes. Nothing here writes; nothing is applied without approval.
 *
 * The move itself is a **deck_cards relink**, not a card rewrite: a card is linked to decks, so
 * "organize" means unlink from the old deck and link into the destination (creating folders and the
 * deck if the plan calls for them). A card SHARED into several decks keeps its other links — only
 * the link in the scoped deck moves, so organizing one language can't strip a card out of another.
 */

import { apiUrl } from '@/lib/apiBase'
import type { DeckPlan, PlannedDeck } from '@/lib/docx'
import { normalizeFrontKey } from '@/lib/duplicates'
import type { ScopedCard } from './cardEditor'

/** Where a card should end up: folder names from the library root, then the deck name. */
export interface Destination {
  /** Folder names root → deepest. Empty = the deck sits at the library root. */
  path: string[]
  /** Deck name inside that folder. */
  deck: string
}

export interface MoveProposal extends ScopedCard {
  /** Stable id for UI state that must survive queue shuffling. */
  id: string
  /** Deck the card is in now (the link that will be moved). */
  fromDeckName: string
  to: Destination
  reason: string
}

export const destinationKey = (d: Destination): string => [...d.path, d.deck].join(' / ')

/** True when a card already sits where `to` says it should — nothing to propose. */
export function alreadyThere(card: ScopedCard, to: Destination, deckPathOf: (deckId: string) => string[]): boolean {
  const current = deckPathOf(card.deckId)          // [...folders, deckName]
  const target  = [...to.path, to.deck]
  if (current.length !== target.length) return false
  return current.every((seg, i) => seg.trim().toLowerCase() === target[i]!.trim().toLowerCase())
}

/**
 * Word-document path: build `front key → destination` from a parsed deck plan.
 *
 * A word listed under several headings is ambiguous, so the FIRST occurrence wins and the rest are
 * reported — silently picking the last one would quietly undo an earlier deliberate placement.
 */
export function destinationsFromPlan(
  plan: DeckPlan,
  language = '',
): { byFront: Map<string, Destination>; duplicates: string[] } {
  const byFront = new Map<string, Destination>()
  const duplicates: string[] = []
  for (const deck of plan.decks) {
    const to: Destination = { path: deck.path, deck: deck.name }
    for (const card of deck.cards) {
      const key = normalizeFrontKey(card.front, language)
      if (!key) continue
      if (byFront.has(key)) { duplicates.push(card.front); continue }
      byFront.set(key, to)
    }
  }
  return { byFront, duplicates }
}

/**
 * Word-document path: one proposal per scoped card whose word appears in the document somewhere
 * OTHER than where the card currently lives.
 *
 * Cards absent from the document are left ALONE — a document describes where the words it lists
 * belong, and says nothing about the rest. Sweeping unlisted cards into some "other" bucket would
 * be a destructive reading of an instruction the user never gave.
 */
export function planMovesFromDocument(
  cards: ScopedCard[],
  plan: DeckPlan,
  deckPathOf: (deckId: string) => string[],
): { moves: MoveProposal[]; unmatched: ScopedCard[]; duplicates: string[] } {
  // Article stripping is per-language; the scope is one pair in practice, so the first card's
  // language keys the whole document. An empty language still normalizes case/tags/whitespace.
  const { byFront, duplicates } = destinationsFromPlan(plan, cards[0]?.sourceLanguage ?? '')
  const moves: MoveProposal[] = []
  const unmatched: ScopedCard[] = []
  for (const c of cards) {
    const to = byFront.get(normalizeFrontKey(c.front, c.sourceLanguage ?? ''))
    if (!to) { unmatched.push(c); continue }
    if (alreadyThere(c, to, deckPathOf)) continue
    moves.push({
      ...c,
      id: `doc:${c.deckId}:${c.cardId}`,
      fromDeckName: deckPathOf(c.deckId).join(' / ') || (c.deckName ?? ''),
      to,
      reason: `Listed under “${destinationKey(to)}” in the document.`,
    })
  }
  return { moves, unmatched, duplicates }
}

/**
 * Natural-language path: turn the model's `{cardId, path}` answers into proposals.
 *
 * Everything is validated against the LOCAL card list — an id the model invented, or a card outside
 * the scope, is dropped rather than trusted. An empty path is dropped too: "leave it where it is"
 * must be expressed by saying nothing about the card, never by proposing a move to nowhere.
 */
export function planMovesFromAssignments(
  cards: ScopedCard[],
  assignments: { cardId: string; path: string[]; reason?: string }[],
  deckPathOf: (deckId: string) => string[],
): MoveProposal[] {
  const byId = new Map(cards.map(c => [c.cardId, c]))
  const out: MoveProposal[] = []
  for (const a of assignments) {
    const card = byId.get(a.cardId)
    if (!card) continue
    const segments = (a.path ?? []).map(s => s.trim()).filter(Boolean)
    if (segments.length === 0) continue
    const to: Destination = { path: segments.slice(0, -1), deck: segments[segments.length - 1]! }
    if (alreadyThere(card, to, deckPathOf)) continue
    out.push({
      ...card,
      id: `ai:${card.deckId}:${card.cardId}`,
      fromDeckName: deckPathOf(card.deckId).join(' / ') || (card.deckName ?? ''),
      to,
      reason: a.reason?.trim() || `Belongs under “${destinationKey(to)}”.`,
    })
  }
  return out
}

/**
 * Groups proposals by destination — how the review UI shows them, since approving a whole
 * destination at once is the natural unit ("yes, all 14 of these are food words").
 */
export function groupByDestination(moves: MoveProposal[]): { to: Destination; key: string; moves: MoveProposal[] }[] {
  const groups = new Map<string, { to: Destination; key: string; moves: MoveProposal[] }>()
  for (const m of moves) {
    const key = destinationKey(m.to)
    const g = groups.get(key)
    if (g) g.moves.push(m)
    else groups.set(key, { to: m.to, key, moves: [m] })
  }
  return [...groups.values()]
}

/** Every distinct destination a plan would create, for the "what this will build" preview. */
export function plannedTree(plan: DeckPlan): PlannedDeck[] {
  return plan.decks
}

/**
 * The folder/deck paths a document describes, as the review UI and the model see them.
 *
 * Handed to the AI pass alongside the library's existing paths when an instruction accompanies
 * documents: the leftovers should land in the structure the document just defined, not in a parallel
 * tree the model invented for them.
 */
export function pathsFromPlan(plan: DeckPlan): string[] {
  return [...new Set(plan.decks.map(d => [...d.path, d.name].join(' / ')))]
}

// ─── AI path: one batch → destination assignments ────────────────────────────

/**
 * Asks the organizer route where each card in `batch` belongs. `existingPaths` is the library's
 * current folder/deck paths — passing them is what stops the model inventing "Foods" beside "Food".
 *
 * Every returned assignment is re-validated locally by `planMovesFromAssignments`.
 */
export async function assignBatch(
  batch: ScopedCard[],
  task: string,
  existingPaths: string[],
  deckPathOf: (deckId: string) => string[],
  /** True when these are the cards a Word document didn't place — changes how the model is framed. */
  leftovers = false,
): Promise<MoveProposal[]> {
  const res = await fetch(apiUrl('/api/agents/card-organizer'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      task, existingPaths, leftovers,
      cards: batch.map(c => ({
        cardId: c.cardId, front: c.front, back: c.back,
        currentPath: deckPathOf(c.deckId).join(' / '),
      })),
    }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' — '))
  return planMovesFromAssignments(batch, data.assignments ?? [], deckPathOf)
}
