import { createClient } from '@/lib/supabase/client'
import type { ChangeSet, ChangeSetItem, ChangeSetStatus, ChangeItemStatus, ChangeProposal, UserId } from '@/domain'

function rowToItem(row: Record<string, unknown>): ChangeSetItem {
  return {
    id:          row.id as string,
    changeSetId: row.change_set_id as string,
    proposal:    row.proposal as ChangeProposal,
    status:      row.status as ChangeItemStatus,
    error:       (row.error as string | null) ?? null,
  }
}

function rowToSet(row: Record<string, unknown>, items: ChangeSetItem[]): ChangeSet {
  return {
    id:        row.id as string,
    userId:    row.user_id as string,
    agent:     row.agent as string,
    task:      row.task as string,
    summary:   row.summary as string,
    status:    row.status as ChangeSetStatus,
    createdAt: row.created_at as string,
    items,
  }
}

export class SupabaseChangeSetRepository {
  private get db() { return createClient() }

  /** Persists a change set and its proposal items; returns the created set. */
  async create(userId: UserId, agent: string, task: string, summary: string, proposals: ChangeProposal[]): Promise<ChangeSet> {
    const { data: setRow, error } = await this.db.from('change_sets')
      .insert({ user_id: userId, agent, task, summary })
      .select().single()
    if (error) throw new Error(error.message)
    let items: ChangeSetItem[] = []
    if (proposals.length > 0) {
      const { data: itemRows, error: itemErr } = await this.db.from('change_set_items')
        .insert(proposals.map(p => ({ change_set_id: setRow.id, proposal: p })))
        .select()
      if (itemErr) throw new Error(itemErr.message)
      items = (itemRows ?? []).map(rowToItem)
    }
    return rowToSet(setRow, items)
  }

  async get(changeSetId: string): Promise<ChangeSet | null> {
    const { data: setRow, error } = await this.db.from('change_sets').select('*').eq('id', changeSetId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!setRow) return null
    const { data: itemRows, error: itemErr } = await this.db.from('change_set_items')
      .select('*').eq('change_set_id', changeSetId).order('created_at', { ascending: true })
    if (itemErr) throw new Error(itemErr.message)
    return rowToSet(setRow, (itemRows ?? []).map(rowToItem))
  }

  async listForUser(userId: UserId, limit = 50): Promise<Omit<ChangeSet, 'items'>[]> {
    const { data, error } = await this.db.from('change_sets')
      .select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit)
    if (error) throw new Error(error.message)
    return (data ?? []).map(r => rowToSet(r, []))
  }

  async setItemStatus(itemId: string, status: ChangeItemStatus, error?: string | null): Promise<void> {
    const { error: err } = await this.db.from('change_set_items')
      .update({ status, error: error ?? null }).eq('id', itemId)
    if (err) throw new Error(err.message)
  }

  async setStatus(changeSetId: string, status: ChangeSetStatus): Promise<void> {
    const { error } = await this.db.from('change_sets').update({ status }).eq('id', changeSetId)
    if (error) throw new Error(error.message)
  }
}
