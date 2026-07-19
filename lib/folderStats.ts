import type { Folder, Deck, UserId } from '@/domain'
import type { CardRepository, CardStateRepository } from '@/lib/data/interfaces'
import { SupabaseLadderClimbRepository } from '@/lib/data/ladderClimb'

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

/**
 * Aggregate unlearned/learning/graduated/due-now counts across the given
 * decks, mirroring the per-deck computation on the Study page.
 */
export async function computeDeckCounts(
  deckIds: string[],
  userId: UserId,
  cardRepo: CardRepository,
  stateRepo: CardStateRepository,
): Promise<FolderCounts> {
  if (deckIds.length === 0) return { ...EMPTY_COUNTS }

  const now = new Date()
  const climbRepo = new SupabaseLadderClimbRepository()
  const perDeck = await Promise.all(deckIds.map(async deckId => {
    const [cards, states] = await Promise.all([
      cardRepo.listByDeck(deckId),
      stateRepo.listByDeck(userId, deckId),
    ])
    const climb = await climbRepo.listForCards(userId, cards.map(c => c.id)).catch(() => new Map())
    const fwd = states.filter(s => s.reviewDirection !== 'reverse')
    const stateMap = new Map(fwd.map(s => [s.cardId, s]))
    const activeCardIds = new Set(cards.map(c => c.id))
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
      dueNow:    states.filter(s =>
        activeCardIds.has(s.cardId) &&
        s.graduated && !stateMap.get(s.cardId)?.dormant && !s.dormant && s.dueAt && new Date(s.dueAt) <= now &&
        (s.reviewDirection !== 'reverse' || stateMap.get(s.cardId)?.graduated === true)
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
