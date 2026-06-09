import { createClient } from '@/lib/supabase/client'
import type { Folder, UserId, FolderId } from '@/domain'

function rowToFolder(row: Record<string, unknown>): Folder {
  return {
    id:        row.id as string,
    ownerId:   row.owner_id as string,
    name:      row.name as string,
    parentId:  row.parent_id as string | null,
    position:  row.position as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: row.deleted_at as string | null,
  }
}

export class SupabaseFolderRepository {
  private get db() { return createClient() }

  /** All non-deleted folders for the user — flat list, tree built in UI. */
  async list(userId: UserId): Promise<Folder[]> {
    const { data, error } = await this.db
      .from('folders')
      .select('*')
      .eq('owner_id', userId)
      .is('deleted_at', null)
      .order('position')
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToFolder)
  }

  async create(userId: UserId, name: string, parentId: FolderId | null): Promise<Folder> {
    const { data, error } = await this.db
      .from('folders')
      .insert({ owner_id: userId, name, parent_id: parentId })
      .select().single()
    if (error) throw new Error(error.message)
    return rowToFolder(data)
  }

  async rename(folderId: FolderId, name: string): Promise<Folder> {
    const { data, error } = await this.db
      .from('folders')
      .update({ name })
      .eq('id', folderId)
      .select().single()
    if (error) throw new Error(error.message)
    return rowToFolder(data)
  }

  /** Bulk-update positions for reordering. */
  async updatePositions(updates: Array<{ id: string; position: number }>): Promise<void> {
    await Promise.all(
      updates.map(({ id, position }) =>
        this.db.from('folders').update({ position }).eq('id', id)
      )
    )
  }

  /** Move a folder to a new parent (or null = root). */
  async updateParent(folderId: FolderId, parentId: FolderId | null): Promise<void> {
    const { error } = await this.db
      .from('folders')
      .update({ parent_id: parentId })
      .eq('id', folderId)
    if (error) throw new Error(error.message)
  }

  /** Fetch a single folder by ID. Returns null if not found. */
  async get(folderId: FolderId): Promise<Folder | null> {
    const { data, error } = await this.db
      .from('folders')
      .select('*')
      .eq('id', folderId)
      .is('deleted_at', null)
      .single()
    if (error) return null
    return rowToFolder(data)
  }

  /** Soft-delete. All child folders cascade due to ON DELETE CASCADE. */
  async softDelete(folderId: FolderId): Promise<void> {
    const { error } = await this.db
      .from('folders')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', folderId)
    if (error) throw new Error(error.message)
  }
}
