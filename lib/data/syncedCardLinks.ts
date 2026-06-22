import { createClient } from '@/lib/supabase/client'
import type { SyncedCardLink, CardId } from '@/domain'

function rowToLink(row: Record<string, unknown>): SyncedCardLink {
  return {
    id:                row.id as string,
    userId:            row.user_id as string,
    sourceCardId:      row.source_card_id as string,
    syncedCardId:      row.synced_card_id as string | null,
    sourcePairId:      row.source_pair_id as string,
    destinationPairId: row.destination_pair_id as string,
    syncRuleId:        row.sync_rule_id as string,
    sourceFrontAtSync: row.source_front_at_sync as string,
    sourceBackAtSync:  row.source_back_at_sync as string,
    generatedFront:    row.generated_front as string,
    generatedBack:     row.generated_back as string,
    confidence:        row.confidence as number | null,
    warning:           row.warning as string | null,
    status:            row.status as SyncedCardLink['status'],
    createdAt:         row.created_at as string,
    updatedAt:         row.updated_at as string,
  }
}

export class SupabaseSyncedCardLinkRepository {
  private get db() { return createClient() }

  /** All links for a given source card (across all dest pairs). */
  async listForCard(sourceCardId: CardId): Promise<SyncedCardLink[]> {
    const { data, error } = await this.db
      .from('synced_card_links')
      .select('*')
      .eq('source_card_id', sourceCardId)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToLink)
  }

  async upsert(link: Omit<SyncedCardLink, 'id' | 'createdAt' | 'updatedAt'>): Promise<SyncedCardLink> {
    const { data, error } = await this.db
      .from('synced_card_links')
      .upsert({
        user_id:               link.userId,
        source_card_id:        link.sourceCardId,
        synced_card_id:        link.syncedCardId,
        source_pair_id:        link.sourcePairId,
        destination_pair_id:   link.destinationPairId,
        sync_rule_id:          link.syncRuleId,
        source_front_at_sync:  link.sourceFrontAtSync,
        source_back_at_sync:   link.sourceBackAtSync,
        generated_front:       link.generatedFront,
        generated_back:        link.generatedBack,
        confidence:            link.confidence,
        warning:               link.warning,
        status:                link.status,
      }, { onConflict: 'source_card_id,destination_pair_id' })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return rowToLink(data)
  }

  async dismiss(sourceCardId: CardId, destinationPairId: string): Promise<void> {
    const { error } = await this.db
      .from('synced_card_links')
      .update({ status: 'dismissed', synced_card_id: null })
      .eq('source_card_id', sourceCardId)
      .eq('destination_pair_id', destinationPairId)
    if (error) throw new Error(error.message)
  }
}
