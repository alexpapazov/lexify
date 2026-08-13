/**
 * lib/agents/planMigration.ts — the browser side of "read the library, read the brief, write a plan".
 *
 * The sequence, and why it's this order:
 *   1. EXPORT the selected scope as the same hierarchical text the library export produces. Feeding
 *      the model the tree (rather than a flat card list) is what lets it reason about folders and
 *      whole decks instead of only individual cards.
 *   2. DIAGNOSE deterministically — duplicates, words the documents mention that aren't in scope,
 *      and cards that exist elsewhere in the library and could be pulled in. Computation is exact
 *      and free; a model asked to audit its own input is neither.
 *   3. PLAN — one call, with the instruction as ground truth and the documents as evidence.
 *   4. VALIDATE every id the model returned against the real library before anything is shown as
 *      approvable.
 */

import type { Deck, Folder, UserId } from '@/domain'
import { apiUrl } from '@/lib/apiBase'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { buildLibraryExport, renderLibraryText, type ExportScope } from '@/lib/libraryExport'
import { descendantDeckIds } from '@/lib/folderStats'
import { normalizeFrontKey } from '@/lib/duplicates'
import {
  diagnose, applyPolicy, orderSteps, validatePlan,
  type Diagnostic, type DiagnosticPolicy, type MigrationPlan, type MigrationStep,
  type OutOfScopeCard, type ScopeCard,
} from './migrationPlan'

export interface PlanInputs {
  userId: UserId
  /** Decks the user selected. */
  scopeDeckIds: string[]
  instruction: string
  documents: { name: string; text: string; words: string[] }[]
  folders: Folder[]
  decks:   Deck[]
  sourceLanguage: string
  targetLanguage: string
  policy: DiagnosticPolicy
}

export interface PlanResult {
  plan: MigrationPlan
  /** Everything the plan will actually do, ordered and validated. */
  steps: MigrationStep[]
  diagnostics: Diagnostic[]
  /** Steps the validator discarded, so the UI can be honest about what was ignored. */
  dropped: { step: MigrationStep; why: string }[]
  /** The export handed to the planner — shown on request so the user can see its input. */
  libraryText: string
  /** True when the model hit its token ceiling: the plan may be incomplete. */
  truncated: boolean
}

/** Cards in the selected decks, flattened with their deck for diagnostics and validation. */
async function loadScopeCards(scopeDeckIds: string[], decks: Deck[]): Promise<ScopeCard[]> {
  const byDeck = await new SupabaseCardRepository().listForDecks(scopeDeckIds)
  const deckName = new Map(decks.map(d => [d.id, d.name]))
  const out: ScopeCard[] = []
  for (const [deckId, cards] of byDeck) {
    for (const c of cards) {
      out.push({
        cardId: c.id, front: c.front, back: c.back,
        deckId, deckName: deckName.get(deckId) ?? 'deck',
        sourceLanguage: c.sourceLanguage,
      })
    }
  }
  return out
}

/**
 * Cards in the same language pair that are NOT in the selected scope, restricted to words the
 * documents actually mention.
 *
 * Restricting it matters: the whole out-of-scope library could be thousands of cards, and only the
 * ones a document asks for are candidates for pulling in.
 */
async function loadPullInCandidates(
  userId: UserId, scopeDeckIds: string[], decks: Deck[], sourceLanguage: string, targetLanguage: string,
  wantedKeys: Set<string>,
): Promise<OutOfScopeCard[]> {
  if (wantedKeys.size === 0) return []
  const inScope = new Set(scopeDeckIds)
  const otherDeckIds = decks
    .filter(d => !inScope.has(d.id) && d.sourceLanguage === sourceLanguage && d.targetLanguage === targetLanguage)
    .map(d => d.id)
  if (otherDeckIds.length === 0) return []

  const byDeck = await new SupabaseCardRepository().listForDecks(otherDeckIds)
  const deckName = new Map(decks.map(d => [d.id, d.name]))
  const out: OutOfScopeCard[] = []
  const seen = new Set<string>()
  for (const [deckId, cards] of byDeck) {
    for (const c of cards) {
      const k = normalizeFrontKey(c.front, c.sourceLanguage)
      if (!wantedKeys.has(k) || seen.has(k)) continue
      seen.add(k)
      out.push({ cardId: c.id, front: c.front, deckName: deckName.get(deckId) ?? 'deck', sourceLanguage: c.sourceLanguage })
    }
  }
  return out
}

/** The NOTES block — computed facts the model is told to trust rather than re-derive. */
function renderNotes(diags: Diagnostic[], pullIn: OutOfScopeCard[], policy: DiagnosticPolicy): string {
  const lines: string[] = []
  const dupes   = diags.filter(d => d.kind === 'duplicate')
  const missing = diags.filter(d => d.kind === 'missing')

  if (dupes.length > 0) {
    lines.push(policy.ignoreDuplicates
      ? `Duplicated words (the learner asked you to IGNORE these — organize them like any other card): ${dupes.map(d => d.word).join(', ')}`
      : `Duplicated words — the same word is on more than one card in scope. Keep the copies TOGETHER unless the instruction says otherwise:`)
    if (!policy.ignoreDuplicates) for (const d of dupes) lines.push(`  - ${d.word} (in ${d.detail})`)
  }
  if (missing.length > 0 && !policy.ignoreMissing) {
    lines.push(`Words in the documents that do not exist in the library at all — you cannot move these, mention them in the summary if relevant: ${missing.map(d => d.word).join(', ')}`)
  }
  if (pullIn.length > 0) {
    lines.push(policy.allowPullIn
      ? `Cards OUTSIDE the selected scope that the documents mention. You MAY move these; set "pullIn": true on the step:`
      : `Cards outside the selected scope that the documents mention. The learner has NOT authorized moving these — do not include them:`)
    if (policy.allowPullIn) {
      for (const c of pullIn) lines.push(`  - cardId=${c.cardId} | ${c.front} | currently in: ${c.deckName}`)
    }
  }
  return lines.join('\n')
}

export async function planMigration(input: PlanInputs): Promise<PlanResult> {
  const { userId, scopeDeckIds, instruction, documents, folders, decks, sourceLanguage, targetLanguage, policy } = input

  // 1. The export the planner reads. A single selected deck exports as itself; anything wider goes
  //    through the folder/pair scope so the tree structure is visible.
  const scope: ExportScope = scopeDeckIds.length === 1
    ? { kind: 'deck', deckId: scopeDeckIds[0]! }
    : { kind: 'pair', sourceLanguage, targetLanguage }
  const tree = await buildLibraryExport(scope, folders, decks, userId)
  // The pair export covers the whole pair; the planner must only act within the selection, so the
  // scope is restated in the prompt rather than assumed from the tree.
  const libraryText = renderLibraryText(tree, new Date().toISOString().slice(0, 10))

  // 2. Deterministic diagnostics.
  const scopeCards = await loadScopeCards(scopeDeckIds, decks)
  const docWords = documents.flatMap(d => d.words)
  const scopeKeys = new Set(scopeCards.map(c => normalizeFrontKey(c.front, c.sourceLanguage)))
  const wantedOutside = new Set(
    docWords.map(w => normalizeFrontKey(w, sourceLanguage)).filter(k => k && !scopeKeys.has(k)))
  const pullIn = policy.allowPullIn
    ? await loadPullInCandidates(userId, scopeDeckIds, decks, sourceLanguage, targetLanguage, wantedOutside)
    : []
  const diagnostics = applyPolicy(diagnose(scopeCards, docWords, pullIn, sourceLanguage), policy)

  // 3. Plan.
  const res = await fetch(apiUrl('/api/agents/organizer-plan'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instruction,
      documents: documents.map(d => ({ name: d.name, text: d.text })),
      library: `Only these decks are in scope: ${scopeDeckIds.length} selected.\n\n${libraryText}`,
      notes: renderNotes(diagnostics, pullIn, policy),
    }),
  })
  const data = await res.json().catch(() => ({ ok: false, error: 'planner returned a bad response' }))
  if (!data?.ok) throw new Error(data?.error ?? 'planning failed')

  // 4. Validate every id against the real library.
  const known = {
    cardIds:   new Set(scopeCards.map(c => c.cardId)),
    deckIds:   new Set(scopeDeckIds),
    folderIds: new Set(folders.map(f => f.id)),
    pullInCardIds: new Set(pullIn.map(c => c.cardId)),
    currentDeckPath: new Map<string, string>(),
  }
  // Folders the user selected implicitly (a deck's ancestors) are movable too.
  for (const f of folders) if (descendantDeckIds(f.id, folders, decks).some(id => known.deckIds.has(id))) known.folderIds.add(f.id)

  const raw = (data.plan?.steps ?? []) as MigrationStep[]
  const { steps, dropped } = validatePlan(orderSteps(raw), known)
  return {
    plan: { summary: data.plan?.summary ?? '', steps: raw },
    steps, diagnostics, dropped, libraryText,
    truncated: data.stopReason === 'max_tokens',
  }
}
