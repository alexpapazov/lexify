import { createClient } from '@/lib/supabase/client'
import type { CardConfusionLink, ConfusionKind, ConfusionSimilarityTag, UserId, CardId } from '@/domain'
import { isOfflineActive } from '@/lib/offline/mode'

function rowToLink(row: Record<string, unknown>): CardConfusionLink {
  return {
    id:        row.id         as string,
    userId:    row.user_id    as string,
    cardAId:   row.card_a_id  as string,
    cardBId:   row.card_b_id  as string,
    kind:      (row.kind as ConfusionKind) ?? 'intra',
    tags:      (row.tags as ConfusionSimilarityTag[]) ?? [],
    createdAt: row.created_at as string,
  }
}

export class SupabaseCardConfusionLinkRepository {
  private get db() { return createClient() }

  /** Create a bidirectional confusion link. Normalises order; ignores duplicate (first tags/kind win). */
  async link(userId: UserId, cardIdX: CardId, cardIdY: CardId, kind: ConfusionKind = 'intra', tags: ConfusionSimilarityTag[] = []): Promise<void> {
    const [a, b] = [cardIdX, cardIdY].sort() as [CardId, CardId]
    const { error } = await this.db
      .from('card_confusion_links')
      .upsert(
        { user_id: userId, card_a_id: a, card_b_id: b, kind, tags },
        { onConflict: 'user_id,card_a_id,card_b_id', ignoreDuplicates: true },
      )
    if (error) throw new Error(error.message)
  }

  /** Return every confusion link for the user (for interleaving, distractors, the distinguish tool). */
  async listForUser(userId: UserId): Promise<CardConfusionLink[]> {
    if (isOfflineActive()) return []   // confusion interleaving is a best-effort online extra
    const { data, error } = await this.db
      .from('card_confusion_links')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return (data as Record<string, unknown>[]).map(rowToLink)
  }

  /** Return all confusion links that involve the given card. */
  async listForCard(userId: UserId, cardId: CardId): Promise<CardConfusionLink[]> {
    const { data, error } = await this.db
      .from('card_confusion_links')
      .select('*')
      .eq('user_id', userId)
      .or(`card_a_id.eq.${cardId},card_b_id.eq.${cardId}`)
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return (data as Record<string, unknown>[]).map(rowToLink)
  }

  async unlink(userId: UserId, cardIdX: CardId, cardIdY: CardId): Promise<void> {
    const [a, b] = [cardIdX, cardIdY].sort() as [CardId, CardId]
    const { error } = await this.db
      .from('card_confusion_links')
      .delete()
      .eq('user_id', userId)
      .eq('card_a_id', a)
      .eq('card_b_id', b)
    if (error) throw new Error(error.message)
  }
}
