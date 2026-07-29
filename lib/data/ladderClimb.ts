import { createClient } from '@/lib/supabase/client'
import type { UserId, CardId, DeckId } from '@/domain'
import type { ClimbState } from '@/engine/ladderEngine'
import type { RouteState } from '@/engine/pathwayEngine'
import { isOfflineActive } from '@/lib/offline/mode'
import { getLocalStore } from '@/lib/offline/localStore'
import { localClimbForCards, localSaveClimb, localRemoveClimb } from '@/lib/offline/localRepos'
import { cachedRead, invalidateReads, idsKey } from '@/lib/readCache'

export class SupabaseLadderClimbRepository {
  private get db() { return createClient() }

  /** Every climb row for the user in ONE paged query — avoids a per-deck `listForCards` fan-out. */
  async listAllForUser(userId: UserId): Promise<Map<string, ClimbState>> {
    const out = new Map<string, ClimbState>()
    if (isOfflineActive()) {
      for (const r of await getLocalStore().allClimb()) out.set(r.cardId, r.state as ClimbState)
      return out
    }
    return cachedRead(`climb:all:${userId}`, async () => {
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await this.db.from('ladder_climb')
          .select('card_id, state').eq('user_id', userId).order('card_id').range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        for (const r of data ?? []) out.set(r.card_id as string, r.state as ClimbState)
        if (!data || data.length < PAGE) break
      }
      return out
    })
  }

  /**
   * Climb rows for a set of cards. Chunked + paged: a whole-language ladder scope passes ~1000+ ids,
   * and a single `.in()` that size builds a query string tens of KB long that the server rejects
   * outright (which used to surface as the ladder hanging on "Loading session…"). Even when it
   * squeaked through, the 1000-row cap would silently drop climbs and restart cards at rung 1.
   */
  async listForCards(userId: UserId, cardIds: CardId[]): Promise<Map<string, ClimbState>> {
    if (isOfflineActive()) return localClimbForCards(cardIds)
    if (cardIds.length === 0) return new Map()
    return cachedRead(`climb:cards:${userId}:${idsKey(cardIds)}`, async () => {
    const CHUNK = 400, PAGE = 1000
    const out = new Map<string, ClimbState>()
    // Chunks exist to bound the `.in()` query string, not to serialize — run them in parallel.
    // (Paging within a chunk stays serial: page n+1's offset depends on page n being full.)
    const chunks: CardId[][] = []
    for (let i = 0; i < cardIds.length; i += CHUNK) chunks.push(cardIds.slice(i, i + CHUNK))
    const perChunk = await Promise.all(chunks.map(async chunk => {
      const rows: { card_id: string; state: ClimbState }[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await this.db.from('ladder_climb')
          .select('card_id, state').eq('user_id', userId).in('card_id', chunk)
          .order('card_id').range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        for (const r of data ?? []) rows.push({ card_id: r.card_id as string, state: r.state as ClimbState })
        if (!data || data.length < PAGE) break
      }
      return rows
    }))
    for (const rows of perChunk) for (const r of rows) out.set(r.card_id, r.state)
    return out
    })
  }

  // `state` is opaque JSON — a ClimbState (ladder) or a RouteState (pathway); the row stores either.
  async save(userId: UserId, cardId: CardId, deckId: DeckId, state: ClimbState | RouteState): Promise<void> {
    invalidateReads('climb:')
    if (isOfflineActive()) return localSaveClimb(cardId, deckId, state as ClimbState)
    const { error } = await this.db.from('ladder_climb').upsert(
      { user_id: userId, card_id: cardId, deck_id: deckId, state, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,card_id' },
    )
    if (error) throw new Error(error.message)
  }

  /** Removes a card's climb row so it restarts from the CURRENT ladder config next time. */
  async remove(userId: UserId, cardId: CardId): Promise<void> {
    invalidateReads('climb:')
    if (isOfflineActive()) return localRemoveClimb(cardId)
    const { error } = await this.db.from('ladder_climb')
      .delete().eq('user_id', userId).eq('card_id', cardId)
    if (error) throw new Error(error.message)
  }
}
