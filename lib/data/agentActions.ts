import { createClient } from '@/lib/supabase/client'
import type { AgentAction, UserId } from '@/domain'
import type { AgentActionRepository } from './interfaces'

function rowToAction(row: Record<string, unknown>): AgentAction {
  return {
    id:        row.id as string,
    userId:    row.user_id as string,
    actor:     row.actor as string,
    operation: row.operation as AgentAction['operation'],
    cardId:    (row.card_id as string | null) ?? null,
    deckId:    (row.deck_id as string | null) ?? null,
    before:    row.before ?? null,
    after:     row.after ?? null,
    dryRun:    Boolean(row.dry_run),
    createdAt: row.created_at as string,
  }
}

export class SupabaseAgentActionRepository implements AgentActionRepository {
  private get db() { return createClient() }

  async record(action: Omit<AgentAction, 'id' | 'createdAt'>): Promise<void> {
    const { error } = await this.db.from('agent_actions').insert({
      user_id:   action.userId,
      actor:     action.actor,
      operation: action.operation,
      card_id:   action.cardId,
      deck_id:   action.deckId,
      before:    action.before ?? null,
      after:     action.after ?? null,
      dry_run:   action.dryRun,
    })
    if (error) throw new Error(error.message)
  }

  async listForUser(userId: UserId, limit = 100): Promise<AgentAction[]> {
    const { data, error } = await this.db.from('agent_actions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToAction)
  }
}
