/**
 * lib/agents/planMigration.ts — the browser side of "read the library, read the brief, write a plan".
 *
 * The sequence, and why it's this order:
 *   1. EXPORT the selected scope with SHORT IDS (`lib/agents/modelExport.ts`) — the tree is what lets
 *      the model reason about folders and whole decks, and short ids are what let thousands of cards
 *      fit in a prompt at all.
 *   2. DIAGNOSE deterministically — duplicates, words the documents mention that aren't in scope,
 *      and cards that exist elsewhere in the library and could be pulled in. Computation is exact
 *      and free; a model asked to audit its own input is neither.
 *   3. PLAN — sized to the load:
 *        - Small scope → ONE call with the full export.
 *        - Big scope  → a STRUCTURE call (tree + document outlines, no card lines), then card moves
 *          for routed sections computed deterministically here, then only genuinely unclaimed
 *          leftovers judged in small batches — and only if the structure stage asked for that.
 *      The big path exists because one giant call provably dies: output ceilings, function
 *      timeouts, "Failed to fetch".
 *   4. VALIDATE every id the model returned against the real library before anything is shown as
 *      approvable.
 */

import type { Deck, Folder, UserId } from '@/domain'
import { apiUrl } from '@/lib/apiBase'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { descendantDeckIds } from '@/lib/folderStats'
import { normalizeFrontKey } from '@/lib/duplicates'
import { mapLimit } from '@/lib/mapLimit'
import {
  diagnose, applyPolicy, orderSteps, validatePlan,
  type Diagnostic, type DiagnosticPolicy, type LibraryPath, type MigrationPlan, type MigrationStep,
  type OutOfScopeCard, type ScopeCard,
} from './migrationPlan'
import {
  buildModelLibrary, translateSteps, resolveDocMoves, leftoverCards, assignBatchText, movesToSteps,
  collectDestinations, sectionKey, type DocSection, type SectionRoute,
} from './modelExport'

/**
 * Library + documents beyond this many characters take the staged path. ~15k tokens of input keeps
 * the single call fast and its answer far from the output ceiling.
 */
const SINGLE_SHOT_MAX_CHARS = 60_000
const ASSIGN_BATCH_SIZE = 250
const ASSIGN_CONCURRENCY = 2

export interface PlanInputs {
  userId: UserId
  /** Decks the user selected. */
  scopeDeckIds: string[]
  instruction: string
  documents: { name: string; sections: DocSection[] }[]
  folders: Folder[]
  decks:   Deck[]
  sourceLanguage: string
  targetLanguage: string
  policy: DiagnosticPolicy
  /** Progress narration for the planning screen ("Assigning cards (3/12)…"). */
  onProgress?: (message: string) => void
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
  scopeDeckIds: string[], decks: Deck[], sourceLanguage: string, targetLanguage: string,
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
      out.push({ cardId: c.id, front: c.front, back: c.back, deckId, deckName: deckName.get(deckId) ?? 'deck', sourceLanguage: c.sourceLanguage })
    }
  }
  return out
}

const capList = (lines: string[], cap = 60) =>
  lines.length <= cap ? lines : [...lines.slice(0, cap), `  …and ${lines.length - cap} more`]

/** The NOTES block — computed facts the model is told to trust rather than re-derive. */
function renderNotes(
  diags: Diagnostic[], pullInShortIds: Map<string, { front: string; deckName: string }>,
  policy: DiagnosticPolicy,
): string {
  const lines: string[] = []
  const dupes   = diags.filter(d => d.kind === 'duplicate')
  const missing = diags.filter(d => d.kind === 'missing')

  if (dupes.length > 0) {
    lines.push(policy.ignoreDuplicates
      ? `Duplicated words (the learner asked you to IGNORE these — organize them like any other card): ${capList(dupes.map(d => d.word)).join(', ')}`
      : `Duplicated words — the same word is on more than one card in scope. Keep the copies TOGETHER unless the instruction says otherwise:`)
    if (!policy.ignoreDuplicates) lines.push(...capList(dupes.map(d => `  - ${d.word} (in ${d.detail})`)))
  }
  if (missing.length > 0 && !policy.ignoreMissing) {
    lines.push(`Words in the documents that do not exist in the library at all — you cannot move these, mention them in the summary if relevant: ${capList(missing.map(d => d.word)).join(', ')}`)
  }
  if (pullInShortIds.size > 0) {
    lines.push(policy.allowPullIn
      ? `Cards OUTSIDE the selected scope that the documents mention. The learner ALLOWS moving these:`
      : `Cards outside the selected scope that the documents mention. The learner has NOT authorized moving these — do not include them:`)
    if (policy.allowPullIn) {
      lines.push(...capList([...pullInShortIds.entries()].map(([sid, c]) => `  - cardId=${sid} | ${c.front} | currently in: ${c.deckName}`)))
    }
  }
  return lines.join('\n')
}

/** One document as single-shot planner text. */
const docText = (doc: { name: string; sections: DocSection[] }) =>
  doc.sections.flatMap(s => [
    sectionKey(s),
    ...s.cards.map(c => `    ${c.front} = ${c.back}`),
  ]).join('\n')

/** One document as a structure-stage OUTLINE: paths, counts, a few samples — no full word lists. */
const docOutline = (doc: { name: string; sections: DocSection[] }) =>
  doc.sections.map(s => {
    const sample = s.cards.slice(0, 8).map(c => c.front).join(', ')
    return `SECTION: ${sectionKey(s)}  (${s.cards.length} words)${sample ? `\n  e.g. ${sample}` : ''}`
  }).join('\n')

async function postPlanner(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl('/api/agents/organizer-plan'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({ ok: false, error: 'planner returned a bad response' })) as Record<string, unknown>
  if (!data?.ok) throw new Error(String(data?.error ?? 'planning failed'))
  return data
}

export async function planMigration(input: PlanInputs): Promise<PlanResult> {
  const { scopeDeckIds, instruction, documents, folders, decks, sourceLanguage, targetLanguage, policy, onProgress } = input

  onProgress?.('Reading the library…')
  const scopeCards = await loadScopeCards(scopeDeckIds, decks)

  // Deterministic diagnostics.
  const docWords = documents.flatMap(d => d.sections.flatMap(s => s.cards.map(c => c.front)))
  const scopeKeys = new Set(scopeCards.map(c => normalizeFrontKey(c.front, c.sourceLanguage)))
  const wantedOutside = new Set(
    docWords.map(w => normalizeFrontKey(w, sourceLanguage)).filter(k => k && !scopeKeys.has(k)))
  const pullIn = policy.allowPullIn
    ? await loadPullInCandidates(scopeDeckIds, decks, sourceLanguage, targetLanguage, wantedOutside)
    : []
  const diagnostics = applyPolicy(diagnose(scopeCards, docWords, pullIn, sourceLanguage), policy)

  // The model-facing export — short ids throughout.
  const lib = buildModelLibrary(folders, decks, scopeDeckIds, scopeCards, pullIn)
  const pullInShortIds = new Map([...lib.links.entries()].filter(([, l]) => l.pullIn).map(([sid, l]) => [sid, { front: l.front, deckName: l.deckName }]))

  // What the model may reference; used to validate what it returned.
  const known = {
    cardIds:   new Set(scopeCards.map(c => c.cardId)),
    deckIds:   new Set(scopeDeckIds),
    folderIds: new Set(folders.map(f => f.id)),
    pullInCardIds: new Set(pullIn.map(c => c.cardId)),
    // "Already there" detection — only for cards with ONE link in scope (a shared card's current
    // location is ambiguous, so it is never dropped as a no-op).
    currentDeckPath: new Map<string, string>(),
  }
  {
    const linkCount = new Map<string, number>()
    for (const c of scopeCards) linkCount.set(c.cardId, (linkCount.get(c.cardId) ?? 0) + 1)
    for (const c of scopeCards) {
      if (linkCount.get(c.cardId) !== 1) continue
      const p = lib.deckPaths.get(c.deckId)
      if (p) known.currentDeckPath.set(c.cardId, p.join(' / '))
    }
  }
  // Folders the user selected implicitly (a deck's ancestors) are movable too.
  for (const f of folders) if (descendantDeckIds(f.id, folders, decks).some(id => known.deckIds.has(id))) known.folderIds.add(f.id)

  const notes = renderNotes(diagnostics, pullInShortIds, policy)
  const docChars = documents.reduce((n, d) => n + d.sections.reduce((m, s) => m + s.cards.length * 24, 0), 0)
  const singleShot = lib.fullText.length + docChars <= SINGLE_SHOT_MAX_CHARS

  let rawSteps: MigrationStep[]
  let summary: string
  let truncated = false

  if (singleShot) {
    onProgress?.('Writing the plan…')
    const data = await postPlanner({
      mode: 'plan', instruction, notes,
      documents: documents.map(d => ({ name: d.name, text: docText(d) })),
      library: lib.fullText,
    })
    const plan = data.plan as { summary?: string; steps?: unknown[] }
    rawSteps = translateSteps(plan.steps ?? [], lib, decks, folders)
    summary = plan.summary ?? ''
    truncated = data.stopReason === 'max_tokens'
  } else {
    // ── The big-load path ──────────────────────────────────────────────────
    onProgress?.('Planning the structure…')
    const data = await postPlanner({
      mode: 'structure', instruction, notes,
      documents: documents.map(d => ({ name: d.name, text: docOutline(d) })),
      library: lib.treeText,
    })
    const plan = data.plan as { summary?: string; steps?: unknown[] }
    // Structure may only shape containers; anything else it emitted is dropped here, not run.
    const structureSteps = translateSteps(plan.steps ?? [], lib, decks, folders)
      .filter(s => s.kind !== 'moveCard')
    summary = plan.summary ?? ''
    truncated = data.stopReason === 'max_tokens'

    const sectionRoutes: SectionRoute[] = (Array.isArray(data.sectionRoutes) ? data.sectionRoutes : [])
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map(r => ({ section: String(r.section ?? ''), toDeck: Array.isArray(r.toDeck) ? r.toDeck.map(String) : [] }))

    // Card moves for everything the documents name — deterministic, instant, any size.
    const doc = resolveDocMoves({ documents, sectionRoutes, scopeCards, pullIn, deckPaths: lib.deckPaths, sourceLanguage })

    // Leftovers: only per the structure stage's stated policy, and never without an instruction —
    // documents alone say nothing about cards they don't mention.
    const leftovers = leftoverCards(scopeCards, doc.claimedKeys, sourceLanguage)
    const leftoverPolicy = (data.leftovers ?? { action: 'leave' }) as { action?: string; toDeck?: unknown[] }
    let leftoverSteps: MigrationStep[] = []
    if (leftovers.length > 0 && instruction.trim()) {
      if (leftoverPolicy.action === 'route' && Array.isArray(leftoverPolicy.toDeck) && leftoverPolicy.toDeck.length > 0) {
        const dest = leftoverPolicy.toDeck.map(String)
        leftoverSteps = leftovers
          .filter(c => (lib.deckPaths.get(c.deckId)?.join(' / ').toLowerCase() ?? '') !== dest.join(' / ').toLowerCase())
          .map(c => ({
            kind: 'moveCard' as const, cardId: c.cardId, front: c.front, back: c.back,
            fromDeckId: c.deckId, fromDeckName: c.deckName, toDeck: dest,
            reason: 'not in any document — routed with the rest',
          }))
      } else if (leftoverPolicy.action === 'judge') {
        const destinations: LibraryPath[] = collectDestinations({ sectionRoutes, structureSteps: [...structureSteps, ...doc.steps], deckPaths: lib.deckPaths })
        const batches: ScopeCard[][] = []
        for (let i = 0; i < leftovers.length; i += ASSIGN_BATCH_SIZE) batches.push(leftovers.slice(i, i + ASSIGN_BATCH_SIZE))
        let doneBatches = 0
        onProgress?.(`Assigning cards (0/${batches.length} batches)…`)
        const perBatch = await mapLimit(batches, ASSIGN_CONCURRENCY, async batch => {
          const res = await postPlanner({
            mode: 'assign', instruction,
            destinations: destinations.map(d => d.join(' / ')),
            cards: assignBatchText(batch),
          }).catch(() => null) // one failed batch loses its assignments, not the whole plan
          doneBatches += 1
          onProgress?.(`Assigning cards (${doneBatches}/${batches.length} batches)…`)
          if (!res) return [] as MigrationStep[]
          if (res.stopReason === 'max_tokens') truncated = true
          return movesToSteps(res.moves, batch, destinations, lib.deckPaths)
        })
        leftoverSteps = perBatch.filter((b): b is MigrationStep[] => Array.isArray(b)).flat()
      }
    }
    rawSteps = [...structureSteps, ...doc.steps, ...leftoverSteps]
  }

  onProgress?.('Checking the plan…')
  const { steps, dropped } = validatePlan(orderSteps(rawSteps), known)
  return {
    plan: { summary, steps: rawSteps },
    steps, diagnostics, dropped,
    libraryText: singleShot ? lib.fullText : `${lib.treeText}\n\n(Cards omitted here — the scope is large, so the planner read this tree plus document outlines, and card moves were matched mechanically.)`,
    truncated,
  }
}
