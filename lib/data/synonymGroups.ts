import { createClient } from '@/lib/supabase/client'
import type { SynonymGroup, Card } from '@/domain'

function rowToSynonymGroup(row: Record<string, unknown>): SynonymGroup {
  return {
    id:           row.id as string,
    gloss:        row.gloss as string,
    glossLanguage: row.gloss_language as string,
    itemLanguage:  row.item_language as string,
    itemIds:       [],  // populated separately via cards.synonym_group_id
    createdAt:     row.created_at as string,
    updatedAt:     row.updated_at as string,
  }
}

export class SupabaseSynonymGroupRepository {
  private get db() { return createClient() }

  async get(id: string): Promise<SynonymGroup | null> {
    const { data, error } = await this.db.from('synonym_groups').select('*').eq('id', id).single()
    if (error) return null
    return rowToSynonymGroup(data)
  }

  async create(group: Omit<SynonymGroup, 'id' | 'itemIds' | 'createdAt' | 'updatedAt'>, ownerId: string): Promise<SynonymGroup> {
    const { data, error } = await this.db.from('synonym_groups').insert({
      gloss:          group.gloss,
      gloss_language: group.glossLanguage,
      item_language:  group.itemLanguage,
      owner_id:       ownerId,
    }).select().single()
    if (error) throw new Error(error.message)
    return rowToSynonymGroup(data)
  }

  /**
   * Fetch all synonym groups containing any of the given card IDs.
   * Returns a map from synonymGroupId → SynonymGroup with itemIds populated.
   */
  async listForCards(cardIds: string[]): Promise<Map<string, SynonymGroup>> {
    if (cardIds.length === 0) return new Map()

    // Find which synonym_group_ids these cards belong to.
    const { data: cardRows, error: cardError } = await this.db.from('cards')
      .select('id, synonym_group_id')
      .in('id', cardIds)
      .not('synonym_group_id', 'is', null)
    if (cardError) throw new Error(cardError.message)

    const groupIds = [...new Set(
      (cardRows ?? [])
        .map(r => (r as { synonym_group_id: string | null }).synonym_group_id)
        .filter((id): id is string => id !== null)
    )]
    if (groupIds.length === 0) return new Map()

    // Fetch the groups.
    const { data: groups, error: groupError } = await this.db.from('synonym_groups')
      .select('*').in('id', groupIds)
    if (groupError) throw new Error(groupError.message)

    // Fetch all cards that belong to these groups (to populate itemIds).
    const { data: allGroupCards, error: allCardsError } = await this.db.from('cards')
      .select('id, synonym_group_id')
      .in('synonym_group_id', groupIds)
      .is('deleted_at', null)
    if (allCardsError) throw new Error(allCardsError.message)

    const itemsByGroup = new Map<string, string[]>()
    for (const row of (allGroupCards ?? []) as { id: string; synonym_group_id: string }[]) {
      const arr = itemsByGroup.get(row.synonym_group_id) ?? []
      arr.push(row.id)
      itemsByGroup.set(row.synonym_group_id, arr)
    }

    const result = new Map<string, SynonymGroup>()
    for (const row of (groups ?? []) as Record<string, unknown>[]) {
      const group = rowToSynonymGroup(row)
      group.itemIds = itemsByGroup.get(group.id) ?? []
      result.set(group.id, group)
    }
    return result
  }

  /**
   * Link a card to a synonym group. Also handles creating the group if needed.
   */
  async addMember(synonymGroupId: string, cardId: string): Promise<void> {
    const { error } = await this.db.rpc('link_card_to_synonym_group', {
      p_card_id:          cardId,
      p_synonym_group_id: synonymGroupId,
    })
    if (error) throw new Error(error.message)
  }

  async removeMember(cardId: string): Promise<void> {
    const { error } = await this.db.from('cards')
      .update({ synonym_group_id: null })
      .eq('id', cardId)
    if (error) throw new Error(error.message)
  }

  /**
   * Auto-groups newly created cards with any owned card in the same language
   * pair that shares the exact same native gloss (`card.back`, case- and
   * whitespace-insensitive). For each distinct native text touched by a
   * `candidate` that ends up with ≥2 cards, links them all into one synonym
   * group — reusing an existing group if any member already belongs to one,
   * otherwise creating a new group.
   *
   * `itemLanguage` = language of `card.front` (the words that are synonyms of
   * one another). `glossLanguage` = language of `card.back` (the shared
   * meaning). Best-effort: individual failures are logged, not thrown.
   */
  async autoGroupByGloss(
    ownerId:       string,
    candidates:    Card[],
    libraryCards:  Card[],
    itemLanguage:  string,
    glossLanguage: string,
  ): Promise<void> {
    if (candidates.length === 0) return
    const norm = (s: string) => s.trim().toLowerCase()

    // All owned cards in this pair keyed by id (candidates may or may not
    // already appear in libraryCards depending on read timing — merge both).
    const allById = new Map<string, Card>()
    for (const c of [...libraryCards, ...candidates]) allById.set(c.id, c)

    // Bucket every owned card by its normalized native text.
    const byBack = new Map<string, Card[]>()
    for (const c of allById.values()) {
      const key = norm(c.back)
      if (!key) continue
      const arr = byBack.get(key) ?? []
      arr.push(c)
      byBack.set(key, arr)
    }

    // Only process native texts that at least one just-uploaded card carries.
    const candidateBacks = new Set(candidates.map(c => norm(c.back)).filter(Boolean))

    for (const key of candidateBacks) {
      const members = byBack.get(key) ?? []
      if (members.length < 2) continue
      try {
        // Reuse an existing group if any member already belongs to one.
        let groupId = members.find(c => c.synonymGroupId)?.synonymGroupId ?? null
        if (!groupId) {
          const gloss = (candidates.find(c => norm(c.back) === key)?.back ?? members[0]!.back).trim()
          const group = await this.create({ gloss, glossLanguage, itemLanguage }, ownerId)
          groupId = group.id
        }
        for (const c of members) {
          if (c.synonymGroupId === groupId) continue
          await this.addMember(groupId, c.id)
        }
      } catch (err) {
        console.error('autoGroupByGloss: failed to group native text', key, err)
      }
    }
  }
}
