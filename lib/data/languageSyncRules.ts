import { createClient } from '@/lib/supabase/client'
import type { LanguageSyncRule, UserId } from '@/domain'

function rowToRule(row: Record<string, unknown>): LanguageSyncRule {
  return {
    id:                            row.id as string,
    userId:                        row.user_id as string,
    sourcePairId:                  row.source_pair_id as string,
    destinationPairId:             row.destination_pair_id as string,
    enabled:                       row.enabled as boolean,
    mode:                          row.mode as LanguageSyncRule['mode'],
    trigger:                       row.trigger as LanguageSyncRule['trigger'],
    allowSyncedCardsToTriggerSync: row.allow_synced_cards_to_trigger_sync as boolean,
    createdAt:                     row.created_at as string,
    updatedAt:                     row.updated_at as string,
  }
}

export class SupabaseLanguageSyncRuleRepository {
  private get db() { return createClient() }

  /** All enabled sync rules for the user. */
  async listForUser(userId: UserId): Promise<LanguageSyncRule[]> {
    const { data, error } = await this.db
      .from('language_sync_rules')
      .select('*')
      .eq('user_id', userId)
      .order('created_at')
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToRule)
  }

  async upsert(rule: Omit<LanguageSyncRule, 'id' | 'createdAt' | 'updatedAt'>): Promise<LanguageSyncRule> {
    const { data, error } = await this.db
      .from('language_sync_rules')
      .upsert({
        user_id:                           rule.userId,
        source_pair_id:                    rule.sourcePairId,
        destination_pair_id:               rule.destinationPairId,
        enabled:                           rule.enabled,
        mode:                              rule.mode,
        trigger:                           rule.trigger,
        allow_synced_cards_to_trigger_sync: rule.allowSyncedCardsToTriggerSync,
      }, { onConflict: 'user_id,source_pair_id,destination_pair_id' })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return rowToRule(data)
  }

  async delete(ruleId: string): Promise<void> {
    const { error } = await this.db
      .from('language_sync_rules')
      .delete()
      .eq('id', ruleId)
    if (error) throw new Error(error.message)
  }
}
