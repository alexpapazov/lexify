import type { Deck, DeckId, Card, CardId, CardState, ReviewEvent, Pipeline, UserId, DeckPreferences, DismissedPair, CardConfusion, CardSide, TypedAnswerOverride, AgentAction } from '@/domain'

export interface CreateDeckInput {
  name:           string
  sourceLanguage: string
  targetLanguage: string
  pipelineId:     string
}

export interface DeckRepository {
  list(userId: UserId): Promise<Deck[]>
  listPublic(query?: string): Promise<Deck[]>
  get(deckId: DeckId): Promise<Deck | null>
  create(userId: UserId, input: CreateDeckInput): Promise<Deck>
  update(deckId: DeckId, patch: Partial<Pick<Deck, 'name' | 'gradingSettings' | 'pipelineId' | 'isPublic'>>): Promise<Deck>
  softDelete(deckId: DeckId): Promise<void>
  /** Wipes study progress for every card in the deck and clears cached AI answer choices. */
  resetProgress(deckId: DeckId): Promise<void>
}

export interface CreateCardInput {
  front:    string
  back:     string
  hints?:   string[]
  position: number
}

export interface CardRepository {
  listByDeck(deckId: DeckId): Promise<Card[]>
  /** Every card the user owns, in one paged query (avoids a listByDeck fan-out). */
  listAllForUser(ownerId: UserId): Promise<Card[]>
  /** card_id → deck_id for the given decks, in one paged query. */
  deckIdsByCard(deckIds: DeckId[]): Promise<Map<string, string>>
  get(cardId: CardId): Promise<Card | null>
  /**
   * Creates cards owned by `ownerId` in the given language direction and
   * links them into `deckId` (via deck_cards). Performs silent Tier-1 exact
   * duplicate detection first — if an input's (front, back) exactly matches
   * (whitespace-normalized) an existing card the user already owns in this
   * direction, that existing card is reused (just linked into the deck)
   * instead of creating a new row.
   */
  bulkCreate(deckId: DeckId, ownerId: UserId, sourceLanguage: string, targetLanguage: string, inputs: CreateCardInput[]): Promise<Card[]>
  update(cardId: CardId, patch: Partial<Pick<Card, 'front' | 'back' | 'hints' | 'choices'>>): Promise<Card>
  /** Soft-deletes a card everywhere — it disappears from every deck that references it. */
  softDelete(cardId: CardId): Promise<void>
  /** Links an existing card into a deck (no-op if already linked). */
  addToDeck(deckId: DeckId, cardId: CardId, position: number): Promise<void>
  /** Removes a card from a deck without deleting the card itself (it may still belong to other decks). */
  removeFromDeck(deckId: DeckId, cardId: CardId): Promise<void>
  /** All of a user's non-deleted cards in a given (target, native) language direction — for duplicate detection. */
  listOwned(ownerId: UserId, sourceLanguage: string, targetLanguage: string): Promise<Card[]>
  /** For each given card id, the names of the (non-deleted) decks it currently belongs to. */
  listDeckNamesForCards(cardIds: CardId[]): Promise<Record<string, string[]>>
  /**
   * Applies an edit to a card within the context of a single deck. If the
   * card is only linked to this one deck, it's updated in place. If the card
   * is shared with other decks, a new card row is created with the patched
   * fields (a fork), and only this deck's `deck_cards` link is re-pointed to
   * the new card — the original card and its other deck links are untouched.
   */
  forkInDeck(deckId: DeckId, cardId: CardId, ownerId: UserId, patch: Partial<Pick<Card, 'front' | 'back' | 'hints'>>): Promise<{ card: Card; forked: boolean }>
}

export interface CardStateRepository {
  get(userId: UserId, cardId: CardId): Promise<CardState | null>
  listByDeck(userId: UserId, deckId: DeckId): Promise<CardState[]>
  /** Every card_state for the user, in one paged query. */
  listAllForUser(userId: UserId): Promise<CardState[]>
  upsert(state: CardState): Promise<CardState>
  /** Bulk-upserts multiple states in one round-trip (used for fast-track import). */
  upsertBatch(states: CardState[]): Promise<void>
  /** Copies a user's study progress from one card to another (used when forking a shared card). */
  copy(userId: UserId, fromCardId: CardId, toCardId: CardId): Promise<CardState | null>
  /**
   * Counts how many of the user's graduated cards are currently due on each
   * date (YYYY-MM-DD) within [startIso, endIso), across all decks. Used by
   * the long-term scheduler's review-density smoothing.
   */
  countDueByDateRange(userId: UserId, startIso: string, endIso: string): Promise<Map<string, number>>
}

export interface CreateReviewEventInput {
  userId:      UserId
  cardId:      CardId
  mode:        ReviewEvent['mode']
  promptSide:  ReviewEvent['promptSide']
  answerSide:  ReviewEvent['answerSide']
  promptShown: string
  expected:    string
  userAnswer:  string
  wasCorrect:  boolean
  rating:      ReviewEvent['rating']
  responseMs:  number | null
  reviewMode:          ReviewEvent['reviewMode']
  wasTyped:            ReviewEvent['wasTyped']
  wasAccelerated?:     boolean | null
  acceleratedPenalty?: number | null
  reviewDirection?:    'forward' | 'reverse' | null
  reps?:               number | null
  hintLevel?:          number
  nearMiss?:           boolean
  nearMissWeight?:     number
  errorCategory?:      ReviewEvent['errorCategory']
  graduationErrorCount?: number
  sourceLanguage?:     string | null
  targetLanguage?:     string | null
}

export interface ReviewEventRepository {
  create(input: CreateReviewEventInput): Promise<ReviewEvent>
  listForCard(userId: UserId, cardId: CardId, limit?: number): Promise<ReviewEvent[]>
  countByCard(userId: UserId, cardId: CardId): Promise<number>
  markLapsed(id: string, userId: UserId): Promise<void>
}

export interface DeckPreferencesRepository {
  get(userId: UserId, deckId: DeckId): Promise<DeckPreferences | null>
  upsert(prefs: DeckPreferences): Promise<DeckPreferences>
  effectiveDailyLimit(prefs: DeckPreferences): number
}

export interface PipelineRepository {
  getDefault(): Promise<Pipeline>
  list(userId: UserId): Promise<Pipeline[]>
  get(pipelineId: string): Promise<Pipeline | null>
}

export interface DismissedPairRepository {
  /** True if the user previously chose "keep both" for this pair (order-independent). */
  isDismissed(userId: UserId, cardAId: CardId, cardBId: CardId): Promise<boolean>
  /** Records a "keep both" decision so this pair isn't flagged again. */
  create(userId: UserId, cardAId: CardId, cardBId: CardId): Promise<DismissedPair>
}

export interface CardConfusionRepository {
  /**
   * Records (or increments) a mix-up: the learner was asked to produce
   * `answerSide` of `cardId` and instead produced `confusedText` (a
   * multiple-choice pick or a typed answer). `isWordMixup` is true when
   * `confusedText` is a genuinely different word (always true for
   * multiple-choice picks; for typed answers, true unless it was just a
   * close typo — see `engine/grading.ts: isDifferentWordMistake()`).
   * `confusedWithCardId` links to another card the user owns when
   * `confusedText` matches its text on `answerSide`.
   */
  record(cardId: CardId, confusedText: string, answerSide: CardSide, isWordMixup: boolean, confusedWithCardId?: CardId | null): Promise<void>
  /** All tracked mix-ups for this card, most-frequent first. */
  listForCard(userId: UserId, cardId: CardId): Promise<CardConfusion[]>
  /** All tracked mix-ups for this user across every card — fetched once per session. */
  listForUser(userId: UserId): Promise<CardConfusion[]>
}

export interface AgentActionRepository {
  /** Records one applied gateway mutation (before/after snapshot) for audit. */
  record(action: Omit<AgentAction, 'id' | 'createdAt'>): Promise<void>
  /** Recent actions for this user, newest first. */
  listForUser(userId: UserId, limit?: number): Promise<AgentAction[]>
}

export interface TypedAnswerOverrideRepository {
  /** All persisted typed-answer overrides for this user, across every card — fetched once per session. */
  listForUser(userId: UserId): Promise<TypedAnswerOverride[]>
  /**
   * Persists "this (normalized) typed answer counts as correct" for
   * (cardId, answerSide). No-op if already present.
   */
  add(userId: UserId, cardId: CardId, answerSide: CardSide, answerText: string): Promise<void>
  /** Removes a previously persisted override, if present. */
  remove(userId: UserId, cardId: CardId, answerSide: CardSide, answerText: string): Promise<void>
}
