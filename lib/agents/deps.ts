/**
 * lib/agents/deps.ts — wires the real Supabase repositories into a `GatewayDeps`
 * bundle for the gateway. Kept separate from `gateway.ts` so the gateway logic
 * stays framework-free and unit-testable with in-memory fakes.
 */

import type { GatewayDeps } from './gateway'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseAgentActionRepository } from '@/lib/data/agentActions'

export function createSupabaseGatewayDeps(): GatewayDeps {
  const decks   = new SupabaseDeckRepository()
  const folders = new SupabaseFolderRepository()
  const cards   = new SupabaseCardRepository()
  const audit   = new SupabaseAgentActionRepository()

  return {
    listDecks:   userId => decks.list(userId),
    listFolders: userId => folders.list(userId),
    listCards:   deckId => cards.listByDeck(deckId),
    getCard:     cardId => cards.get(cardId),
    updateCard:  (cardId, patch) => cards.update(cardId, patch),
    createCard:  async (deck, ownerId, front, back, position) => {
      const [created] = await cards.bulkCreate(
        deck.id, ownerId, deck.sourceLanguage, deck.targetLanguage,
        [{ front, back, position }],
      )
      if (!created) throw new Error('createCard: bulkCreate returned no card')
      return created
    },
    deleteCard:  cardId => cards.softDelete(cardId),
    recordAction: action => audit.record(action),
  }
}
