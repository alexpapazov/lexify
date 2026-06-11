/**
 * domain/index.ts
 *
 * Shared domain types imported by ALL layers: engine, lib/data, and UI.
 * Nothing in here may import from React, Next.js, or Supabase.
 */

export type UserId        = string
export type DeckId        = string
export type CardId        = string
export type PipelineId    = string
export type PipelineStepOrder = number

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export type StepType = 'recognition' | 'typing'
export type CardSide = 'front' | 'back'

export interface PipelineStep {
  pipelineId:      PipelineId
  stepOrder:       PipelineStepOrder
  stepType:        StepType
  promptSide:      CardSide
  answerSide:      CardSide
  requiredCorrect: number
}

export interface Pipeline {
  id:        PipelineId
  ownerId:   UserId | null
  name:      string
  isDefault: boolean
  steps:     PipelineStep[]
}

// ─── Grading settings ─────────────────────────────────────────────────────────

export interface GradingSettings {
  accentInsensitive:       boolean
  articleOptional:         boolean
  caseInsensitive:         boolean
  allowOneTypo:            boolean
  acceptSlashAlternatives: boolean
  ignoreParentheticals:    boolean
}

export const DEFAULT_GRADING_SETTINGS: GradingSettings = {
  accentInsensitive:       true,
  articleOptional:         false,
  caseInsensitive:         true,
  allowOneTypo:            false,
  acceptSlashAlternatives: true,
  ignoreParentheticals:    true,
}

// ─── Folder ───────────────────────────────────────────────────────────────────

export type FolderId = string

export interface Folder {
  id:        FolderId
  ownerId:   UserId
  name:      string
  parentId:  FolderId | null
  position:  number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

// ─── Deck ─────────────────────────────────────────────────────────────────────

export interface Deck {
  id:              DeckId
  ownerId:         UserId
  name:            string
  sourceLanguage:  string
  targetLanguage:  string
  pipelineId:      PipelineId
  gradingSettings: GradingSettings
  isPublic:        boolean
  isPinned:        boolean
  folderId:        FolderId | null
  position:        number
  createdAt:       string
  updatedAt:       string
  deletedAt:       string | null
}

// ─── Card ─────────────────────────────────────────────────────────────────────

/** Cached pool of multiple-choice distractors per side (excludes the correct answer). */
export interface CardChoices {
  front: string[]
  back:  string[]
}

export interface Card {
  id:        CardId
  deckId:    DeckId
  front:     string
  back:      string
  hints:     string[]
  choices:   CardChoices | null
  position:  number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

// ─── CardState ────────────────────────────────────────────────────────────────

export interface CardState {
  userId:           UserId
  cardId:           CardId
  pipelineId:       PipelineId
  currentStepOrder: PipelineStepOrder
  correctInStep:    number
  graduated:        boolean
  dueAt:            string | null
  intervalDays:     number
  ease:             number
  reps:             number
  lapses:           number
  lastRating:       Rating | null
  lastReviewedAt:   string | null
  /** ISO date (YYYY-MM-DD) when this card was first introduced to the user. */
  introducedDate:   string | null
}

// ─── Ratings ──────────────────────────────────────────────────────────────────

export type Rating = 'again' | 'hard' | 'good' | 'easy'

// ─── ReviewEvent ──────────────────────────────────────────────────────────────

export interface ReviewEvent {
  id:          string
  userId:      UserId
  cardId:      CardId
  mode:        StepType
  promptSide:  CardSide
  answerSide:  CardSide
  promptShown: string
  expected:    string
  userAnswer:  string
  wasCorrect:  boolean
  rating:      Rating | null
  responseMs:  number | null
  reviewedAt:  string
}

// ─── Deck preferences ─────────────────────────────────────────────────────────

export interface DeckPreferences {
  userId:            UserId
  deckId:            DeckId
  /** Persistent daily limit for new cards from this deck. */
  dailyNewCards:     number
  /** One-day override (null = no override active). */
  dailyOverride:     number | null
  /** The date the override applies to (ISO date string, e.g. "2026-06-06"). */
  dailyOverrideDate: string | null
  /**
   * When false (default): in-pipeline cards from previous days count against
   * today's budget — total active cards stays at dailyNewCards.
   * When true: previous-day backlog is additive — cards accumulate if you fall behind.
   */
  spilloverDue:      boolean
  /**
   * When set (> 0): overrides the daily/calendar-based new-card budget.
   * Caps the number of cards actively "in the pipeline" (introduced but not
   * yet graduated) at this value — once a card graduates, the next session
   * introduces another new card to refill the batch. Decoupled from
   * dailyNewCards/spilloverDue. Null/0 = use the daily-limit logic instead.
   */
  cardsPerSession:   number | null
}

export const DEFAULT_DAILY_NEW_CARDS = 20

// ─── Session helpers ──────────────────────────────────────────────────────────

export interface GradingResult {
  correct:            boolean
  normalizedUser:     string
  normalizedExpected: string
}

export interface ReviewInput {
  wasCorrect: boolean
  rating:     Rating
}
