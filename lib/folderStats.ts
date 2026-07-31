import type { Folder, Deck, UserId, Card, CardState } from '@/domain'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import type { CardRepository, CardStateRepository } from '@/lib/data/interfaces'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildEnabledTracksMap, type EnabledTracks } from '@/lib/sessionLimits'
import { isCardStateDueNow } from '@/lib/dueStatus'
import { getToday } from '@/lib/dates'
import { createClient } from '@/lib/supabase/client'

export interface FolderCounts {
  unlearned: number
  learning:  number
  graduated: number
  dueNow:    number
  dormant:   number
}

const EMPTY_COUNTS: FolderCounts = { unlearned: 0, learning: 0, graduated: 0, dueNow: 0, dormant: 0 }

/**
 * IDs of every deck that lives directly inside `folderId` or any of its
 * (nested) subfolders.
 */
export function descendantDeckIds(folderId: string, allFolders: Folder[], allDecks: Deck[]): string[] {
  const folderIds = new Set<string>([folderId])
  const queue = [folderId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const f of allFolders) {
      if (f.parentId === current && !folderIds.has(f.id)) {
        folderIds.add(f.id)
        queue.push(f.id)
      }
    }
  }
  return allDecks.filter(d => d.folderId && folderIds.has(d.folderId)).map(d => d.id)
}

/**
 * Whether `folderId` belongs in a given language-pairing view.
 *
 * Priority:
 * 1. If the folder has an explicit language pair stamped on it → only show
 *    in that exact pair (fixes empty folders bleeding across languages).
 * 2. Otherwise fall back to deck-based detection: show if any descendant
 *    deck matches, or if there are no descendant decks at all (backward-
 *    compatible — pre-existing unlabelled folders stay visible everywhere).
 */
export function folderMatchesPair(
  folderId: string,
  allFolders: Folder[],
  allDecks: Deck[],
  sourceLanguage: string,
  targetLanguage: string,
): boolean {
  const folder = allFolders.find(f => f.id === folderId)
  if (folder?.sourceLanguage && folder.targetLanguage) {
    return folder.sourceLanguage === sourceLanguage && folder.targetLanguage === targetLanguage
  }
  const deckIds = descendantDeckIds(folderId, allFolders, allDecks)
  if (deckIds.length === 0) return true
  return allDecks.some(d =>
    deckIds.includes(d.id) && d.sourceLanguage === sourceLanguage && d.targetLanguage === targetLanguage
  )
}

/** The whole library preloaded once, so per-folder count computation needs no queries at all. */
interface LibraryBulk {
  cardsByDeck:  Map<string, Card[]>
  statesByCard: Map<string, CardState[]>
  climb:        Map<string, { rungIndex: number; graduated: boolean }>
  // Due-now context — so counts here match the Study dashboard / session exactly (see lib/dueStatus.ts).
  enabledByPair: Map<string, EnabledTracks>   // key `${src}|${tgt}`
  pairByDeck:    Map<string, string>          // deckId → `${src}|${tgt}`
  tz:            string
  today:         string                        // turnover-adjusted YYYY-MM-DD
}

/**
 * Loads every card / state / climb row for the user (plus the scheduler-track flags + profile tz needed
 * for an accurate Due Now count) and groups them by deck. Call this ONCE per page and hand the result to
 * every `computeDeckCounts` call, instead of letting each folder fan out its own per-deck fetches.
 */
export async function loadLibraryBulk(
  userId: UserId, decks: Deck[], cardRepo: CardRepository, stateRepo: CardStateRepository,
): Promise<LibraryBulk> {
  const climbRepo = new SupabaseLadderClimbRepository()
  const deckIds = decks.map(d => d.id)
  const [cards, states, climb, deckIdByCard, paramRows, profile] = await Promise.all([
    cardRepo.listAllForUser(userId),
    stateRepo.listAllForUser(userId),
    climbRepo.listAllForUser(userId).catch(() => new Map()),
    cardRepo.deckIdsByCard(deckIds),
    new SupabaseUserSchedulerParamsRepository().listForUser(userId).catch(() => []),
    Promise.resolve(createClient().from('profiles').select('timezone, day_turnover_hour').eq('user_id', userId).single())
      .then(r => r.data).catch(() => null),
  ])
  const cardsByDeck = new Map<string, Card[]>()
  for (const c of cards) {
    const dId = deckIdByCard.get(c.id)
    if (!dId) continue
    const arr = cardsByDeck.get(dId)
    if (arr) arr.push(c); else cardsByDeck.set(dId, [c])
  }
  const statesByCard = new Map<string, CardState[]>()
  for (const s of states) {
    const arr = statesByCard.get(s.cardId)
    if (arr) arr.push(s); else statesByCard.set(s.cardId, [s])
  }
  const tz = (profile?.timezone as string | null) ?? deviceTimeZone()
  const today = getToday(tz, (profile?.day_turnover_hour as number | null) ?? 0)
  const pairByDeck = new Map(decks.map(d => [d.id, `${d.sourceLanguage}|${d.targetLanguage}`]))
  return {
    cardsByDeck, statesByCard, climb: climb as LibraryBulk['climb'],
    enabledByPair: buildEnabledTracksMap(paramRows), pairByDeck, tz, today,
  }
}

/**
 * Aggregate unlearned/learning/graduated/due-now counts across the given
 * decks, mirroring the per-deck computation on the Study page.
 */
export async function computeDeckCounts(
  deckIds: string[],
  userId: UserId,
  cardRepo: CardRepository,
  stateRepo: CardStateRepository,
  bulk?: LibraryBulk,
): Promise<FolderCounts> {
  if (deckIds.length === 0) return { ...EMPTY_COUNTS }

  const climbRepo = new SupabaseLadderClimbRepository()
  const perDeck = await Promise.all(deckIds.map(async deckId => {
    // With `bulk` the whole library is already in memory → zero queries here. Without it we fall back
    // to the per-deck fetch, which is 3 round-trips PER DECK and is why the Library used to render
    // 0 0 0 0 0 until every folder's fan-out resolved. Callers rendering more than one folder should
    // always pass bulk (see loadLibraryBulk).
    const [cards, states] = bulk
      ? [bulk.cardsByDeck.get(deckId) ?? [], (bulk.cardsByDeck.get(deckId) ?? []).flatMap(c => bulk.statesByCard.get(c.id) ?? [])]
      : await Promise.all([cardRepo.listByDeck(deckId), stateRepo.listByDeck(userId, deckId)])
    const climb = bulk ? bulk.climb : await climbRepo.listForCards(userId, cards.map(c => c.id)).catch(() => new Map())
    const fwd = states.filter(s => s.reviewDirection !== 'reverse')
    const stateMap = new Map(fwd.map(s => [s.cardId, s]))
    const activeCardIds = new Set(cards.map(c => c.id))
    // Due-now context (from bulk) so the count matches the Study dashboard + session exactly. Without
    // bulk (rare single-deck fallback) we have no track flags/tz, so dueNow is left 0 — the real
    // callers (Library, folder view) always pass bulk.
    const tracks = bulk ? bulk.enabledByPair.get(bulk.pairByDeck.get(deckId) ?? '') : undefined
    const tz = bulk?.tz ?? 'UTC', today = bulk?.today ?? ''
    // Mirror the deck-detail page's statusOf: a card climbing the ladder (rung ≥ 1,
    // not graduated) counts as Learning even without a card_state row.
    const statusOf = (cardId: string): 'graduated' | 'dormant' | 'learning' | 'new' => {
      const s = stateMap.get(cardId)
      if (s?.dormant) return 'dormant'
      if (s?.graduated) return 'graduated'
      const cl = climb.get(cardId)
      // Any non-graduated forward state = in the pipeline (matches the deck page + Study dashboard), so a
      // booted-back / restored card is studyable via "Study Learning". A card climbing the ladder counts too.
      if ((cl && cl.rungIndex >= 1 && !cl.graduated) || (s && !s.graduated)) return 'learning'
      return 'new'
    }
    return {
      unlearned: cards.filter(c => statusOf(c.id) === 'new').length,
      learning:  cards.filter(c => statusOf(c.id) === 'learning').length,
      graduated: cards.filter(c => statusOf(c.id) === 'graduated').length,
      dormant:   cards.filter(c => statusOf(c.id) === 'dormant').length,
      dueNow:    today === '' ? 0 : states.filter(s =>
        activeCardIds.has(s.cardId) &&
        isCardStateDueNow(s, { tracks, tz, today, forwardState: stateMap.get(s.cardId) })
      ).length,
    }
  }))

  return perDeck.reduce((acc, s) => ({
    unlearned: acc.unlearned + s.unlearned,
    learning:  acc.learning  + s.learning,
    graduated: acc.graduated + s.graduated,
    dueNow:    acc.dueNow    + s.dueNow,
    dormant:   acc.dormant   + s.dormant,
  }), { ...EMPTY_COUNTS })
}
