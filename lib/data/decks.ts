import { createClient } from '@/lib/supabase/client'
import type { Deck, UserId, DeckId, GradingSettings } from '@/domain'
import { DEFAULT_GRADING_SETTINGS } from '@/domain'
import type { DeckRepository, CreateDeckInput } from './interfaces'

function rowToDeck(row: Record<string, unknown>): Deck {
  return {
    id:              row.id as string,
    ownerId:         row.owner_id as string,
    name:            row.name as string,
    sourceLanguage:  row.source_language as string,
    targetLanguage:  row.target_language as string,
    pipelineId:      row.pipeline_id as string,
    gradingSettings: (row.grading_settings as GradingSettings) ?? DEFAULT_GRADING_SETTINGS,
    isPublic:        row.is_public as boolean,
    isPinned:        (row.is_pinned as boolean) ?? false,
    folderId:        (row.folder_id as string | null) ?? null,
    position:        (row.position as number) ?? 0,
    createdAt:       row.created_at as string,
    updatedAt:       row.updated_at as string,
    deletedAt:       row.deleted_at as string | null,
  }
}

export class SupabaseDeckRepository implements DeckRepository {
  private get db() { return createClient() }

  async list(userId: UserId): Promise<Deck[]> {
    const { data, error } = await this.db.from('decks').select('*')
      .eq('owner_id', userId).is('deleted_at', null).order('position', { ascending: true })
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToDeck)
  }

  async listPublic(query?: string): Promise<Deck[]> {
    let q = this.db.from('decks').select('*').eq('is_public', true).is('deleted_at', null)
    if (query) q = q.ilike('name', `%${query}%`)
    const { data, error } = await q.order('name')
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToDeck)
  }

  async get(deckId: DeckId): Promise<Deck | null> {
    const { data, error } = await this.db.from('decks').select('*')
      .eq('id', deckId).is('deleted_at', null).single()
    if (error) return null
    return rowToDeck(data)
  }

  async create(userId: UserId, input: CreateDeckInput): Promise<Deck> {
    const { data, error } = await this.db.from('decks').insert({
      owner_id: userId, name: input.name,
      source_language: input.sourceLanguage,
      target_language: input.targetLanguage,
      pipeline_id: input.pipelineId,
    }).select().single()
    if (error) throw new Error(error.message)
    return rowToDeck(data)
  }

  async update(deckId: DeckId, patch: Partial<Pick<Deck, 'name' | 'gradingSettings' | 'pipelineId' | 'isPublic' | 'isPinned' | 'folderId' | 'position' | 'sourceLanguage' | 'targetLanguage'>>): Promise<Deck> {
    const update: Record<string, unknown> = {}
    if (patch.name            !== undefined) update.name             = patch.name
    if (patch.gradingSettings !== undefined) update.grading_settings = patch.gradingSettings
    if (patch.pipelineId      !== undefined) update.pipeline_id      = patch.pipelineId
    if (patch.isPublic        !== undefined) update.is_public        = patch.isPublic
    if (patch.isPinned        !== undefined) update.is_pinned        = patch.isPinned
    if ('folderId' in patch)                 update.folder_id        = patch.folderId ?? null
    if (patch.position        !== undefined) update.position         = patch.position
    if (patch.sourceLanguage  !== undefined) update.source_language  = patch.sourceLanguage
    if (patch.targetLanguage  !== undefined) update.target_language  = patch.targetLanguage
    const { data, error } = await this.db.from('decks').update(update).eq('id', deckId).select().single()
    if (error) throw new Error(error.message)
    return rowToDeck(data)
  }

  /** Bulk-update positions for reordering. */
  async updatePositions(updates: Array<{ id: string; position: number }>): Promise<void> {
    await Promise.all(
      updates.map(({ id, position }) =>
        this.db.from('decks').update({ position }).eq('id', id)
      )
    )
  }

  async softDelete(deckId: DeckId): Promise<void> {
    const { error } = await this.db.from('decks').update({ deleted_at: new Date().toISOString() }).eq('id', deckId)
    if (error) throw new Error(error.message)
  }
}
