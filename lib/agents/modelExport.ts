/**
 * lib/agents/modelExport.ts — the model-facing view of the library, and the translations back.
 *
 * Everything the planner reads and everything it answers goes through SHORT IDS (`17`, `d3`, `f1`)
 * instead of UUIDs, for two load-bearing reasons:
 *   - **Scale.** A UUID is 36 characters; at thousands of cards the ids alone would dwarf the
 *     vocabulary. A numeric id is 1–4 characters, which is the difference between "fits in one
 *     prompt" and "doesn't".
 *   - **Safety.** A short id the client can't map back to a real record simply translates to nothing
 *     and is dropped by `validatePlan` — the model cannot smuggle in an id we didn't hand it.
 *
 * A card's short id names the (card, deck) LINK, not the card: a card shared into two scope decks
 * gets two ids, so a move is unambiguous about which link it relinks — and the model no longer has
 * to echo front/back/fromDeck at all, we fill them from our own copy.
 *
 * The big-load path also lives here as pure functions: `resolveDocMoves` turns "this document
 * section goes to this deck" into concrete card moves DETERMINISTICALLY (word matching is exact and
 * free — a model assigning thousands of doc-listed cards one by one is neither), and
 * `movesToSteps` translates the batch-assignment answers for the leftovers.
 */

import type { Deck, Folder } from '@/domain'
import { normalizeFrontKey } from '@/lib/duplicates'
import type { LibraryPath, MigrationStep, OutOfScopeCard, ScopeCard } from './migrationPlan'

/** One (card, deck) link as the model may reference it. */
export interface ModelLink {
  cardId: string
  deckId: string
  deckName: string
  front: string
  back: string
  /** True when this link lives OUTSIDE the scope and moving it means pulling it in. */
  pullIn: boolean
}

export interface ModelLibrary {
  /** Full export with card lines — the single-shot planner input. */
  fullText: string
  /** The same tree without card lines — the structure-stage input for big loads. */
  treeText: string
  /** Short id → the link it names (scope cards first, then pull-in candidates). */
  links: Map<string, ModelLink>
  /** Short id → real id, for the two container step kinds. */
  deckIds: Map<string, string>
  folderIds: Map<string, string>
  /** Real deck id → its path segments (folders…, deck name). */
  deckPaths: Map<string, LibraryPath>
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

export function buildModelLibrary(
  folders: Folder[], decks: Deck[], scopeDeckIds: string[],
  scopeCards: ScopeCard[], pullIn: OutOfScopeCard[] = [],
): ModelLibrary {
  const inScope = new Set(scopeDeckIds)
  const scopeDecks = decks.filter(d => inScope.has(d.id))
  const folderById = new Map(folders.map(f => [f.id, f]))

  // Only the branches that hold a scoped deck are shown — the tree stays proportional to the scope,
  // not to the whole account. New destinations are named by path, so nothing else is needed.
  const usedFolders = new Set<string>()
  for (const d of scopeDecks) {
    let fid: string | null = d.folderId ?? null
    while (fid && !usedFolders.has(fid)) { usedFolders.add(fid); fid = folderById.get(fid)?.parentId ?? null }
  }

  const cardsByDeck = new Map<string, ScopeCard[]>()
  for (const c of scopeCards) {
    const list = cardsByDeck.get(c.deckId)
    if (list) list.push(c); else cardsByDeck.set(c.deckId, [c])
  }

  const links = new Map<string, ModelLink>()
  const deckIds = new Map<string, string>()
  const folderIds = new Map<string, string>()
  const deckPaths = new Map<string, LibraryPath>()
  const fullLines: string[] = []
  const treeLines: string[] = []
  let cardN = 0, deckN = 0, folderN = 0

  const walk = (parentId: string | null, path: string[], depth: number) => {
    const indent = '  '.repeat(depth)
    for (const f of folders.filter(x => usedFolders.has(x.id) && (x.parentId ?? null) === parentId).sort(byName)) {
      folderN += 1
      const sid = `f${folderN}`
      folderIds.set(sid, f.id)
      fullLines.push(`${indent}${f.name}/ [${sid}]`)
      treeLines.push(`${indent}${f.name}/ [${sid}]`)
      walk(f.id, [...path, f.name], depth + 1)
    }
    for (const d of scopeDecks.filter(x => (x.folderId ?? null) === parentId).sort(byName)) {
      deckN += 1
      const sid = `d${deckN}`
      deckIds.set(sid, d.id)
      deckPaths.set(d.id, [...path, d.name])
      const cards = cardsByDeck.get(d.id) ?? []
      fullLines.push(`${indent}${d.name} [${sid}] (${cards.length} cards)`)
      treeLines.push(`${indent}${d.name} [${sid}] (${cards.length} cards)`)
      for (const c of cards) {
        cardN += 1
        links.set(String(cardN), {
          cardId: c.cardId, deckId: c.deckId, deckName: c.deckName,
          front: c.front, back: c.back, pullIn: false,
        })
        fullLines.push(`${indent}  ${cardN}: ${c.front} = ${c.back}`)
      }
    }
  }
  walk(null, [], 0)

  // Pull-in candidates continue the same numbering so the model has ONE id vocabulary. They appear
  // only in NOTES (single-shot) or are matched deterministically (big loads) — never in the tree.
  for (const c of pullIn) {
    cardN += 1
    links.set(String(cardN), {
      cardId: c.cardId, deckId: c.deckId, deckName: c.deckName,
      front: c.front, back: c.back, pullIn: true,
    })
  }

  return { fullText: fullLines.join('\n'), treeText: treeLines.join('\n'), links, deckIds, folderIds, deckPaths }
}

/**
 * Rewrites a model-returned step's short ids into real ids, filling every echo field (front, back,
 * fromDeck…) from OUR copy of the data — the model's version of those is never trusted or needed.
 * A short id that maps to nothing passes through unchanged, for `validatePlan` to drop and report.
 */
export function translateSteps(raw: unknown[], lib: ModelLibrary, decks: Deck[], folders: Folder[]): MigrationStep[] {
  const deckById = new Map(decks.map(d => [d.id, d]))
  const folderById = new Map(folders.map(f => [f.id, f]))
  const out: MigrationStep[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const step = s as Record<string, unknown>
    const path = (p: unknown): LibraryPath => Array.isArray(p) ? p.map(x => String(x).trim()).filter(Boolean) : []
    const reason = typeof step.reason === 'string' ? step.reason : ''

    if (step.kind === 'createFolder') {
      out.push({ kind: 'createFolder', path: path(step.path), reason })
    } else if (step.kind === 'moveFolder') {
      const real = lib.folderIds.get(String(step.folderId)) ?? String(step.folderId)
      out.push({ kind: 'moveFolder', folderId: real, folderName: folderById.get(real)?.name ?? String(step.folderName ?? ''), toParent: path(step.toParent), reason })
    } else if (step.kind === 'moveDeck') {
      const real = lib.deckIds.get(String(step.deckId)) ?? String(step.deckId)
      out.push({ kind: 'moveDeck', deckId: real, deckName: deckById.get(real)?.name ?? String(step.deckName ?? ''), toFolder: path(step.toFolder), reason })
    } else if (step.kind === 'moveCard') {
      const link = lib.links.get(String(step.cardId))
      if (link) {
        out.push({
          kind: 'moveCard', cardId: link.cardId, front: link.front, back: link.back,
          fromDeckId: link.deckId, fromDeckName: link.deckName, toDeck: path(step.toDeck),
          ...(link.pullIn ? { pullIn: true } : {}), reason,
        })
      } else {
        // Unknown link: keep a recognizable husk so the validator can show WHAT was dropped.
        out.push({
          kind: 'moveCard', cardId: String(step.cardId), front: String(step.front ?? `card ${String(step.cardId)}`),
          back: '', fromDeckId: String(step.fromDeckId ?? ''), fromDeckName: '', toDeck: path(step.toDeck), reason,
        })
      }
    }
  }
  return out
}

// ─── The big-load path ───────────────────────────────────────────────────────

export interface DocSection { path: string[]; name: string; cards: { front: string; back: string }[] }
export interface SectionRoute { section: string; toDeck: LibraryPath }

const joinPath = (p: LibraryPath) => p.join(' / ')
const pathKey = (p: LibraryPath) => joinPath(p).trim().toLowerCase()
export const sectionKey = (s: DocSection) => joinPath([...s.path, s.name])

/**
 * Turns the structure stage's section→destination routing into concrete card moves, with NO model
 * involvement: every word in a routed section is matched against the scope (and, when allowed, the
 * pull-in candidates) by the same `normalizeFrontKey` the rest of the app uses.
 *
 * A section with no route falls back to its own path — "follow the documents literally" is the
 * default reading. The first section to claim a word wins; a duplicated word moves its FIRST scope
 * copy only (relinking two copies into one deck can't both succeed, and duplicates are already
 * surfaced as diagnostics).
 */
export function resolveDocMoves(opts: {
  documents: { name: string; sections: DocSection[] }[]
  sectionRoutes: SectionRoute[]
  scopeCards: ScopeCard[]
  pullIn: OutOfScopeCard[]
  deckPaths: Map<string, LibraryPath>
  sourceLanguage: string
}): { steps: MigrationStep[]; claimedKeys: Set<string> } {
  const routeByKey = new Map<string, LibraryPath>()
  for (const r of opts.sectionRoutes) {
    const dest = (r.toDeck ?? []).map(x => String(x).trim()).filter(Boolean)
    if (dest.length > 0) routeByKey.set(r.section.trim().toLowerCase(), dest)
  }
  const scopeByKey = new Map<string, ScopeCard[]>()
  for (const c of opts.scopeCards) {
    const k = normalizeFrontKey(c.front, c.sourceLanguage)
    if (!k) continue
    const list = scopeByKey.get(k)
    if (list) list.push(c); else scopeByKey.set(k, [c])
  }
  const pullByKey = new Map<string, OutOfScopeCard>()
  for (const c of opts.pullIn) {
    const k = normalizeFrontKey(c.front, c.sourceLanguage)
    if (k && !pullByKey.has(k)) pullByKey.set(k, c)
  }

  const steps: MigrationStep[] = []
  const claimedKeys = new Set<string>()
  for (const doc of opts.documents) {
    for (const section of doc.sections) {
      const own = [...section.path, section.name].map(x => x.trim()).filter(Boolean)
      const dest = routeByKey.get(sectionKey(section).trim().toLowerCase()) ?? own
      if (dest.length === 0) continue
      for (const card of section.cards) {
        const k = normalizeFrontKey(card.front, opts.sourceLanguage)
        if (!k || claimedKeys.has(k)) continue
        const inScope = scopeByKey.get(k)?.[0]
        if (inScope) {
          claimedKeys.add(k)
          const cur = opts.deckPaths.get(inScope.deckId)
          if (cur && pathKey(cur) === pathKey(dest)) continue // already exactly there
          steps.push({
            kind: 'moveCard', cardId: inScope.cardId, front: inScope.front, back: inScope.back,
            fromDeckId: inScope.deckId, fromDeckName: inScope.deckName, toDeck: dest,
            reason: `listed under “${sectionKey(section)}” in ${doc.name}`,
          })
          continue
        }
        const outside = pullByKey.get(k)
        if (outside) {
          claimedKeys.add(k)
          steps.push({
            kind: 'moveCard', cardId: outside.cardId, front: outside.front, back: outside.back,
            fromDeckId: outside.deckId, fromDeckName: outside.deckName, toDeck: dest, pullIn: true,
            reason: `listed in ${doc.name} — currently outside the scope, in ${outside.deckName}`,
          })
        }
        // No match anywhere → already reported as a "missing" diagnostic; nothing to move.
      }
    }
  }
  return { steps, claimedKeys }
}

/** Scope cards no document section claimed — the pool the leftover policy applies to. */
export function leftoverCards(scopeCards: ScopeCard[], claimedKeys: Set<string>, sourceLanguage: string): ScopeCard[] {
  const seen = new Set<string>()
  const out: ScopeCard[] = []
  for (const c of scopeCards) {
    const k = normalizeFrontKey(c.front, sourceLanguage)
    if (!k || claimedKeys.has(k) || seen.has(c.cardId)) continue
    seen.add(c.cardId)
    out.push(c)
  }
  return out
}

/** The numbered card lines one assignment batch reads. Ids are the batch-local index. */
export function assignBatchText(batch: ScopeCard[]): string {
  return batch.map((c, i) => `${i}: ${c.front} = ${c.back}  (in: ${c.deckName})`).join('\n')
}

/**
 * Translates one assignment batch's answer (`{moves: [{id, to}]}`, `to` an index into the
 * destination list) into moveCard steps. Anything malformed — id or destination out of range — is
 * skipped silently: for leftovers, "leave it where it is" is always a valid outcome.
 */
export function movesToSteps(
  moves: unknown, batch: ScopeCard[], destinations: LibraryPath[], deckPaths: Map<string, LibraryPath>,
): MigrationStep[] {
  if (!Array.isArray(moves)) return []
  const steps: MigrationStep[] = []
  const seen = new Set<number>()
  for (const m of moves) {
    if (!m || typeof m !== 'object') continue
    const id = Number((m as Record<string, unknown>).id)
    const to = Number((m as Record<string, unknown>).to)
    if (!Number.isInteger(id) || id < 0 || id >= batch.length || seen.has(id)) continue
    if (!Number.isInteger(to) || to < 0 || to >= destinations.length) continue
    seen.add(id)
    const card = batch[id]!
    const dest = destinations[to]!
    const cur = deckPaths.get(card.deckId)
    if (cur && pathKey(cur) === pathKey(dest)) continue
    steps.push({
      kind: 'moveCard', cardId: card.cardId, front: card.front, back: card.back,
      fromDeckId: card.deckId, fromDeckName: card.deckName, toDeck: dest,
      reason: typeof (m as Record<string, unknown>).reason === 'string' ? (m as Record<string, unknown>).reason as string : '',
    })
  }
  return steps
}

/**
 * The destination menu for leftover assignment: every deck the plan already involves — routed
 * section targets, decks the structure stage created or moved, and the scope's existing decks.
 * Deduped by path, capped so the prompt stays a menu rather than a second library.
 */
export function collectDestinations(opts: {
  sectionRoutes: SectionRoute[]
  structureSteps: MigrationStep[]
  deckPaths: Map<string, LibraryPath>
  cap?: number
}): LibraryPath[] {
  const out = new Map<string, LibraryPath>()
  const add = (p: LibraryPath) => {
    const clean = p.map(x => String(x).trim()).filter(Boolean)
    if (clean.length > 0 && !out.has(pathKey(clean))) out.set(pathKey(clean), clean)
  }
  for (const r of opts.sectionRoutes) add(r.toDeck)
  for (const s of opts.structureSteps) {
    if (s.kind === 'moveDeck') add([...s.toFolder, s.deckName])
    if (s.kind === 'moveCard') add(s.toDeck)
  }
  for (const p of opts.deckPaths.values()) add(p)
  return [...out.values()].slice(0, opts.cap ?? 80)
}
