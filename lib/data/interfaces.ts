import type { Deck, DeckId, Card, CardId, CardState, ReviewEvent, Pipeline, UserId, DeckPreferences } from '@/domain'

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
}

export interface CreateCardInput {
  front:    string
  back:     string
  hints?:   string[]
  position: number
}

export interface CardRepository {
  listByDeck(deckId: DeckId): Promise<Card[]>
  get(cardId: CardId): Promise<Card | null>
  bulkCreate(deckId: DeckId, inputs: CreateCardInput[]): Promise<Card[]>
  update(cardId: CardId, patch: Partial<Pick<Card, 'front' | 'back' | 'hints'>>): Promise<Card>
  softDelete(cardId: CardId): Promise<void>
}

export interface CardStateRepository {
  get(userId: UserId, cardId: CardId): Promise<CardState | null>
  listByDeck(userId: UserId, deckId: DeckId): Promise<CardState[]>
  upsert(state: CardState): Promise<CardState>
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
}

export interface ReviewEventRepository {
  create(input: CreateReviewEventInput): Promise<ReviewEvent>
  countByCard(userId: UserId, cardId: CardId): Promise<number>
}

export interface DeckPreferencesRepository {
  get(userId: UserId, deckId: DeckId): Promise<DeckPreferences | null>
  upsert(prefs: DeckPreferences): Promise<DeckPreferences>
  effectiveDailyLimit(prefs: DeckPreferences): number
  resetDeckBacklog(userId: UserId, deckId: DeckId): Promise<void>
  resetAllBacklogs(userId: UserId): Promise<void>
}

export interface PipelineRepository {
  getDefault(): Promise<Pipeline>
  list(userId: UserId): Promise<Pipeline[]>
  get(pipelineId: string): Promise<Pipeline | null>
}
