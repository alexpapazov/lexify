/**
 * lib/offline/download.ts — Stage 2: build a DownloadBundle for a scope and write it into the local
 * store. Pure selection helpers (scope → decks, cards → included set, size estimate) are separated so
 * they're unit-testable; `downloadForOffline` orchestrates the Supabase reads + distractor pre-gen.
 */
import type { Card, CardState, Deck, Folder } from '@/domain'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseLadderRepository } from '@/lib/data/ladders'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { SupabaseCardConfusionLinkRepository } from '@/lib/data/cardConfusionLinks'
import { SupabaseTypedAnswerOverrideRepository } from '@/lib/data/typedAnswerOverrides'
import { ensureChoicesGenerated, needsChoices } from '@/lib/distractors'
import { cardStateKey, ladderKey, paramKey, overrideKey } from './keys'
import { getLocalStore } from './localStore'
import type { DownloadBundle, Manifest, OfflineScope, StoredCardState } from './types'

const DAY_MS = 86_400_000

// ── Pure selection helpers ───────────────────────────────────────────────────

type DeckLite = Pick<Deck, 'id' | 'folderId' | 'sourceLanguage' | 'targetLanguage'>
type FolderLite = Pick<Folder, 'id' | 'parentId'>

/** Which deck IDs fall inside a scope (folder includes nested subfolders). */
export function scopeDeckIds(scope: OfflineScope, decks: DeckLite[], folders: FolderLite[]): string[] {
  if (scope.kind === 'library') return decks.map(d => d.id)
  if (scope.kind === 'language') return decks.filter(d => d.sourceLanguage === scope.source && d.targetLanguage === scope.target).map(d => d.id)
  if (scope.kind === 'deck') return scope.deckId ? [scope.deckId] : []
  // folder + descendants
  const wanted = new Set(scope.folderId ? [scope.folderId] : [])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders) if (f.parentId && wanted.has(f.parentId) && !wanted.has(f.id)) { wanted.add(f.id); grew = true }
  }
  return decks.filter(d => d.folderId && wanted.has(d.folderId)).map(d => d.id)
}

/**
 * Which cards to bundle: every learnable card (no graduated forward state → feeds the ladder), plus
 * graduated cards with a due date within `windowDays` (the Due-Now week). Dormant cards are skipped.
 */
export function selectOfflineCardIds(cards: { id: string }[], states: CardState[], nowMs: number, windowDays: number): Set<string> {
  const cutoff = nowMs + windowDays * DAY_MS
  const byCard = new Map<string, CardState[]>()
  for (const s of states) { const a = byCard.get(s.cardId) ?? []; a.push(s); byCard.set(s.cardId, a) }
  const out = new Set<string>()
  for (const c of cards) {
    const ss = byCard.get(c.id) ?? []
    const fwd = ss.find(s => s.reviewDirection !== 'reverse')
    if (!fwd || !fwd.graduated) { out.add(c.id); continue }   // unlearned / learning → include
    if (fwd.dormant) continue                                  // dormant graduated → never due
    const dues = [fwd.smartDueAt, fwd.typedDueAt, fwd.dueAt,
      ...ss.filter(s => s.reviewDirection === 'reverse').flatMap(r => [r.recallDueAt, r.dueAt])]
    if (dues.some(d => d != null && new Date(d).getTime() <= cutoff)) out.add(c.id)
  }
  return out
}

/** Rough byte size of a bundle (JSON length ≈ IndexedDB footprint). */
export function estimateBundleBytes(bundle: DownloadBundle): number {
  return JSON.stringify(bundle).length
}

// ── Orchestration (online → local store) ─────────────────────────────────────

export interface DownloadOptions {
  scope:         OfflineScope
  dueWindowDays: number
  includeAudio:  boolean
  onProgress?:   (phase: string, done: number, total: number) => void
}

function stripAudio(card: Card): Card {
  return { ...card, audioData: null, audioSources: null }
}

/** Build the bundle for the scope, pre-generate distractors, and hydrate the local store. */
export async function downloadForOffline(opts: DownloadOptions): Promise<{ manifest: Manifest; bytes: number }> {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  const uid = session.user.id
  const progress = opts.onProgress ?? (() => {})

  progress('Reading library', 0, 1)
  const [allDecks, allFolders] = await Promise.all([
    new SupabaseDeckRepository().list(uid),
    new SupabaseFolderRepository().list(uid),
  ])
  const deckIds = new Set(scopeDeckIds(opts.scope, allDecks, allFolders))
  const decks = allDecks.filter(d => deckIds.has(d.id))

  // Gather cards + states across the scope's decks (dedupe shared cards).
  const cardRepo = new SupabaseCardRepository()
  const stateRepo = new SupabaseCardStateRepository()
  const cardsById = new Map<string, Card>()
  const states: CardState[] = []
  for (const id of deckIds) {
    for (const c of await cardRepo.listByDeck(id)) if (!cardsById.has(c.id)) cardsById.set(c.id, c)
    states.push(...await stateRepo.listByDeck(uid, id))
  }
  const allCards = [...cardsById.values()]
  const selected = selectOfflineCardIds(allCards, states, Date.now(), opts.dueWindowDays)
  const cards = allCards.filter(c => selected.has(c.id))
  const cardIds = [...selected]

  // Pre-generate distractors for cards missing them (best-effort; MCQ falls back to deck siblings).
  const missing = cards.filter(c => needsChoices(c, 'front') || needsChoices(c, 'back'))
  for (let i = 0; i < missing.length; i++) {
    const c = missing[i]!
    const siblings = cards.filter(s => s.sourceLanguage === c.sourceLanguage && s.targetLanguage === c.targetLanguage)
    const side = needsChoices(c, 'front') ? 'front' : 'back'
    try {
      const choices = await ensureChoicesGenerated(c, side, siblings, c.sourceLanguage, c.targetLanguage)
      if (choices) cardsById.set(c.id, { ...cardsById.get(c.id)!, choices })
    } catch { /* keep fallback */ }
    progress('Generating distractors', i + 1, missing.length)
  }
  const finalCards = cardIds.map(id => cardsById.get(id)!).map(c => opts.includeAudio ? c : stripAudio(c))

  // Sync baselines (server updated_at) for the conflicting tables + the deck↔card join.
  progress('Packaging', 0, 1)
  const stateMeta = new Map<string, string>()
  const climbRows: { card_id: string; deck_id: string; state: unknown; updated_at: string }[] = []
  const deckCardRows: { deck_id: string; card_id: string }[] = []
  if (cardIds.length > 0) {
    const [su, cl, dc] = await Promise.all([
      supabase.from('card_states').select('card_id, review_direction, updated_at').in('card_id', cardIds),
      supabase.from('ladder_climb').select('card_id, deck_id, state, updated_at').in('card_id', cardIds),
      supabase.from('deck_cards').select('deck_id, card_id').in('deck_id', [...deckIds]),
    ])
    for (const r of su.data ?? []) stateMeta.set(cardStateKey(r.card_id as string, r.review_direction as string), r.updated_at as string)
    for (const r of cl.data ?? []) climbRows.push(r as { card_id: string; deck_id: string; state: unknown; updated_at: string })
    for (const r of dc.data ?? []) if (selected.has(r.card_id as string)) deckCardRows.push(r as { deck_id: string; card_id: string })
  }

  const cardStates: StoredCardState[] = states.filter(s => selected.has(s.cardId)).map(s => ({
    ...s, key: cardStateKey(s.cardId, s.reviewDirection), serverUpdatedAt: stateMeta.get(cardStateKey(s.cardId, s.reviewDirection)) ?? null,
  }))

  // Config (whole-user; small): ladders (per pair + default), scheduler params, confusion links, overrides.
  const [pairLadders, params, links, overrides] = await Promise.all([
    new SupabaseLadderRepository().list(uid),
    new SupabaseUserSchedulerParamsRepository().listForUser(uid),
    new SupabaseCardConfusionLinkRepository().listForUser(uid),
    new SupabaseTypedAnswerOverrideRepository().listForUser(uid),
  ])
  const defaultLadder = await new SupabaseLadderRepository().getDefault(uid)

  const manifest: Manifest = {
    userId: uid, scope: opts.scope, dueWindowDays: opts.dueWindowDays, includeAudio: opts.includeAudio,
    downloadedAt: new Date().toISOString(), cardCount: finalCards.length,
  }
  const bundle: DownloadBundle = {
    manifest,
    cards: finalCards,
    cardStates,
    ladderClimb: climbRows.map(r => ({ cardId: r.card_id, deckId: r.deck_id, state: r.state, serverUpdatedAt: r.updated_at })),
    ladders: [
      ...pairLadders.map(l => ({ key: ladderKey(l.source, l.target), source: l.source, target: l.target, ladder: l.ladder })),
      ...(defaultLadder ? [{ key: 'default', source: null, target: null, ladder: defaultLadder }] : []),
    ],
    schedulerParams: params.map(p => ({ key: paramKey(p.sourceLanguage, p.targetLanguage, p.answerField), source: p.sourceLanguage, target: p.targetLanguage, answerField: p.answerField, row: p })),
    decks,
    folders: allFolders,
    confusionLinks: links.map((l, i) => ({ ...l, id: (l as { id?: string }).id ?? `link-${i}` })),
    overrides: overrides.map(o => ({ key: overrideKey(o.cardId, o.answerSide, o.answerText), cardId: o.cardId, answerSide: o.answerSide, answerText: o.answerText })),
    deckCards: deckCardRows.map(r => ({ key: `${r.deck_id}:${r.card_id}`, deckId: r.deck_id, cardId: r.card_id })),
  }

  const bytes = estimateBundleBytes(bundle)
  await getLocalStore().hydrate(bundle)
  progress('Done', 1, 1)
  return { manifest, bytes }
}
