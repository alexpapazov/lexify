/**
 * lib/offline/localStore.ts — the offline client database (Dexie / IndexedDB) and a thin facade over
 * it. Everything the app touches goes through `LocalStore`, never Dexie directly, so a later native
 * build can swap the backend to SQLite (Capacitor) without changing callers.
 *
 * Stage 1: schema + CRUD + outbox + manifest. The download bundle (Stage 2), the offline repo router
 * (Stage 3), and the sync engine (Stage 5) build on this.
 */
import Dexie, { type Table } from 'dexie'
import type { Card, CardState, Deck, Folder } from '@/domain'
import { cardStateKey } from './keys'
import type {
  DownloadBundle, Manifest, OutboxEntry, StoredCardState, StoredClimb, StoredDeckCard, StoredDeckPreference, StoredLadder,
  StoredLink, StoredOverride, StoredParam,
} from './types'

const META_MANIFEST = 'manifest'

class LexifyOfflineDB extends Dexie {
  cards!:           Table<Card, string>
  cardStates!:      Table<StoredCardState, string>
  ladderClimb!:     Table<StoredClimb, string>
  decks!:           Table<Deck, string>
  folders!:         Table<Folder, string>
  ladders!:         Table<StoredLadder, string>
  schedulerParams!: Table<StoredParam, string>
  confusionLinks!:  Table<StoredLink, string>
  overrides!:       Table<StoredOverride, string>
  deckCards!:       Table<StoredDeckCard, string>
  deckPreferences!: Table<StoredDeckPreference, string>
  meta!:            Table<{ key: string; value: unknown }, string>
  outbox!:          Table<OutboxEntry, number>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      cards:           'id, sourceLanguage, targetLanguage',
      cardStates:      'key, cardId',
      ladderClimb:     'cardId, deckId',
      decks:           'id, folderId',
      folders:         'id, parentId',
      ladders:         'key',
      schedulerParams: 'key',
      confusionLinks:  'id',
      overrides:       'key, cardId',
      deckCards:       'key, deckId, cardId',
      meta:            'key',
      outbox:          '++id, entity',
    })
    // v2 adds deckPreferences. Dexie upgrades in place, so an existing install keeps its bundle; the
    // new table is simply empty until the next download fills it.
    this.version(2).stores({ deckPreferences: 'key, deckId' })
  }
}

/** All synced content tables (everything a download replaces). The outbox + meta are NOT cleared here. */
const CONTENT_TABLES = [
  'cards', 'cardStates', 'ladderClimb', 'decks', 'folders', 'ladders', 'schedulerParams',
  'confusionLinks', 'overrides', 'deckCards', 'deckPreferences',
] as const

export class LocalStore {
  private db: LexifyOfflineDB
  constructor(name = 'lexify-offline') { this.db = new LexifyOfflineDB(name) }

  // ── Bulk load from a download bundle (replaces all content; keeps the outbox) ──
  async hydrate(bundle: DownloadBundle): Promise<void> {
    await this.db.transaction('rw', this.db.tables, async () => {
      await Promise.all(CONTENT_TABLES.map(t => this.db.table(t).clear()))
      await Promise.all([
        this.db.cards.bulkPut(bundle.cards),
        this.db.cardStates.bulkPut(bundle.cardStates),
        this.db.ladderClimb.bulkPut(bundle.ladderClimb),
        this.db.decks.bulkPut(bundle.decks),
        this.db.folders.bulkPut(bundle.folders),
        this.db.ladders.bulkPut(bundle.ladders),
        this.db.schedulerParams.bulkPut(bundle.schedulerParams),
        this.db.confusionLinks.bulkPut(bundle.confusionLinks),
        this.db.overrides.bulkPut(bundle.overrides),
        this.db.deckCards.bulkPut(bundle.deckCards),
        this.db.deckPreferences.bulkPut(bundle.deckPreferences ?? []),
      ])
      await this.db.meta.put({ key: META_MANIFEST, value: bundle.manifest })
    })
  }

  async getManifest(): Promise<Manifest | undefined> {
    return (await this.db.meta.get(META_MANIFEST))?.value as Manifest | undefined
  }

  /** True when the store holds a downloaded bundle (offline mode is available). */
  async isDownloaded(): Promise<boolean> {
    return (await this.getManifest()) != null
  }

  // ── Cards ──
  getCard(id: string): Promise<Card | undefined> { return this.db.cards.get(id) }
  allCards(): Promise<Card[]> { return this.db.cards.toArray() }
  async putCard(card: Card): Promise<void> { await this.db.cards.put(card) }
  async deleteCard(id: string): Promise<void> { await this.db.cards.delete(id) }
  /** Link a card into a deck locally (for offline-created cards). */
  async putDeckCard(deckId: string, cardId: string): Promise<void> {
    await this.db.deckCards.put({ key: `${deckId}:${cardId}`, deckId, cardId })
  }
  /** Card ids belonging to a deck (deck ↔ card join). */
  async cardIdsForDeck(deckId: string): Promise<string[]> {
    return (await this.db.deckCards.where('deckId').equals(deckId).toArray()).map(r => r.cardId)
  }
  /** A deck's saved study settings, or undefined if the bundle predates them / the deck has none. */
  async getDeckPreferences(deckId: string): Promise<unknown | undefined> {
    return (await this.db.deckPreferences.get(deckId))?.prefs
  }
  async cardsForDeck(deckId: string): Promise<Card[]> {
    const ids = await this.cardIdsForDeck(deckId)
    return (await this.db.cards.bulkGet(ids)).filter((c): c is Card => !!c)
  }

  // ── Card states (hot path) ──
  getCardState(cardId: string, reviewDirection: string): Promise<StoredCardState | undefined> {
    return this.db.cardStates.get(cardStateKey(cardId, reviewDirection))
  }
  listCardStatesByCard(cardId: string): Promise<StoredCardState[]> {
    return this.db.cardStates.where('cardId').equals(cardId).toArray()
  }
  allCardStates(): Promise<StoredCardState[]> { return this.db.cardStates.toArray() }
  /** Upsert a state (computes its key). Does NOT enqueue — the repo router does that explicitly. */
  async putCardState(state: CardState & { serverUpdatedAt?: string | null }): Promise<void> {
    await this.db.cardStates.put({ ...state, key: cardStateKey(state.cardId, state.reviewDirection), serverUpdatedAt: state.serverUpdatedAt ?? null } as StoredCardState)
  }
  async deleteCardState(cardId: string, reviewDirection: string): Promise<void> {
    await this.db.cardStates.delete(cardStateKey(cardId, reviewDirection))
  }
  async cardStatesForDeck(deckId: string): Promise<StoredCardState[]> {
    const ids = new Set(await this.cardIdsForDeck(deckId))
    return (await this.db.cardStates.toArray()).filter(s => ids.has(s.cardId))
  }

  // ── Ladder climb ──
  getClimb(cardId: string): Promise<StoredClimb | undefined> { return this.db.ladderClimb.get(cardId) }
  async climbForCards(cardIds: string[]): Promise<StoredClimb[]> {
    return (await this.db.ladderClimb.bulkGet(cardIds)).filter((c): c is StoredClimb => !!c)
  }
  async putClimb(row: StoredClimb): Promise<void> { await this.db.ladderClimb.put(row) }
  async removeClimb(cardId: string): Promise<void> { await this.db.ladderClimb.delete(cardId) }

  // ── Overrides ──
  async putOverride(row: StoredOverride): Promise<void> { await this.db.overrides.put(row) }
  async deleteOverride(key: string): Promise<void> { await this.db.overrides.delete(key) }

  // ── Decks / folders (offline-created content) ──
  async putDeck(deck: Deck): Promise<void> { await this.db.decks.put(deck) }
  async putFolder(folder: Folder): Promise<void> { await this.db.folders.put(folder) }

  // ── Ladders (offline-editable config) ──
  async putLadder(row: StoredLadder): Promise<void> { await this.db.ladders.put(row) }
  async deleteLadder(key: string): Promise<void> { await this.db.ladders.delete(key) }
  allLadders(): Promise<StoredLadder[]> { return this.db.ladders.toArray() }

  // ── Config reads ──
  getLadder(key: string): Promise<StoredLadder | undefined> { return this.db.ladders.get(key) }
  allSchedulerParams(): Promise<StoredParam[]> { return this.db.schedulerParams.toArray() }
  allDecks(): Promise<Deck[]> { return this.db.decks.toArray() }
  allFolders(): Promise<Folder[]> { return this.db.folders.toArray() }
  allConfusionLinks(): Promise<StoredLink[]> { return this.db.confusionLinks.toArray() }
  allOverrides(): Promise<StoredOverride[]> { return this.db.overrides.toArray() }

  // ── Outbox ──
  async enqueue(entry: OutboxEntry): Promise<number> { return this.db.outbox.add(entry) }
  outbox(): Promise<OutboxEntry[]> { return this.db.outbox.orderBy('id').toArray() }
  outboxCount(): Promise<number> { return this.db.outbox.count() }
  async deleteOutbox(ids: number[]): Promise<void> { await this.db.outbox.bulkDelete(ids) }
  async clearOutbox(): Promise<void> { await this.db.outbox.clear() }

  /** Wipe everything (logout / re-download from scratch). */
  async clearAll(): Promise<void> {
    await this.db.transaction('rw', this.db.tables, async () => {
      await Promise.all(this.db.tables.map(t => t.clear()))
    })
  }

  /** For tests / teardown. */
  async close(): Promise<void> { this.db.close() }
  async destroy(): Promise<void> { await this.db.delete() }
}

/** App-wide singleton (browser only). */
let singleton: LocalStore | null = null
export function getLocalStore(): LocalStore {
  if (!singleton) singleton = new LocalStore()
  return singleton
}
