/**
 * lib/data/savedLearningConfigs.ts — the named ladder/pathway library (migration 108).
 *
 * Separate from `learning_ladders` / `learning_pathways`, which hold what each pair is ACTIVELY
 * studying. Saving here never touches a pair's live config, and loading is an explicit act in the
 * editor followed by a normal save.
 *
 * ONLINE ONLY — the ladders settings page is online-only already (offline is always ladder mode).
 */

import { createClient } from '@/lib/supabase/client'
import { cachedRead, invalidateReads } from '@/lib/readCache'
import type { Ladder, Pathway, UserId } from '@/domain'

export type SavedConfigKind = 'ladder' | 'pathway'

export interface SavedLearningConfig {
  id:        string
  userId:    UserId
  kind:      SavedConfigKind
  name:      string
  /** Opaque `Ladder` or `Pathway`, per `kind`. */
  config:    Ladder | Pathway
  createdAt: string
  updatedAt: string
}

function rowToSaved(row: Record<string, unknown>): SavedLearningConfig {
  return {
    id:        row.id as string,
    userId:    row.user_id as string,
    kind:      row.kind as SavedConfigKind,
    name:      row.name as string,
    config:    row.config as Ladder | Pathway,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export class SupabaseSavedLearningConfigRepository {
  private get db() { return createClient() }

  /** Everything the user has saved of one kind, most recently updated first. */
  async list(userId: UserId, kind: SavedConfigKind): Promise<SavedLearningConfig[]> {
    return cachedRead(`savedconfigs:${userId}:${kind}`, async () => {
      const { data, error } = await this.db.from('saved_learning_configs')
        .select('*').eq('user_id', userId).eq('kind', kind)
        .order('updated_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []).map(rowToSaved)
    })
  }

  /**
   * Saves under a name. Re-using a name OVERWRITES that entry (the unique constraint makes this an
   * upsert) — saving twice under one name should mean "update it", not silently fork into two
   * indistinguishable rows in the picker.
   */
  async save(userId: UserId, kind: SavedConfigKind, name: string, config: Ladder | Pathway): Promise<SavedLearningConfig> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Give it a name first.')
    invalidateReads('savedconfigs:')
    const { data, error } = await this.db.from('saved_learning_configs')
      .upsert(
        { user_id: userId, kind, name: trimmed, config, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,kind,name' },
      )
      .select().single()
    if (error) throw new Error(error.message)
    return rowToSaved(data)
  }

  async remove(id: string): Promise<void> {
    invalidateReads('savedconfigs:')
    const { error } = await this.db.from('saved_learning_configs').delete().eq('id', id)
    if (error) throw new Error(error.message)
  }
}
