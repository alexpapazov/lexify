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
import { fetchAllRows } from '@/lib/supabasePaged'

import { cardStateKey, ladderKey, paramKey, overrideKey } from './keys'
import { getLocalStore } from './localStore'
import type { DownloadBundle, Manifest, OfflineScope, StoredCardState } from './types'

// Distractor generation is one AI round-trip per card. Run a few in flight instead of strictly one at
// a time — the wall-clock is dominated by network latency, not local work, so this is close to a
// linear speed-up. Kept modest so we don't trip provider rate limits; a 429 falls back to deck
// siblings for that card, which is a silent quality loss, so speed isn't worth pushing much higher.
const AI_CONCURRENCY = 5
const DB_CONCURRENCY = 10   // plain row updates — cheap, no rate limit to respect

/** Ids per `.in(...)` request. Keeps the generated query string well short of URL-length limits. */
const IN_CHUNK = 400

/**
 * Fetch rows matching a large id list: chunks the ids so the `.in()` filter stays a sane URL length,
 * and pages each chunk so the 1000-row server cap can't silently truncate the result.
 */
async function fetchByIds<T>(
  ids: string[],
  run: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    out.push(...await fetchAllRows<T>((f, t) => run(chunk, f, t)))
  }
  return out
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, reporting completions to `onDone` as they
 * land (so progress still counts up smoothly even though work finishes out of order).
 */
async function mapLimit<T>(
  items: T[], limit: number, fn: (item: T) => Promise<void>, onDone: (completed: number) => void,
): Promise<void> {
  let next = 0, done = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try { await fn(items[i]!) } catch { /* per-item errors are handled by the caller's own try */ }
      onDone(++done)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

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
 * Which cards to bundle. By default only what you can actually study: every learnable card (no
 * graduated forward state → feeds the ladder), plus graduated cards due within `windowDays`. Dormant
 * cards are skipped since they're never due. That's why a deck whose cards are all graduated and not
 * due soon legitimately bundles nothing.
 *
 * `opts.includeGraduated` / `opts.includeDormant` override that — taking the whole library offline for
 * browsing/editing, at the cost of a much bigger bundle.
 */
export function selectOfflineCardIds(
  cards: { id: string }[], states: CardState[], nowMs: number, windowDays: number,
  opts: { includeGraduated?: boolean; includeDormant?: boolean } = {},
): Set<string> {
  const cutoff = nowMs + windowDays * DAY_MS
  const byCard = new Map<string, CardState[]>()
  for (const s of states) { const a = byCard.get(s.cardId) ?? []; a.push(s); byCard.set(s.cardId, a) }
  const out = new Set<string>()
  for (const c of cards) {
    const ss = byCard.get(c.id) ?? []
    const fwd = ss.find(s => s.reviewDirection !== 'reverse')
    if (!fwd || !fwd.graduated) { out.add(c.id); continue }   // unlearned / learning → include
    if (fwd.dormant) { if (opts.includeDormant) out.add(c.id); continue }
    if (opts.includeGraduated) { out.add(c.id); continue }     // all graduated, regardless of due date
    const dues = [fwd.smartDueAt, fwd.typedDueAt, fwd.dueAt,
      ...ss.filter(s => s.reviewDirection === 'reverse' && !s.dormant).flatMap(r => [r.recallDueAt, r.dueAt])]
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
  /** One or more scopes to download — the union of their decks is bundled (multi-select). */
  scopes:        OfflineScope[]
  dueWindowDays: number
  includeAudio:  boolean
  /** Opt in to cards that aren't studiable right now — see selectOfflineCardIds. */
  includeGraduated?: boolean
  includeDormant?:   boolean
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
  const deckIds = new Set(opts.scopes.flatMap(s => scopeDeckIds(s, allDecks, allFolders)))
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
  const selected = selectOfflineCardIds(allCards, states, Date.now(), opts.dueWindowDays,
    { includeGraduated: opts.includeGraduated, includeDormant: opts.includeDormant })
  const cards = allCards.filter(c => selected.has(c.id))
  const cardIds = [...selected]

  // Pre-generate distractors for cards missing them (best-effort; MCQ falls back to deck siblings).
  // Generated choices are also persisted back to the server card so a card that had no distractors
  // gains them for everyone — a direct Supabase write (not the offline-guarded repo) so it lands on
  // the server even if the offline flag is set (e.g. during "Update download").
  const missing = cards.filter(c => needsChoices(c, 'front') || needsChoices(c, 'back'))
  // Group siblings by pair ONCE. Re-filtering the whole card list per card made this O(n²) — with a
  // couple thousand cards that's millions of comparisons, which is very noticeable on a phone.
  const siblingsByPair = new Map<string, typeof cards>()
  for (const c of cards) {
    const k = `${c.sourceLanguage}|${c.targetLanguage}`
    const a = siblingsByPair.get(k)
    if (a) a.push(c); else siblingsByPair.set(k, [c])
  }

  const persistBack: { id: string; choices: unknown }[] = []
  await mapLimit(missing, AI_CONCURRENCY, async c => {
    const siblings = siblingsByPair.get(`${c.sourceLanguage}|${c.targetLanguage}`) ?? []
    const side = needsChoices(c, 'front') ? 'front' : 'back'
    try {
      const choices = await ensureChoicesGenerated(c, side, siblings, c.sourceLanguage, c.targetLanguage)
      if (choices) {
        cardsById.set(c.id, { ...cardsById.get(c.id)!, choices })
        // Persist EVERY generated card (not only ones that had zero choices) — a card with partial/legacy
        // choices would otherwise keep failing needsChoices() and regenerate on every single download.
        persistBack.push({ id: c.id, choices })
      }
    } catch { /* keep fallback */ }
  }, n => progress('Generating distractors', n, missing.length))

  // Upload the newly generated distractors to the library (guaranteed server write).
  await mapLimit(persistBack, DB_CONCURRENCY, async ({ id, choices }) => {
    try { await supabase.from('cards').update({ choices }).eq('id', id) } catch { /* best-effort */ }
  }, n => progress('Saving distractors', n, persistBack.length))
  const finalCards = cardIds.map(id => cardsById.get(id)!).map(c => opts.includeAudio ? c : stripAudio(c))

  // Sync baselines (server updated_at) for the conflicting tables + the deck↔card join.
  progress('Packaging', 0, 1)
  const stateMeta = new Map<string, string>()
  const climbRows: { card_id: string; deck_id: string; state: unknown; updated_at: string }[] = []
  const deckCardRows: { deck_id: string; card_id: string }[] = []
  if (cardIds.length > 0) {
    // These three routinely exceed Supabase's 1000-row cap on a real library, and `.limit()` does NOT
    // lift it — it silently truncates. Truncated `deck_cards` was leaving most cards unlinked from
    // their deck (decks read as empty offline); truncated `card_states` was worse, since its
    // `updated_at` is the baseline conflict detection compares against, so missing rows would let an
    // offline edit quietly overwrite a newer server change. Page every one, and chunk the id lists so
    // a 2000-element `.in()` doesn't build a query string long enough to be rejected.
    type SuRow = { card_id: string; review_direction: string; updated_at: string }
    type ClRow = { card_id: string; deck_id: string; state: unknown; updated_at: string }
    type DcRow = { deck_id: string; card_id: string }
    const [su, cl, dc] = await Promise.all([
      fetchByIds<SuRow>(cardIds, (ids, f, t) => supabase.from('card_states')
        .select('card_id, review_direction, updated_at').in('card_id', ids).order('card_id').range(f, t)),
      fetchByIds<ClRow>(cardIds, (ids, f, t) => supabase.from('ladder_climb')
        .select('card_id, deck_id, state, updated_at').in('card_id', ids).order('card_id').range(f, t)),
      fetchAllRows<DcRow>((f, t) => supabase.from('deck_cards')
        .select('deck_id, card_id').in('deck_id', [...deckIds]).order('card_id').range(f, t)),
    ])
    for (const r of su) stateMeta.set(cardStateKey(r.card_id, r.review_direction), r.updated_at)
    for (const r of cl) climbRows.push(r)
    for (const r of dc) if (selected.has(r.card_id)) deckCardRows.push(r)
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

  // Per-deck study settings. Without these the offline deck page reads "0 new/day" and the ladder
  // silently uses defaults instead of the batch size / spillover / audio settings you configured.
  const { data: prefRows } = await supabase
    .from('user_deck_preferences').select('*').eq('user_id', uid).in('deck_id', [...deckIds])

  const manifest: Manifest = {
    userId: uid, scope: opts.scopes[0] ?? { kind: 'library' }, scopes: opts.scopes,
    dueWindowDays: opts.dueWindowDays, includeAudio: opts.includeAudio,
    includeGraduated: opts.includeGraduated ?? false, includeDormant: opts.includeDormant ?? false,
    downloadedAt: new Date().toISOString(), cardCount: finalCards.length,
  }
  // Only bundle folders that (transitively) contain a downloaded deck — plus their ancestors so the
  // tree is navigable — so the offline library shows just the relevant folders, not every language's.
  const folderById = new Map(allFolders.map(f => [f.id, f]))
  const keepFolders = new Set<string>()
  for (const d of decks) {
    let fid: string | null = d.folderId
    while (fid && !keepFolders.has(fid)) { keepFolders.add(fid); fid = folderById.get(fid)?.parentId ?? null }
  }
  const scopedFolders = allFolders.filter(f => keepFolders.has(f.id))

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
    folders: scopedFolders,
    confusionLinks: links.map((l, i) => ({ ...l, id: (l as { id?: string }).id ?? `link-${i}` })),
    overrides: overrides.map(o => ({ key: overrideKey(o.cardId, o.answerSide, o.answerText), cardId: o.cardId, answerSide: o.answerSide, answerText: o.answerText })),
    deckCards: deckCardRows.map(r => ({ key: `${r.deck_id}:${r.card_id}`, deckId: r.deck_id, cardId: r.card_id })),
    // Keyed by deckId so the local store can look prefs up directly by deck.
    deckPreferences: (prefRows ?? []).map(r => ({ key: r.deck_id as string, deckId: r.deck_id as string, prefs: r })),
  }

  const bytes = estimateBundleBytes(bundle)
  manifest.bytes = bytes
  await getLocalStore().hydrate(bundle)
  progress('Done', 1, 1)
  return { manifest, bytes }
}
