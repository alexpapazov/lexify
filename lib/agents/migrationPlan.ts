/**
 * lib/agents/migrationPlan.ts — the card organizer's migration plan: types, deterministic
 * diagnostics, ordering and validation. Pure; no React, no Supabase.
 *
 * The organizer used to answer "where does each card go?" one batch at a time. It now works the way
 * a person would: read the whole library, read the instruction and the documents, then write a PLAN
 * — an ordered list of moves that ends with the library exactly as described. The user sees the plan
 * before anything happens, approves once, and it runs end to end.
 *
 * **The instruction is ground truth; documents are supporting evidence.** The instruction says how
 * to read the documents (follow them literally, or use them as a source of grouping). That ordering
 * is stated in the planner prompt and is why the two inputs are never merged into one blob.
 *
 * Everything a model can get wrong that a computation can get right is done here instead: which
 * words are duplicated, which are missing, which live outside the selected scope. The model plans;
 * it does not audit.
 */

import { normalizeFrontKey } from '@/lib/duplicates'

// ─── Steps ───────────────────────────────────────────────────────────────────

/**
 * A path is folder names from the library root, deepest last. A DECK path's last element is the deck
 * name; a FOLDER path's last element is the folder itself.
 */
export type LibraryPath = string[]

export type MigrationStep =
  | { kind: 'createFolder'; path: LibraryPath; reason: string }
  | { kind: 'moveFolder';   folderId: string; folderName: string; toParent: LibraryPath; reason: string }
  | { kind: 'moveDeck';     deckId: string;   deckName: string;   toFolder: LibraryPath; reason: string }
  | {
      kind: 'moveCard'; cardId: string; front: string; back: string
      fromDeckId: string; fromDeckName: string
      /** Destination deck path: folders then the deck name. */
      toDeck: LibraryPath
      /** True when the card lives OUTSIDE the selected scope and the plan wants to pull it in. */
      pullIn?: boolean
      reason: string
    }

export interface MigrationPlan {
  /** One paragraph, in the model's words, of what this migration does overall. */
  summary: string
  steps:   MigrationStep[]
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export type DiagnosticKind = 'duplicate' | 'missing' | 'outOfScope'

export interface Diagnostic {
  kind: DiagnosticKind
  /** The word as written in the document (or the card front, for duplicates). */
  word: string
  /** Human detail — where the duplicates are, or where an out-of-scope card currently lives. */
  detail: string
  /** For 'outOfScope': the card that could be pulled in. */
  cardId?: string
  fromDeckName?: string
}

/** What the caller wants done about each diagnostic class. */
export interface DiagnosticPolicy {
  ignoreDuplicates: boolean
  ignoreMissing:    boolean
  /** When false, out-of-scope cards are reported but never moved. */
  allowPullIn:      boolean
}

export interface ScopeCard {
  cardId: string
  front:  string
  back:   string
  deckId: string
  deckName: string
  sourceLanguage: string
}

/** A card that exists in the library but outside the selected scope. */
export interface OutOfScopeCard {
  cardId: string
  front:  string
  deckName: string
  sourceLanguage: string
}

/**
 * Everything wrong with the inputs, computed rather than inferred.
 *
 *  - **duplicate**  — the same word appears on more than one card IN SCOPE. Moving one of them and
 *                     not the other is how a library quietly ends up with the word in two places.
 *  - **outOfScope** — a word the documents list that exists in the library but outside the scope.
 *                     Reported (and offered as a pull-in) rather than silently ignored, because the
 *                     user's document plainly expects it to be organized.
 *  - **missing**    — a word the documents list that doesn't exist anywhere. Nothing can be moved;
 *                     the user either mistyped it or hasn't added the card yet.
 *
 * Checked with `normalizeFrontKey`, the same normalization the duplicate checks and the document
 * matcher use — so "el gato", "El Gato" and "gato (m)" are one word here, exactly as they are there.
 */
export function diagnose(
  scope: ScopeCard[],
  documentWords: string[],
  outOfScope: OutOfScopeCard[],
  sourceLanguage: string,
): Diagnostic[] {
  const out: Diagnostic[] = []

  // Duplicates within the scope.
  const byKey = new Map<string, ScopeCard[]>()
  for (const c of scope) {
    const k = normalizeFrontKey(c.front, c.sourceLanguage)
    const arr = byKey.get(k)
    if (arr) arr.push(c); else byKey.set(k, [c])
  }
  for (const [, cards] of byKey) {
    // A card shared into several decks is ONE card in several places, not a duplicate word.
    const distinct = new Map(cards.map(c => [c.cardId, c]))
    if (distinct.size < 2) continue
    const first = cards[0]!
    out.push({
      kind: 'duplicate',
      word: first.front,
      detail: [...distinct.values()].map(c => c.deckName).join(', '),
    })
  }

  // Document words that aren't in scope.
  const scopeKeys = new Set(scope.map(c => normalizeFrontKey(c.front, c.sourceLanguage)))
  const outsideByKey = new Map(outOfScope.map(c => [normalizeFrontKey(c.front, c.sourceLanguage), c]))
  const seenWords = new Set<string>()
  for (const word of documentWords) {
    const k = normalizeFrontKey(word, sourceLanguage)
    if (!k || scopeKeys.has(k) || seenWords.has(k)) continue
    seenWords.add(k)
    const elsewhere = outsideByKey.get(k)
    if (elsewhere) {
      out.push({
        kind: 'outOfScope', word, cardId: elsewhere.cardId, fromDeckName: elsewhere.deckName,
        detail: `currently in ${elsewhere.deckName}, outside the selected scope`,
      })
    } else {
      out.push({ kind: 'missing', word, detail: 'not in your library' })
    }
  }
  return out
}

/** Diagnostics the policy says to surface. Ignored classes are dropped, not hidden behind a flag. */
export function applyPolicy(diags: Diagnostic[], policy: DiagnosticPolicy): Diagnostic[] {
  return diags.filter(d =>
    !(d.kind === 'duplicate' && policy.ignoreDuplicates) &&
    !(d.kind === 'missing'   && policy.ignoreMissing))
}

// ─── Ordering + validation ───────────────────────────────────────────────────

const RANK: Record<MigrationStep['kind'], number> = {
  createFolder: 0, moveFolder: 1, moveDeck: 2, moveCard: 3,
}

/**
 * Orders steps so each one's destination exists by the time it runs.
 *
 * Folders are created first (shallowest first, so a parent exists before its child), then folders
 * move, then decks, then cards. Within a kind the model's order is preserved — it may have a reason
 * for it, and a stable sort keeps the preview honest about what will actually happen.
 *
 * The executor also creates missing folders on demand, so this is belt-and-braces rather than the
 * only thing standing between the plan and a broken destination — but a plan that reads in a sane
 * order is also a plan a human can actually review.
 */
export function orderSteps(steps: MigrationStep[]): MigrationStep[] {
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const r = RANK[a.s.kind] - RANK[b.s.kind]
      if (r !== 0) return r
      if (a.s.kind === 'createFolder' && b.s.kind === 'createFolder') {
        const d = a.s.path.length - b.s.path.length
        if (d !== 0) return d
      }
      return a.i - b.i
    })
    .map(x => x.s)
}

/**
 * Drops steps that can't be executed, returning what survived plus why the rest went.
 *
 * The model is not trusted with ids: every id is re-validated against the library the CLIENT holds,
 * so an invented card, a deck outside the scope, or a pull-in the user didn't authorize is discarded
 * rather than attempted. A no-op move (already at the destination) is dropped too, so the preview
 * never promises work that won't happen.
 */
export function validatePlan(
  steps: MigrationStep[],
  known: {
    cardIds: Set<string>
    deckIds: Set<string>
    folderIds: Set<string>
    /** Cards the plan may pull in from outside the scope (empty when the user said no). */
    pullInCardIds: Set<string>
    /** cardId → the deck path it already sits in, for no-op detection. */
    currentDeckPath?: Map<string, string>
  },
): { steps: MigrationStep[]; dropped: { step: MigrationStep; why: string }[] } {
  const kept: MigrationStep[] = []
  const dropped: { step: MigrationStep; why: string }[] = []

  for (const step of steps) {
    if (step.kind === 'createFolder') {
      if (step.path.length === 0) { dropped.push({ step, why: 'empty folder path' }); continue }
      kept.push(step); continue
    }
    if (step.kind === 'moveFolder') {
      if (!known.folderIds.has(step.folderId)) { dropped.push({ step, why: 'unknown folder' }); continue }
      // Moving a folder into itself or its own subtree would orphan the branch.
      if (step.toParent.includes(step.folderName)) { dropped.push({ step, why: 'would nest a folder inside itself' }); continue }
      kept.push(step); continue
    }
    if (step.kind === 'moveDeck') {
      if (!known.deckIds.has(step.deckId)) { dropped.push({ step, why: 'unknown deck' }); continue }
      kept.push(step); continue
    }
    // moveCard
    if (!known.cardIds.has(step.cardId) && !known.pullInCardIds.has(step.cardId)) {
      dropped.push({ step, why: step.pullIn ? 'out-of-scope card not authorized' : 'unknown card' }); continue
    }
    if (step.pullIn && !known.pullInCardIds.has(step.cardId)) {
      dropped.push({ step, why: 'out-of-scope card not authorized' }); continue
    }
    if (step.toDeck.length === 0) { dropped.push({ step, why: 'empty destination' }); continue }
    if (known.currentDeckPath?.get(step.cardId) === step.toDeck.join(' / ')) {
      dropped.push({ step, why: 'already there' }); continue
    }
    kept.push(step)
  }
  return { steps: kept, dropped }
}

// ─── Preview ─────────────────────────────────────────────────────────────────

export interface PlanGroup {
  /** Destination path as a display string, or the structural action for non-card steps. */
  label: string
  steps: MigrationStep[]
}

/**
 * Groups the plan for display: structural steps first (they're few and consequential), then card
 * moves grouped BY DESTINATION — "these 14 words go to Food/Ingredients" is the unit a person can
 * actually check, whereas 14 separate rows is a wall.
 */
export function groupPlan(steps: MigrationStep[]): PlanGroup[] {
  const structural = steps.filter(s => s.kind !== 'moveCard')
  const groups: PlanGroup[] = []
  if (structural.length > 0) groups.push({ label: 'Structure', steps: structural })

  const byDest = new Map<string, MigrationStep[]>()
  for (const s of steps) {
    if (s.kind !== 'moveCard') continue
    const key = s.toDeck.join(' / ')
    const arr = byDest.get(key)
    if (arr) arr.push(s); else byDest.set(key, [s])
  }
  for (const [label, group] of byDest) groups.push({ label, steps: group })
  return groups
}

/** How many cards the plan touches — the number worth showing next to "Apply". */
export function countCardMoves(steps: MigrationStep[]): number {
  return steps.filter(s => s.kind === 'moveCard').length
}
