import { createClient } from '@/lib/supabase/client'
import type { Ladder, Rung, UserId } from '@/domain'
import { isOfflineActive } from '@/lib/offline/mode'
import { localLadderForPair, localAllLadders, localSaveLadder, localResetLadder } from '@/lib/offline/localRepos'

/** The default ladder is stored under empty-string source/target. */
const DEFAULT_KEY = { source: '', target: '' }

function rowToLadder(row: Record<string, unknown>): Ladder {
  return {
    rungs: (row.rungs as Rung[]) ?? [],
    betweenRungWaitSeconds: (row.between_rung_wait_seconds as number | null) ?? 180,
  }
}

export class SupabaseLadderRepository {
  private get db() { return createClient() }

  /** The ladder saved for a specific pair, or null if none. */
  async getForPair(userId: UserId, source: string, target: string): Promise<Ladder | null> {
    if (isOfflineActive()) return localLadderForPair(source, target)
    const { data, error } = await this.db.from('learning_ladders')
      .select('*').eq('user_id', userId).eq('source_language', source).eq('target_language', target).maybeSingle()
    if (error) throw new Error(error.message)
    return data ? rowToLadder(data) : null
  }

  /** The user's default ladder (seeds new languages), or null if none set. */
  async getDefault(userId: UserId): Promise<Ladder | null> {
    return this.getForPair(userId, DEFAULT_KEY.source, DEFAULT_KEY.target)
  }

  /** Every saved ladder (including the default), for listing which pairs are customized. */
  async list(userId: UserId): Promise<{ source: string; target: string; ladder: Ladder }[]> {
    if (isOfflineActive()) return localAllLadders()
    const { data, error } = await this.db.from('learning_ladders').select('*').eq('user_id', userId)
    if (error) throw new Error(error.message)
    return (data ?? []).map(r => ({ source: r.source_language as string, target: r.target_language as string, ladder: rowToLadder(r) }))
  }

  async saveForPair(userId: UserId, source: string, target: string, ladder: Ladder): Promise<void> {
    if (isOfflineActive()) return localSaveLadder(source, target, ladder)
    const { error } = await this.db.from('learning_ladders').upsert(
      { user_id: userId, source_language: source, target_language: target, rungs: ladder.rungs, between_rung_wait_seconds: ladder.betweenRungWaitSeconds ?? 180, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,source_language,target_language' },
    )
    if (error) throw new Error(error.message)
  }

  async saveDefault(userId: UserId, ladder: Ladder): Promise<void> {
    return this.saveForPair(userId, DEFAULT_KEY.source, DEFAULT_KEY.target, ladder)
  }

  /** Removes a pair's custom ladder so it falls back to the default again. */
  async resetPair(userId: UserId, source: string, target: string): Promise<void> {
    if (isOfflineActive()) return localResetLadder(source, target)
    const { error } = await this.db.from('learning_ladders')
      .delete().eq('user_id', userId).eq('source_language', source).eq('target_language', target)
    if (error) throw new Error(error.message)
  }
}
