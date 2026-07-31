import { createClient } from '@/lib/supabase/client'

interface PendingSynonymLink {
  id:             string
  userId:         string
  sourceWord:     string
  sourceLanguage: string
  targetLanguage: string
  linkedCardId:   string
  createdAt:      string
}

function rowToLink(row: Record<string, unknown>): PendingSynonymLink {
  return {
    id:             row.id             as string,
    userId:         row.user_id        as string,
    sourceWord:     row.source_word    as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    linkedCardId:   row.linked_card_id as string,
    createdAt:      row.created_at     as string,
  }
}

export class SupabasePendingSynonymLinkRepository {
  private supabase = createClient()

  async create(
    userId:         string,
    sourceWord:     string,
    sourceLanguage: string,
    targetLanguage: string,
    linkedCardId:   string,
  ): Promise<PendingSynonymLink> {
    const { data, error } = await this.supabase
      .from('pending_synonym_links')
      .upsert(
        { user_id: userId, source_word: sourceWord, source_language: sourceLanguage, target_language: targetLanguage, linked_card_id: linkedCardId },
        { onConflict: 'user_id,source_word,source_language,target_language,linked_card_id', ignoreDuplicates: false },
      )
      .select()
      .single()
    if (error) throw new Error(error.message)
    return rowToLink(data as Record<string, unknown>)
  }

  /** Find all pending links where source_word matches the given front text (case-insensitive). */
  async findByWord(
    userId:         string,
    sourceWord:     string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<PendingSynonymLink[]> {
    const { data, error } = await this.supabase
      .from('pending_synonym_links')
      .select('*')
      .eq('user_id', userId)
      .ilike('source_word', sourceWord)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
    if (error) throw new Error(error.message)
    return (data as Record<string, unknown>[]).map(rowToLink)
  }

  async deleteById(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('pending_synonym_links')
      .delete()
      .eq('id', id)
    if (error) throw new Error(error.message)
  }
}
