import { createClient } from '@/lib/supabase/client'
import type { Card, DeckId, CardId } from '@/domain'
import type { CardRepository, CreateCardInput } from './interfaces'

function rowToCard(row: Record<string, unknown>): Card {
  return {
    id:        row.id as string,
    deckId:    row.deck_id as string,
    front:     row.front as string,
    back:      row.back as string,
    hints:     (row.hints as string[]) ?? [],
    choices:   (row.choices as Card['choices']) ?? null,
    position:  row.position as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: row.deleted_at as string | null,
  }
}

export class SupabaseCardRepository implements CardRepository {
  private get db() { return createClient() }

  async listByDeck(deckId: DeckId): Promise<Card[]> {
    const { data, error } = await this.db.from('cards').select('*')
      .eq('deck_id', deckId).is('deleted_at', null).order('position')
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToCard)
  }

  async get(cardId: CardId): Promise<Card | null> {
    const { data, error } = await this.db.from('cards').select('*')
      .eq('id', cardId).is('deleted_at', null).single()
    if (error) return null
    return rowToCard(data)
  }

  async bulkCreate(deckId: DeckId, inputs: CreateCardInput[]): Promise<Card[]> {
    const rows = inputs.map(i => ({ deck_id: deckId, front: i.front, back: i.back, hints: i.hints ?? [], position: i.position }))
    const { data, error } = await this.db.from('cards').insert(rows).select()
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToCard)
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
