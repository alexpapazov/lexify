import { createClient } from '@/lib/supabase/client'
import type { Card, DeckId, CardId, UserId } from '@/domain'
import type { CardRepository, CreateCardInput } from './interfaces'
import { tier1Match } from '@/lib/duplicates'
import { isOfflineActive } from '@/lib/offline/mode'
import { getLocalStore } from '@/lib/offline/localStore'
import { fetchAllRows } from '@/lib/supabasePaged'
import { localCardsByDeck, localGetCard, localUpdateCard } from '@/lib/offline/localRepos'

/**
 * Columns for whole-library reads: everything EXCEPT `audio_data` / `audio_sources`, which hold
 * base64 MP3s. `select('*')` across a few thousand cards drags tens of megabytes over the wire and is
 * far slower than the per-deck fan-out it replaced, even though it's fewer requests. Callers that need
 * a card's audio (the ℹ panel, playback) fetch that one card on demand.
 *
 * Cards from these bulk reads therefore have `audioData`/`audioSources` null — do NOT use them to
 * decide whether a card has audio.
 *
 * The same reasoning later removed the other bulk payload columns. `choices` (the cached AI
 * distractor pools + synonym lists) is the big one — it's a JSONB blob per card, and the whole-library
 * callers below only ever need identity, languages and front/back to count and search. `hints`,
 * `accepted_*_alternatives`, `synced_from_language(s)` and `origin_word(s)` came out for the same
 * reason: array/JSONB columns that no bulk consumer reads. Only the session pages read `choices`, and
 * they load per-deck via `listByDeck`, which still selects `*`.
 *
 * So bulk-read cards ALSO have `choices` null, `hints`/`acceptedFrontAlternatives`/
 * `acceptedBackAlternatives`/`syncedFromLanguages`/`originWords` empty — do NOT use a bulk card to
 * decide whether distractors have been generated, or you'll regenerate every card in the library.
 */
const BULK_CARD_COLUMNS =
  'id, owner_id, source_language, target_language, front, back, position, ' +
  'created_at, updated_at, deleted_at, synonym_group_id, register, region, ' +
  'audio_generated, audio_source, ipa'

function rowToCard(row: Record<string, unknown>): Card {
  return {
    id:             row.id as string,
    ownerId:        row.owner_id as string,
    sourceLanguage: row.source_language as string,
    targetLanguage: row.target_language as string,
    front:     row.front as string,
    back:      row.back as string,
    hints:     (row.hints as string[]) ?? [],
    choices:   (row.choices as Card['choices']) ?? null,
    position:  (row.position as number) ?? 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: row.deleted_at as string | null,
    synonymGroupId:            (row.synonym_group_id as string | null) ?? null,
    register:                  (row.register as Card['register']) ?? null,
    region:                    (row.region as string | null) ?? null,
    acceptedFrontAlternatives: Array.isArray(row.accepted_front_alternatives)
      ? (row.accepted_front_alternatives as string[]) : undefined,
    acceptedBackAlternatives:  Array.isArray(row.accepted_back_alternatives)
      ? (row.accepted_back_alternatives as string[]) : undefined,
    // Prefer the new array columns; fall back to the old single-value columns for
    // rows that pre-date migration 044 (e.g. during a rolling deploy).
    syncedFromLanguages: Array.isArray(row.synced_from_languages) && (row.synced_from_languages as string[]).length > 0
      ? (row.synced_from_languages as string[])
      : row.synced_from_language ? [(row.synced_from_language as string)] : [],
    originWords: Array.isArray(row.origin_words) && (row.origin_words as string[]).length > 0
      ? (row.origin_words as string[])
      : row.origin_word ? [(row.origin_word as string)] : [],
    audioGenerated: (row.audio_generated as boolean | null) ?? false,
    audioData:      (row.audio_data as string | null) ?? null,
    audioSource:    (row.audio_source as import('@/domain').AudioSource | null) ?? null,
    audioSources:   (row.audio_sources as Partial<Record<import('@/domain').AudioSource, string>> | null) ?? null,
    ipa:            (row.ipa as string | null) ?? null,
  }
}

export class SupabaseCardRepository implements CardRepository {
  private get db() { return createClient() }

  /**
   * Every card the user owns, in ONE paged query. The per-deck `listByDeck` is fine for a single deck
   * but callers that need the whole library (Study dashboard, Library counts, card search) were firing
   * it once per deck — dozens of round-trips before anything could render.
   */
  async listAllForUser(ownerId: UserId): Promise<Card[]> {
    if (isOfflineActive()) return getLocalStore().allCards()
    // Cast: Supabase can't infer a row shape from a runtime column string.
    const rows = await fetchAllRows<Record<string, unknown>>((f, t) => this.db.from('cards')
      .select(BULK_CARD_COLUMNS).eq('owner_id', ownerId).is('deleted_at', null).order('id').range(f, t) as unknown as
      PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>)
    return rows.map(rowToCard)
  }

  /** card_id → deck_id for the given decks, in one paged query (a card may be in several decks; the
   *  first link wins). Lets callers group a bulk card list by deck without a query per deck. */
  async deckIdsByCard(deckIds: DeckId[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (deckIds.length === 0) return out
    if (isOfflineActive()) {
      const store = getLocalStore()
      for (const id of deckIds) for (const cardId of await store.cardIdsForDeck(id)) if (!out.has(cardId)) out.set(cardId, id)
      return out
    }
    const rows = await fetchAllRows<{ deck_id: string; card_id: string }>((f, t) => this.db
      .from('deck_cards').select('deck_id, card_id').in('deck_id', deckIds).order('card_id').range(f, t))
    for (const r of rows) if (!out.has(r.card_id)) out.set(r.card_id, r.deck_id)
    return out
  }

  async listByDeck(deckId: DeckId): Promise<Card[]> {
    if (isOfflineActive()) return localCardsByDeck(deckId)
    const { data, error } = await this.db.from('deck_cards')
      .select('position, cards(*)')
      .eq('deck_id', deckId)
      .order('position')
    if (error) throw new Error(error.message)

    return (data ?? [])
      .map(row => row as unknown as { position: number; cards: Record<string, unknown> | null })
      .filter(row => row.cards && row.cards.deleted_at === null)
      .map(row => ({ ...rowToCard(row.cards!), position: row.position }))
  }

  async get(cardId: CardId): Promise<Card | null> {
    if (isOfflineActive()) return (await localGetCard(cardId)) ?? null
    const { data, error } = await this.db.from('cards').select('*')
      .eq('id', cardId).is('deleted_at', null).single()
    if (error) return null
    return rowToCard(data)
  }

  /** Lightweight {id, front, sourceLanguage} for every card the user owns — for library-wide confusion
   *  matching (sourceLanguage decides intra- vs inter-language confusion). */
  async listFrontsForUser(ownerId: UserId): Promise<{ id: string; front: string; sourceLanguage: string }[]> {
    const { data, error } = await this.db.from('cards').select('id, front, source_language')
      .eq('owner_id', ownerId).is('deleted_at', null)
    if (error) throw new Error(error.message)
    return (data ?? []).map(r => ({ id: r.id as string, front: r.front as string, sourceLanguage: r.source_language as string }))
  }

  async listOwned(ownerId: UserId, sourceLanguage: string, targetLanguage: string): Promise<Card[]> {
    const { data, error } = await this.db.from('cards').select('*')
      .eq('owner_id', ownerId)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
      .is('deleted_at', null)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToCard)
  }

  async listDeckNamesForCards(cardIds: CardId[]): Promise<Record<string, string[]>> {
    if (cardIds.length === 0) return {}

    const { data, error } = await this.db.from('deck_cards')
      .select('card_id, decks(name, deleted_at)')
      .in('card_id', cardIds)
    if (error) throw new Error(error.message)

    const result: Record<string, string[]> = {}
    for (const row of (data ?? []) as unknown as { card_id: string; decks: { name: string; deleted_at: string | null } | null }[]) {
      if (!row.decks || row.decks.deleted_at !== null) continue
      const names = result[row.card_id] ?? (result[row.card_id] = [])
      names.push(row.decks.name)
    }
    return result
  }

  async bulkCreate(deckId: DeckId, ownerId: UserId, sourceLanguage: string, targetLanguage: string, inputs: CreateCardInput[]): Promise<Card[]> {
    if (inputs.length === 0) return []

    // Tier 1 (exact, silent) dedup against the user's existing library in
    // this language direction — reuse matches instead of inserting new rows.
    const existing = await this.listOwned(ownerId, sourceLanguage, targetLanguage)

    const results: Card[] = new Array(inputs.length)
    const toInsert: { input: CreateCardInput; index: number }[] = []

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!
      const match = existing.find(c => tier1Match(input, c))
        ?? results.slice(0, i).find((c): c is Card => !!c && tier1Match(input, c))
      if (match) {
        results[i] = match
      } else {
        toInsert.push({ input, index: i })
      }
    }

    if (toInsert.length > 0) {
      const rows = toInsert.map(({ input }) => ({
        owner_id:        ownerId,
        source_language: sourceLanguage,
        target_language: targetLanguage,
        front:           input.front,
        back:            input.back,
        hints:           input.hints ?? [],
        position:        input.position,
      }))
      const { data, error } = await this.db.from('cards').insert(rows).select()
      if (error) throw new Error(error.message)
      const created = (data ?? []).map(rowToCard)
      toInsert.forEach(({ index }, j) => { results[index] = created[j]! })
    }

    // Link every resulting card (new or reused) into this deck.
    const linkRows = inputs.map((input, i) => ({
      deck_id:  deckId,
      card_id:  results[i]!.id,
      position: input.position,
    }))
    const { error: linkError } = await this.db.from('deck_cards')
      .upsert(linkRows, { onConflict: 'deck_id,card_id', ignoreDuplicates: true })
    if (linkError) throw new Error(linkError.message)

    return results
  }

  async listDeckIdsForCard(cardId: CardId): Promise<string[]> {
    const { data, error } = await this.db.from('deck_cards')
      .select('deck_id').eq('card_id', cardId)
    if (error) throw new Error(error.message)
    return (data ?? []).map(r => r.deck_id as string)
  }

  async addToDeck(deckId: DeckId, cardId: CardId, position: number): Promise<void> {
    const { error } = await this.db.from('deck_cards')
      .upsert({ deck_id: deckId, card_id: cardId, position }, { onConflict: 'deck_id,card_id', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
  }

  async removeFromDeck(deckId: DeckId, cardId: CardId): Promise<void> {
    const { error } = await this.db.from('deck_cards')
      .delete().eq('deck_id', deckId).eq('card_id', cardId)
    if (error) throw new Error(error.message)
  }

  async update(cardId: CardId, patch: Partial<Pick<Card, 'front' | 'back' | 'hints' | 'choices' | 'audioGenerated' | 'audioData' | 'audioSource' | 'audioSources' | 'ipa'>>): Promise<Card> {
    if (isOfflineActive()) return localUpdateCard(cardId, patch)
    const dbPatch: Record<string, unknown> = {}
    if (patch.front          !== undefined) dbPatch.front           = patch.front
    if (patch.back           !== undefined) dbPatch.back            = patch.back
    if (patch.hints          !== undefined) dbPatch.hints           = patch.hints
    if (patch.choices        !== undefined) dbPatch.choices         = patch.choices
    if (patch.audioGenerated !== undefined) dbPatch.audio_generated = patch.audioGenerated
    if (patch.audioData      !== undefined) dbPatch.audio_data      = patch.audioData
    if (patch.audioSource    !== undefined) dbPatch.audio_source    = patch.audioSource
    if (patch.audioSources   !== undefined) dbPatch.audio_sources   = patch.audioSources
    if (patch.ipa            !== undefined) dbPatch.ipa             = patch.ipa
    const { data, error } = await this.db.from('cards').update(dbPatch).eq('id', cardId).select().single()
    if (error) throw new Error(error.message)
    return rowToCard(data)
  }

  async softDelete(cardId: CardId): Promise<void> {
    const { error } = await this.db.rpc('soft_delete_card', { p_card_id: cardId })
    if (error) throw new Error(error.message)
  }

  async undelete(cardId: CardId): Promise<void> {
    const { error } = await this.db.from('cards').update({ deleted_at: null }).eq('id', cardId)
    if (error) throw new Error(error.message)
  }

  async forkInDeck(deckId: DeckId, cardId: CardId, ownerId: UserId, patch: Partial<Pick<Card, 'front' | 'back' | 'hints'>>): Promise<{ card: Card; forked: boolean }> {
    const { count, error: countError } = await this.db.from('deck_cards')
      .select('*', { count: 'exact', head: true })
      .eq('card_id', cardId)
    if (countError) throw new Error(countError.message)

    if ((count ?? 0) <= 1) {
      const updated = await this.update(cardId, { ...patch, choices: null })
      return { card: updated, forked: false }
    }

    const original = await this.get(cardId)
    if (!original) throw new Error('Card not found')

    const { data: created, error: insertError } = await this.db.from('cards').insert({
      owner_id:        ownerId,
      source_language: original.sourceLanguage,
      target_language: original.targetLanguage,
      front:           patch.front ?? original.front,
      back:            patch.back  ?? original.back,
      hints:           patch.hints ?? original.hints,
      position:        original.position,
    }).select().single()
    if (insertError) throw new Error(insertError.message)
    const newCard = rowToCard(created)

    const { error: updateLinkError } = await this.db.from('deck_cards')
      .update({ card_id: newCard.id })
      .eq('deck_id', deckId).eq('card_id', cardId)
    if (updateLinkError) throw new Error(updateLinkError.message)

    return { card: newCard, forked: true }
  }
}
