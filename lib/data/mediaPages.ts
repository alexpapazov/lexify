/**
 * lib/data/mediaPages.ts — per-photo rows of the background media pipeline (migration 131).
 * ONLINE ONLY. The client inserts rows after uploading each image; the Edge Function
 * (`media-worker`) claims them, writes results, and clears `storage_path` on completion.
 */

import { createClient } from '@/lib/supabase/client'
import type { MediaPage, UserId } from '@/domain'

function rowToPage(row: Record<string, unknown>): MediaPage {
  return {
    id:         row.id as string,
    userId:     row.user_id as string,
    entryId:    row.entry_id as string,
    pageIndex:  Number(row.page_index ?? 0),
    pageNumber: row.page_number != null ? Number(row.page_number) : null,
    status:     (row.status as MediaPage['status']) ?? 'pending',
    covered:    row.covered === true,
    result:     (row.result as Record<string, unknown> | null) ?? null,
    error:      (row.error as string | null) ?? null,
  }
}

export class SupabaseMediaPageRepository {
  private get db() { return createClient() }

  async createBatch(userId: UserId, entryId: string, pages: { pageIndex: number; storagePath: string }[]): Promise<void> {
    if (pages.length === 0) return
    const { error } = await this.db.from('media_pages').insert(pages.map(p => ({
      user_id: userId, entry_id: entryId, page_index: p.pageIndex, storage_path: p.storagePath,
    })))
    if (error) throw error
  }

  async listForEntry(entryId: string): Promise<MediaPage[]> {
    const { data, error } = await this.db
      .from('media_pages')
      .select('id, user_id, entry_id, page_index, page_number, status, covered, result, error')
      .eq('entry_id', entryId)
      .order('page_index')
    if (error) throw error
    return (data ?? []).map(r => rowToPage(r as Record<string, unknown>))
  }

  /** Lightweight progress for the Media tab's processing rows: entryId → {done, failed, total}. */
  async progressForEntries(entryIds: string[]): Promise<Map<string, { done: number; failed: number; total: number }>> {
    const out = new Map<string, { done: number; failed: number; total: number }>()
    if (entryIds.length === 0) return out
    const { data, error } = await this.db
      .from('media_pages')
      .select('entry_id, status')
      .in('entry_id', entryIds)
    if (error) return out
    for (const r of (data ?? []) as { entry_id: string; status: string }[]) {
      const agg = out.get(r.entry_id) ?? { done: 0, failed: 0, total: 0 }
      agg.total++
      if (r.status === 'done') agg.done++
      if (r.status === 'failed') agg.failed++
      out.set(r.entry_id, agg)
    }
    return out
  }
}
