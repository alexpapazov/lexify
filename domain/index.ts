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

// ─── LanguagePair ─────────────────────────────────────────────────────────────

/**
 * A "language pairing" grouping shown as a box on the Library root page.
 * Same convention as Deck/Card: sourceLanguage = the language being learned
 * ("Target" in the UI), targetLanguage = the learner's native/basis language
 * ("Basis" in the UI).
 */
export interface LanguagePair {
  id:             string
  ownerId:        UserId
  sourceLanguage: string
  targetLanguage: string
  position:       number
  createdAt:      string
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
  id:             CardId
  /** Cards are owned by a user (within a target/native language direction), not by a deck. */
  ownerId:        UserId
  /** Front-side language (the language being learned). */
  sourceLanguage: string
  /** Back-side language (the learner's native / foundation language). */
  targetLanguage: string
  front:     string
  back:      string
  hints:     string[]
  choices:   CardChoices | null
  position:  number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

// ─── DeckCard (join table) ─────────────────────────────────────────────────────

/** A card's membership in a deck — the same card may belong to multiple decks. */
export interface DeckCard {
  deckId:   DeckId
  cardId:   CardId
  position: number
}

// ─── DismissedPair ──────────────────────────────────────────────────────────────

/**
 * A Tier-2 near-duplicate pair the user explicitly chose to "keep both" for —
 * remembered so the same pair isn't flagged again. Also feeds Milestone 4's
 * embedding-based similarity work.
 */
export interface DismissedPair {
  id:        string
  userId:    UserId
  cardAId:   CardId
  cardBId:   CardId
  createdAt: string
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
  /**
   * "Ideal" interval in days — a continuous, memory-state estimate of how
   * long the learner can go before review (see engine/scheduler.ts). This is
   * the value formulas multiply against; it is NOT necessarily the actual
   * calendar gap to `dueAt` once density smoothing has run.
   */
  intervalDays:     number
  /**
   * The actual calendar gap (days) between `lastReviewedAt` and `dueAt`,
   * after density smoothing / relearn shortcuts. Used (with `lastReviewedAt`)
   * to compute review-timing `progress` and classify a review as
   * elective (early) vs due/overdue — per the spec, timing classification is
   * based on `dueAt`, not on `intervalDays`.
   */
  scheduledIntervalDays: number
  ease:             number
  reps:             number
  lapses:           number
  lastRating:       Rating | null
  lastReviewedAt:   string | null
  /** ISO date (YYYY-MM-DD) when this card was first introduced to the user. */
  introducedDate:   string | null
  /**
   * Number of consecutive "again" ratings (post-graduation) that happened
   * within the lapse-clustering window of each other (see lastLapseAt).
   * Resets to 0 on a correct answer.
   */
  lapseClusterCount: number
  /** Timestamp of the most recent post-graduation "again" rating, if any. */
  lastLapseAt:       string | null
  /** Timestamp this card most recently (re-)graduated into long-term review. */
  graduatedAt:       string | null
  /**
   * 0 = not in the 10-minute "Again" relearn loop. >= 1 = how many failed
   * retries have happened since the last graduated-review lapse (the card
   * stays "due" again ~10 minutes later until it recovers or hits a 3rd
   * clustered lapse, which sends it back to the learning pipeline).
   */
  relearningStep:   number
  /**
   * The ideal interval (days) to apply once the 10-minute relearn loop is
   * recovered with a correct answer. Null when not in the relearn loop.
   */
  pendingIntervalDays: number | null
  /**
   * Rolling window of recent typed-production results for this card
   * (1 = correct, 0 = incorrect), most-recent last, capped at
   * TYPED_ACCURACY_WINDOW_SIZE entries. Drives the typed-vs-self-graded
   * production mode decision (engine/productionMode.ts).
   */
  typedAccuracyWindow: number[]
  /** Total typed-production reviews ever completed post-graduation. */
  typedReviewCount:    number
  /** Timestamp of the most recent typed-production review, if any. */
  lastTypedReviewAt:   string | null
  /**
   * Number of upcoming graduated reviews that must use typed production,
   * forced by a recent typed error, a self-graded "Again", or a return to
   * relearning.
   */
  forcedTypedRemaining: number
  /**
   * Running history of `scheduledIntervalDays` values over time (oldest
   * first), capped at a small size — for analytics/debugging.
   */
  intervalHistory:   number[]
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
  /**
   * 'elective' = the card wasn't yet due (reviewed ahead of schedule);
   * 'due' = the card was due/overdue, or this is a pre-graduation /
   * first-ever review. Null for legacy rows recorded before this field
   * existed.
   */
  reviewMode:  'elective' | 'due' | null
  /** Whether this (post-graduation) review used typed production. Null pre-graduation / legacy rows. */
  wasTyped:    boolean | null
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
  /**
   * For wrong typed answers, a 0 (mild — close typo/spelling/article slip)
   * to 1 (severe — total meaning failure / blank) severity score used to
   * scale how much the next interval shrinks. Defaults to 0.5 (moderate)
   * when omitted, e.g. for recognition-mode misses.
   */
  wrongSeverity?: number
  /**
   * Whether this (post-graduation) review used typed production rather than
   * self-graded recall. Ignored pre-graduation. Defaults to false.
   */
  wasTyped?: boolean
}
