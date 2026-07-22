import { createClient } from '@/lib/supabase/client'
import type { Pathway, UserId } from '@/domain'

/**
 * Persistence for Learning Pathways — mirrors `SupabaseLadderRepository` (one row per pair + a ''/''
 * default). Online-only for now: pathways aren't part of the offline bundle yet (Phase 1). The whole
 * `Pathway` graph is stored in the `pathway` JSONB column.
 */

const DEFAULT_KEY = { source: '', target: '' }

function rowToPathway(row: Record<string, unknown>): Pathway | null {
  const p = row.pathway as Partial<Pathway> | null
  if (!p || !Array.isArray(p.states) || p.states.length === 0) return null   // empty {} default = "not set"
  return {
    id:           (p.id as string) ?? 'pathway',
    startStateId: p.startStateId as string,
    states:       p.states,
    transitions:  p.transitions ?? [],
    betweenStateWaitSeconds: p.betweenStateWaitSeconds ?? 180,
  }
}

export class SupabasePathwayRepository {
  private get db() { return createClient() }

  async getForPair(userId: UserId, source: string, target: string): Promise<Pathway | null> {
    const { data, error } = await this.db.from('learning_pathways')
      .select('*').eq('user_id', userId).eq('source_language', source).eq('target_language', target).maybeSingle()
    if (error) throw new Error(error.message)
    return data ? rowToPathway(data) : null
  }

  async getDefault(userId: UserId): Promise<Pathway | null> {
    return this.getForPair(userId, DEFAULT_KEY.source, DEFAULT_KEY.target)
  }

  async saveForPair(userId: UserId, source: string, target: string, pathway: Pathway): Promise<void> {
    const { error } = await this.db.from('learning_pathways').upsert(
      { user_id: userId, source_language: source, target_language: target, pathway, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,source_language,target_language' },
    )
    if (error) throw new Error(error.message)
  }

  async saveDefault(userId: UserId, pathway: Pathway): Promise<void> {
    return this.saveForPair(userId, DEFAULT_KEY.source, DEFAULT_KEY.target, pathway)
  }

  /** Removes a pair's custom pathway so it falls back to the default again. */
  async resetPair(userId: UserId, source: string, target: string): Promise<void> {
    const { error } = await this.db.from('learning_pathways')
      .delete().eq('user_id', userId).eq('source_language', source).eq('target_language', target)
    if (error) throw new Error(error.message)
  }
}
