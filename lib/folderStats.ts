import type { Folder, Deck, UserId } from '@/domain'
import type { CardRepository, CardStateRepository } from '@/lib/data/interfaces'

export interface FolderCounts {
  unlearned: number
  learning:  number
  graduated: number
  dueNow:    number
}

const EMPTY_COUNTS: FolderCounts = { unlearned: 0, learning: 0, graduated: 0, dueNow: 0 }

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
 * Whether `folderId` belongs in a given language-pairing view: either it
 * (recursively) contains at least one deck matching the pairing, or it
 * contains no decks at all (a brand-new/empty folder is shown in every
 * pairing until it's populated).
 */
export function folderMatchesPair(
  folderId: string,
  allFolders: Folder[],
  allDecks: Deck[],
  sourceLanguage: string,
  targetLanguage: string,
): boolean {
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
  const perDeck = await Promise.all(deckIds.map(async deckId => {
    const [cards, states] = await Promise.all([
      cardRepo.listByDeck(deckId),
      stateRepo.listByDeck(userId, deckId),
    ])
    const stateMap = new Map(states.map(s => [s.cardId, s]))
    return {
      unlearned: cards.filter(c => !stateMap.has(c.id)).length,
      learning:  states.filter(s => !s.graduated).length,
      graduated: states.filter(s => s.graduated).length,
      dueNow:    states.filter(s => s.graduated && s.dueAt && new Date(s.dueAt) <= now).length,
    }
  }))

  return perDeck.reduce((acc, s) => ({
    unlearned: acc.unlearned + s.unlearned,
    learning:  acc.learning  + s.learning,
    graduated: acc.graduated + s.graduated,
    dueNow:    acc.dueNow    + s.dueNow,
  }), { ...EMPTY_COUNTS })
}
