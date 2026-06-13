import { createClient } from '@/lib/supabase/client'
import type { Card, DeckId, CardId, UserId } from '@/domain'
import type { CardRepository, CreateCardInput } from './interfaces'
import { tier1Match } from '@/lib/duplicates'

function rowToCard(row: Record<string, unknown>): Card {
  return {
    id:             row.id as string,
    ownerId:        row.owner_id as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    front:     row.front as string,
    back:      row.back as string,
    hints:     (row.hints as string[]) ?? [],
    choices:   (row.choices as Card['choices']) ?? null,
    position:  (row.position as number) ?? 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: row.deleted_at as string | null,
  }
}

export class SupabaseCardRepository implements CardRepository {
  private get db() { return createClient() }

  async listByDeck(deckId: DeckId): Promise<Card[]> {
    const { data, error } = await this.db.from('deck_cards')
      .select('position, cards(*)')
      .eq('deck_id', deckId)
      .order('position')
    if (error) throw new Error(error.message)

    return (data ?? [])
      .map(row => row as unknown as { position: number; cards: Record<string, unknown> | null })
      .filter(row => row.cards && row.cards.deleted_at === null)
      .map(row => ({ ...rowToCard(row.cards!), position: row.position }))
  }

  async get(cardId: CardId): Promise<Card | null> {
    const { data, error } = await this.db.from('cards').select('*')
      .eq('id', cardId).is('deleted_at', null).single()
    if (error) return null
    return rowToCard(data)
  }

  async listOwned(ownerId: UserId, sourceLanguage: string, targetLanguage: string): Promise<Card[]> {
    const { data, error } = await this.db.from('cards').select('*')
      .eq('owner_id', ownerId)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
      .is('deleted_at', null)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToCard)
  }

  async listDeckNamesForCards(cardIds: CardId[]): Promise<Record<string, string[]>> {
    if (cardIds.length === 0) return {}

    const { data, error } = await this.db.from('deck_cards')
      .select('card_id, decks(name, deleted_at)')
      .in('card_id', cardIds)
    if (error) throw new Error(error.message)

    const result: Record<string, string[]> = {}
    for (const row of (data ?? []) as unknown as { card_id: string; decks: { name: string; deleted_at: string | null } | null }[]) {
      if (!row.decks || row.decks.deleted_at !== null) continue
      const names = result[row.card_id] ?? (result[row.card_id] = [])
      names.push(row.decks.name)
    }
    return result
  }

  async bulkCreate(deckId: DeckId, ownerId: UserId, sourceLanguage: string, targetLanguage: string, inputs: CreateCardInput[]): Promise<Card[]> {
    if (inputs.length === 0) return []

    // Tier 1 (exact, silent) dedup against the user's existing library in
    // this language direction — reuse matches instead of inserting new rows.
    const existing = await this.listOwned(ownerId, sourceLanguage, targetLanguage)

    const results: Card[] = new Array(inputs.length)
    const toInsert: { input: CreateCardInput; index: number }[] = []

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!
      const match = existing.find(c => tier1Match(input, c))
        ?? results.slice(0, i).find((c): c is Card => !!c && tier1Match(input, c))
      if (match) {
        results[i] = match
      } else {
        toInsert.push({ input, index: i })
      }
    }

    if (toInsert.length > 0) {
      const rows = toInsert.map(({ input }) => ({
        owner_id:        ownerId,
        source_language: sourceLanguage,
        target_language: targetLanguage,
        front:           input.front,
        back:            input.back,
        hints:           input.hints ?? [],
        position:        input.position,
      }))
      const { data, error } = await this.db.from('cards').insert(rows).select()
      if (error) throw new Error(error.message)
      const created = (data ?? []).map(rowToCard)
      toInsert.forEach(({ index }, j) => { results[index] = created[j]! })
    }

    // Link every resulting card (new or reused) into this deck.
    const linkRows = inputs.map((input, i) => ({
      deck_id:  deckId,
      card_id:  results[i]!.id,
      position: input.position,
    }))
    const { error: linkError } = await this.db.from('deck_cards')
      .upsert(linkRows, { onConflict: 'deck_id,card_id', ignoreDuplicates: true })
    if (linkError) throw new Error(linkError.message)

    return results
  }

  async addToDeck(deckId: DeckId, cardId: CardId, position: number): Promise<void> {
    const { error } = await this.db.from('deck_cards')
      .upsert({ deck_id: deckId, card_id: cardId, position }, { onConflict: 'deck_id,card_id', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
  }

  async removeFromDeck(deckId: DeckId, cardId: CardId): Promise<void> {
    const { error } = await this.db.from('deck_cards')
      .delete().eq('deck_id', deckId).eq('card_id', cardId)
    if (error) throw new Error(error.message)
  }

  async update(cardId: CardId, patch: Partial<Pick<Card, 'front' | 'back' | 'hints' | 'choices'>>): Promise<Card> {
    const { data, error } = await this.db.from('cards').update(patch).eq('id', cardId).select().single()
    if (error) throw new Error(error.message)
    return rowToCard(data)
  }

  async softDelete(cardId: CardId): Promise<void> {
    const { error } = await this.db.from('cards').update({ deleted_at: new Date().toISOString() }).eq('id', cardId)
    if (error) throw new Error(error.message)
  }
}
