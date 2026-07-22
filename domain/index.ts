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

export type GradingMode = 'strict' | 'flexible' | 'smart_ai'

/**
 * 'strict'   — match after trim/spaces/case only; no accent/article/typo leniency.
 * 'almost'   — the 3-state result between correct and incorrect.
 * 'incorrect' — fundamentally wrong.
 */
export type GradingStatus = 'correct' | 'almost' | 'incorrect'

export type GradingIssueType =
  | 'none'
  | 'accent'
  | 'article'
  | 'gender'
  | 'typo'
  | 'semantic'
  | 'punctuation'
  | 'parenthetical'
  | 'missing_required_part'
  | 'wrong_synonym'
  | 'multiple_answers_required'

export interface GradingSettings {
  /** Which overall mode drives grading. Default: 'strict' for new decks. */
  gradingMode:                 GradingMode
  // ── Flexible mode toggles ─────────────────────────────────────────────────
  ignoreAccents:               boolean
  ignoreCapitalization:        boolean
  ignoreMinorTypos:            boolean
  ignoreDefiniteArticles:      boolean
  /** When true, content inside parens is required in the typed answer. */
  requireParentheticalContent: boolean
  slashAlternativesMode:       'accept_any' | 'require_all'
  commaAlternativesMode:       'accept_any' | 'require_all' | 'split_into_cards'
  // ── Smart AI mode ─────────────────────────────────────────────────────────
  /** Optional per-deck instructions for the AI grader (≤250 chars). */
  aiGradingInstructions?:      string
  // ── Audio ─────────────────────────────────────────────────────────────────
  /** When true (default), source-language audio plays automatically on card load and on correct answer. */
  autoPlayAudio:               boolean
  // ── Language context (runtime-only, not persisted) ────────────────────────
  /** BCP-47 language tag of the answer language (e.g. 'es', 'fr', 'it'). Used to restrict article detection to language-appropriate articles. */
  answerLanguage?:             string
  /** True when the learner is typing in their native/basis language (card.back). Minor spelling slips are graded leniently since spelling the native language isn't the skill being tested. */
  isNativeAnswer?:             boolean
}

// ─── Per-category typed-answer strictness ───────────────────────────────────────
//
// Independent of the ignore* toggles above. The idea: always DETECT accent/article/
// spelling slips (so the learner is told and must retype), but let the learner decide
// per language pair whether each category costs a scheduling penalty ("strict") or not
// ("lenient", green/no penalty). Slips are always logged by category so future
// "spelling practice" and "gender/article" modes have data.

/** Which loggable category a soft typed slip belongs to. */
export type TypedErrorCategory = 'spelling' | 'accent' | 'article'

/**
 * Per-category strictness level for a typed slip:
 *   'penalize' — counts as a scheduling penalty AND you must retype it correctly.
 *   'retype'   — no scheduling penalty, but you still must retype it correctly.
 *   'accept'   — no penalty and no retype: it's marked correct with an "X error" note.
 */
export type TypedStrictnessLevel = 'penalize' | 'retype' | 'accept'

/** Per-pair strictness — one level per loggable category. */
export interface TypedStrictness {
  spelling: TypedStrictnessLevel
  accents:  TypedStrictnessLevel
  articles: TypedStrictnessLevel
}

export const DEFAULT_TYPED_STRICTNESS: TypedStrictness = {
  spelling: 'penalize',
  accents:  'penalize',
  articles: 'penalize',
}

/** Penalty magnitudes when a category is strict. Lenient categories contribute 0. */
export const TYPED_PENALTY_WEIGHTS = {
  spelling: 0.30,
  accent:   0.20,
  article:  0.20,
  /** Non-toggleable near-miss (e.g. missing parenthetical) keeps a mild penalty. */
  other:    0.20,
} as const

/**
 * Outcome of applying per-category strictness to a graded typed answer.
 *   weight   — 0 = full credit (green), 0.2/0.3 = near-miss penalty, 1 = full wrong.
 *   category — the loggable slip category (for typing_error_marks); null otherwise.
 *   accepted — true when it counts as correct for scheduling (weight < 1).
 *   requiresRetype — true for any non-exact answer; learner must retype correctly.
 */
export interface TypedPenalty {
  weight:         number
  category:       TypedErrorCategory | null
  accepted:       boolean
  requiresRetype: boolean
}

// ─── Agent platform (see features/Agent Platform.md) ───────────────────────
// Phase 1: scoped, audited tool gateway over the data. "Agents" (Phase 2+) are
// configs that share these primitives.

/** The kinds of mutation an agent may be granted. */
export type AgentOperation = 'edit' | 'create' | 'delete' | 'merge' | 'sync' | 'regen'

/**
 * What an agent operation is allowed to touch. Each dimension is an allow-list;
 * an EMPTY array means "no restriction on this dimension".
 */
export interface Grant {
  operations: AgentOperation[]
  /** `${sourceLanguage}|${targetLanguage}` pair keys. [] = all pairs. */
  languages:  string[]
  /** Scoped folders — descendants are auto-included. [] = all folders. */
  folderIds:  string[]
  /** Scoped decks. [] = all decks. */
  deckIds:    string[]
  /** true → mutations may only PROPOSE a change set, never apply. */
  dryRunOnly: boolean
  expiresAt?: string | null
}

/** Passed into every gateway call — who is acting and under what grant. */
export interface GatewayContext {
  userId: UserId
  grant:  Grant
  /** The acting agent's id, or 'user' for direct user actions. */
  actor:  string
}

export type ChangeField = 'front' | 'back' | 'synonyms' | 'create' | 'delete'

/** One proposed change; a change set is `ChangeProposal[]`. */
export interface ChangeProposal {
  cardId: CardId | null   // null for a create
  deckId: DeckId
  field:  ChangeField
  before: unknown
  after:  unknown
  reason: string
}

/** A gateway mutation, recorded to `agent_actions` for audit. */
export interface AgentAction {
  id:        string
  userId:    UserId
  actor:     string
  operation: AgentOperation
  cardId:    CardId | null
  deckId:    DeckId | null
  before:    unknown
  after:     unknown
  dryRun:    boolean
  createdAt: string
}

// ── Change sets (Phase 2): an agent run's proposed edits, pending user review ──
export type ChangeSetStatus  = 'pending' | 'applied' | 'discarded'
export type ChangeItemStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed'

export interface ChangeSetItem {
  id:          string
  changeSetId: string
  proposal:    ChangeProposal
  status:      ChangeItemStatus
  error?:      string | null
}

export interface ChangeSet {
  id:        string
  userId:    UserId
  agent:     string
  task:      string
  summary:   string
  status:    ChangeSetStatus
  createdAt: string
  items:     ChangeSetItem[]
}

// ─── Configurable learning ladder (see features/Configurable Pipeline) ─────────
// A per-language-pair ordered list of exercise "rungs" a card climbs before it
// graduates. Stage 1: the data model + storage only (studying is unchanged).

export type RungType = 'mcq' | 'typing' | 'self_graded' | 'dictation'
/** Which side the learner must PRODUCE. Dictation is always 'produce_target'. */
export type RungDirection = 'produce_target' | 'produce_native'
export type DistractorSource = 'smart' | 'deck'
/** Ways an attempt on a rung can land (drives drop-back rules). */
export type RungOutcome = 'almost' | 'miss' | 'again' | 'hard' | 'good' | 'easy'

/** "On this outcome (after N occurrences), jump back to the rung with this id." */
export interface DropBackRule {
  on:       RungOutcome
  times:    number
  /** Count N in a row (streak, broken by any other outcome) vs. N total this rung sitting. */
  inARow?:  boolean
  toRungId: string
}

/** Positive outcomes that can trigger a skip-ahead: 'pass' (a clean auto-checked correct), or a
 *  self-rated 'good'/'easy'. The reverse of a drop-back's negative triggers. */
export type SkipTrigger = 'pass' | 'good' | 'easy'

/** "On this positive outcome (after N occurrences), jump FORWARD to the rung with this id —
 *  the mirror image of a drop-back. Only takes effect when the target is a later rung." */
export interface SkipAheadRule {
  on:       SkipTrigger
  times:    number
  /** Count N in a row vs. N total this rung sitting. */
  inARow?:  boolean
  toRungId: string
}

export interface Rung {
  id:                string
  type:              RungType
  direction:         RungDirection
  /** MCQ only. */
  distractorSource?: DistractorSource
  /** Typing / dictation only — per-category strictness. */
  strictness?:       TypedStrictness
  /** Whether the four rating buttons appear (always true for self_graded). */
  selfRated:         boolean
  /** Interval-setting rung (typing/self_graded only; one per direction). */
  intervalInit:      boolean
  /** How many times you must succeed / press the advancing rating to move up. */
  advanceTimes:      number
  /** In a row vs. total. */
  advanceInARow:     boolean
  /** For self-rated non-init rungs: which rating advances (default 'good'). */
  advanceRating?:    'good' | 'easy'
  /**
   * Self-rated rungs only: advance when ANY of these rules is met (OR), e.g.
   * "1 Easy OR 2 Good in a row". Each rule counts ratings at or above `minRating`.
   * When absent, the legacy single rule (advanceTimes/advanceInARow/advanceRating) is used.
   */
  advanceRules?:     AdvanceRule[]
  /**
   * Auto-checked (non-self-rated) rungs only: how long a card rests before reappearing, in seconds,
   * after a WRONG vs a CORRECT answer (defaults 60 / 360 = 1 min / 6 min). For a single-step rung
   * the correct wait is the gap until the NEXT rung — overriding the ladder's global
   * `betweenRungWaitSeconds` for that particular gap. Ignored on self-rated / interval-init rungs.
   */
  wrongWaitSeconds?:   number
  correctWaitSeconds?: number
  dropBacks:         DropBackRule[]
  /** Reverse of dropBacks: on a positive outcome N times, jump FORWARD to a later rung. Optional
   *  so ladders saved before this feature (JSONB) load fine. */
  skipAheads?:       SkipAheadRule[]
}

/** One OR-clause of a rung's advance condition (rungs advance when ANY clause is met). */
export interface AdvanceRule {
  /** How many qualifying attempts are needed. */
  times:     number
  /** In a row (streak) vs. total across this rung sitting. */
  inARow:    boolean
  /**
   * Self-rated rungs: the minimum rating that counts (Easy counts toward a Good rule).
   * Auto-checked rungs (MCQ/typing/dictation): omitted — any clean pass qualifies.
   */
  minRating?: 'again' | 'hard' | 'good' | 'easy'
}

export interface Ladder {
  rungs: Rung[]
  /** Seconds a card waits after advancing before it can reappear at the next rung (default 180 = 3 min). */
  betweenRungWaitSeconds?: number
}

// ─── Learning Pathways ───────────────────────────────────────────────────────
// A directed state graph — the branched successor to the linear ladder. Opt-in per language pair
// (`language_pairs.learning_mode`). A card occupies one STATE; each answer fires a TRANSITION to another
// state based on rating / correctness / error type / streak counters. See features/Learning Pathways.
// A State reuses a Rung's presentation fields verbatim so the same card UI renders it unchanged.

/** Error kinds a typed/dictation answer can produce — drives error-specific branching. Maps to
 *  `engine/grading.ts` issueType (spelling/accent/article) + confusion detection (wrong_word). */
export type ErrorType = 'spelling' | 'accent' | 'article' | 'wrong_word'

/** Per-state accumulating counters a transition condition can read (reset on entering a state). */
export type PathwayCounter = 'consecutiveGood' | 'consecutiveAgain' | 'totalGood' | 'totalAgain'

/** One test in a transition's condition. A Condition is a list of these AND-ed together. No timing. */
export type PathwayPredicate =
  | { kind: 'rating';          is: RungOutcome }                 // exact self-rated rating (again/hard/good/easy)
  | { kind: 'correct';         is: boolean }                     // clean success (pass/good/easy) vs not
  | { kind: 'errorType';       is: ErrorType }                   // this attempt's errors include `is`
  | { kind: 'counter';         name: PathwayCounter; gte: number }
  | { kind: 'attemptsInState'; gte: number }

/** ALL predicates must hold (AND). An empty condition always matches (an unconditional edge). */
export type PathwayCondition = PathwayPredicate[]

/** A state node: what the learner sees + how it's graded. Superset of a Rung's presentation fields. */
export interface PathwayState {
  id:                string
  name:              string
  // presentation — identical to Rung, so the existing card UI renders it unchanged
  type:              RungType
  direction:         RungDirection
  distractorSource?: DistractorSource
  strictness?:       TypedStrictness
  selfRated:         boolean
  intervalInit:      boolean          // sets THIS direction's graduation interval (≤1 per direction)
  /** Optional floor on how soon this state may re-appear for the card, in seconds. */
  minReshowSeconds?: number
  /** The graduation sink — reaching it hands the card to the FSRS Due-Now scheduler. No presentation. */
  isTerminal?:       boolean
}

/** A directed edge: on a matching condition, move from `from` to `to`. First match by priority wins. */
export interface Transition {
  id:        string
  from:      string           // source state id
  to:        string           // destination state id
  when:      PathwayCondition
  priority:  number           // lower = evaluated first
  /** Counters to zero on taking this edge (beyond the automatic per-state reset). */
  resetCounters?: PathwayCounter[]
  /** Per-branch spacing override (seconds) — replaces the pathway's global `betweenStateWaitSeconds`. */
  waitSecondsOverride?: number
}

export interface Pathway {
  id:           string
  startStateId: string
  states:       PathwayState[]
  transitions:  Transition[]
  /** Global gap before the next state appears (default 180 = 3 min); a transition can override it. */
  betweenStateWaitSeconds: number
}

/** Built-in fallback ladder (used until a user defines a default or per-pair one). */
export const DEFAULT_LADDER: Ladder = {
  rungs: [
    { id: 'r1', type: 'mcq',        direction: 'produce_native', distractorSource: 'deck', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
    { id: 'r2', type: 'mcq',        direction: 'produce_target', distractorSource: 'deck', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
    { id: 'r3', type: 'typing',     direction: 'produce_target', strictness: { spelling: 'penalize', accents: 'penalize', articles: 'penalize' }, selfRated: false, intervalInit: false, advanceTimes: 2, advanceInARow: true, dropBacks: [] },
    { id: 'r4', type: 'typing',     direction: 'produce_target', strictness: { spelling: 'penalize', accents: 'penalize', articles: 'penalize' }, selfRated: true, intervalInit: true, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
    { id: 'r5', type: 'self_graded', direction: 'produce_native', selfRated: true, intervalInit: true, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
  ],
}

/** Default for new decks — strict mode, case-insensitive only. */
export const DEFAULT_GRADING_SETTINGS: GradingSettings = {
  gradingMode:                 'strict',
  ignoreAccents:               false,
  ignoreCapitalization:        true,
  ignoreMinorTypos:            false,
  ignoreDefiniteArticles:      false,
  requireParentheticalContent: true,
  slashAlternativesMode:       'accept_any',
  commaAlternativesMode:       'split_into_cards',
  autoPlayAudio:               true,
}

// ─── Scheduler params ─────────────────────────────────────────────────────────

export interface SchedulerParams {
  // Typing probability thresholds (production-mode typed-vs-self-graded gating)
  typedProbBelow70: number; typedProb70to84: number
  typedProb85to94: number; typedProb95plus: number
  // FSRS interval cap (days)
  maxIntervalDays: number
  // Graduation intervals by exact pipeline-error count (8err = 8 or more)
  gradInterval0errMin: number; gradInterval0errMax: number
  gradInterval1errMin: number; gradInterval1errMax: number
  gradInterval2errMin: number; gradInterval2errMax: number
  gradInterval3errMin: number; gradInterval3errMax: number
  gradInterval4errMin: number; gradInterval4errMax: number
  gradInterval5errMin: number; gradInterval5errMax: number
  gradInterval6errMin: number; gradInterval6errMax: number
  gradInterval7errMin: number; gradInterval7errMax: number
  gradInterval8errMin: number; gradInterval8errMax: number
  // Per-pair typed-answer strictness levels (canonical on the forward_typed row).
  strictSpelling: TypedStrictnessLevel; strictAccents: TypedStrictnessLevel; strictArticles: TypedStrictnessLevel
  // Per-pair FSRS target retention (0.80–0.95). Higher = shorter intervals, more
  // reviews, better recall. Canonical on the forward_typed row.
  requestRetention: number
  // Per-pair smart-typing threshold (days): the smart-typing track requires typing
  // while its interval is below this, then goes self-graded. Canonical on forward_typed.
  smartTypingThresholdDays: number
  // Per-TRACK FSRS interval calibration (multiplier, 1 = none). Set by the calibrate route from your
  // MEASURED vs TARGET retention: when you consistently recall better than your target, intervals are
  // stretched (>1) so you review less at the same retention; when you recall worse, they shrink (<1).
  // Unlike the others this is per answer_field (each track has its own measured retention).
  retentionCalibration: number
}

export const DEFAULT_SCHEDULER_PARAMS: SchedulerParams = {
  typedProbBelow70: 1.00, typedProb70to84: 0.70,
  typedProb85to94: 0.35, typedProb95plus: 0.15,
  maxIntervalDays: 1460,
  gradInterval0errMin: 4, gradInterval0errMax: 6,
  gradInterval1errMin: 3, gradInterval1errMax: 4,
  gradInterval2errMin: 2, gradInterval2errMax: 3,
  gradInterval3errMin: 1, gradInterval3errMax: 2,
  gradInterval4errMin: 1, gradInterval4errMax: 2,
  gradInterval5errMin: 1, gradInterval5errMax: 1,
  gradInterval6errMin: 1, gradInterval6errMax: 1,
  gradInterval7errMin: 1, gradInterval7errMax: 1,
  gradInterval8errMin: 1, gradInterval8errMax: 1,
  strictSpelling: 'penalize', strictAccents: 'penalize', strictArticles: 'penalize',
  requestRetention: 0.90,
  smartTypingThresholdDays: 20,
  retentionCalibration: 1.0,
}

/** Defaults when converting an existing deck to flexible mode. */
export const DEFAULT_FLEXIBLE_SETTINGS: Omit<GradingSettings, 'gradingMode'> = {
  ignoreAccents:               false,
  ignoreCapitalization:        true,
  ignoreMinorTypos:            false,
  ignoreDefiniteArticles:      false,
  requireParentheticalContent: true,
  slashAlternativesMode:       'accept_any',
  commaAlternativesMode:       'split_into_cards',
  autoPlayAudio:               true,
}

// ─── Folder ───────────────────────────────────────────────────────────────────

export type FolderId = string

export interface Folder {
  id:             FolderId
  ownerId:        UserId
  name:           string
  parentId:       FolderId | null
  position:       number
  createdAt:      string
  updatedAt:      string
  deletedAt:      string | null
  /** Auto-managed by sync system — cannot be renamed or deleted by the user. */
  isSynced:       boolean
  /** When set, this folder only appears in this language pair's library view. */
  sourceLanguage: string | null
  targetLanguage: string | null
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
  flag:           string | null
  instructions:   string | null
  createdAt:      string
  /** Weekday goals: keys "0"–"6" (JS day-of-week, 0=Sun), value = target grad count or null = no goal. */
  goals:          Record<string, number | null> | null
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
  syncingComplete: boolean          // false = synced deck with pending AI translations
  createdAt:       string
  updatedAt:       string
  deletedAt:       string | null
}

// ─── Card ─────────────────────────────────────────────────────────────────────

/** Cached pool of multiple-choice distractors per side (excludes the correct answer). */
export interface CardChoices {
  front: string[]
  back:  string[]
  /** Synonyms/alternate phrasings of the correct front answer — accepted as correct in multiple choice. */
  frontSynonyms?: string[]
  /** Synonyms/alternate phrasings of the correct back answer — accepted as correct in multiple choice. */
  backSynonyms?: string[]
}

export type Register = 'neutral' | 'informal' | 'formal' | 'regional' | 'vulgar'

/** Where a card's audio comes from. 'browser' = on-device Web Speech (robotic). */
export type AudioSource = 'elevenlabs' | 'forvo' | 'browser' | 'standard'

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
  // ── Synonym group ─────────────────────────────────────────────────────────
  /** Links this card to a SynonymGroup when multiple target-language items share a gloss. */
  synonymGroupId?:           string | null
  /** Sociolinguistic register of the front-side item. */
  register?:                 Register | null
  /** Geographic region associated with the front-side item. */
  region?:                   string | null
  /** Other valid typed answers for the front side (not synonyms — same item, alternate phrasing). */
  acceptedFrontAlternatives?: string[]
  /** Other valid typed answers for the back side. */
  acceptedBackAlternatives?:  string[]
  // ── Sync origin (only set on AI-synced cards) ─────────────────────────────
  /** Language codes of every source deck this card was synced from (e.g. ['es', 'it']). */
  syncedFromLanguages?: string[]
  /** Learned-language words from every source card that produced this card (e.g. ['rojo', 'rosso']). */
  originWords?:         string[]
  // ── AI-generated audio (source/target language only) ─────────────────────
  /** True once OpenAI TTS audio has been fetched and stored for this card's front (source language). */
  audioGenerated?: boolean
  /** Base64-encoded mp3 for card.front — the ACTIVE audio source's clip (what plays). Null = none/browser. */
  audioData?:      string | null
  /** Which audio source is active for this card: 'elevenlabs' | 'forvo' | 'browser'. Null = default. */
  audioSource?:    AudioSource | null
  /** Cached base64 mp3 per provider so switching sources doesn't re-fetch, e.g. { elevenlabs, forvo }. */
  audioSources?:   Partial<Record<AudioSource, string>> | null
  /** IPA transcription for card.front (source language). Null until generated. */
  ipa?:            string | null
}

// ─── Synonym groups ───────────────────────────────────────────────────────────

/**
 * Groups lexical items (Cards) that share the same gloss/meaning but are
 * distinct target-language forms — each with its own SRS schedule.
 * E.g. el cerdo / el chancho / el puerco all mean "pig".
 */
export interface SynonymGroup {
  id:           string
  gloss:        string        // shared native-language meaning, e.g. "pig"
  glossLanguage: string       // language of the gloss, e.g. "en"
  itemLanguage:  string       // language of the items, e.g. "es"
  itemIds:       string[]     // Card ids in this group (ordered)
  createdAt:     string
  updatedAt:     string
}

export type SynonymFieldStatus = 'prefilled' | 'due_blank' | 'completed'
export type SynonymDueState    = 'due' | 'not_due' | 'already_completed_this_session'

export interface SynonymAnswerField {
  lexicalItemId: string
  expectedAnswer: string
  status: SynonymFieldStatus
  value: string
  dueState: SynonymDueState
  register?: Register | null
  region?: string | null
}

export interface SynonymProductionPrompt {
  synonymGroupId: string
  gloss: string
  fields: SynonymAnswerField[]
}

export type GradingFieldStatus = 'correct' | 'almost' | 'incorrect' | 'missing'

export interface MultiFieldGradingResult {
  overallStatus: GradingStatus
  fieldResults: {
    lexicalItemId:   string
    expectedAnswer:  string
    typedAnswer?:    string
    status:          GradingFieldStatus
    issueType:       GradingIssueType
    reason:          string
  }[]
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

// ─── CardConfusion ────────────────────────────────────────────────────────────

/**
 * A tracked "mix-up": in a recognition step where the learner was shown the
 * native-language meaning (back) and had to pick the matching word in the
 * language being learned (front), they picked `confusedText` instead of
 * `cardId`'s actual front-side text. `count` is how many times this exact
 * mix-up has happened. `confusedWithCardId` links to the other card when
 * `confusedText` matches a real card's front the user owns; null for
 * AI-generated distractor text.
 */
export interface CardConfusion {
  userId:             UserId
  cardId:             CardId
  confusedWithCardId: CardId | null
  confusedText:       string
  /**
   * Which side of `cardId` the learner was asked to *produce* when this
   * mix-up happened — 'front' for "shown back, pick/type front" steps,
   * 'back' for the reverse. Used to match a confusion against the correct
   * distractor pool (`buildOptions`'s `side`).
   */
  answerSide:         CardSide
  /**
   * True if `confusedText` represents a genuinely different word: always
   * true for multiple-choice picks, and for typed answers true only when
   * `engine/grading.ts: isDifferentWordMistake()` says the answer wasn't
   * just a close typo/spelling/accent/article slip. Only word-level
   * mix-ups are eligible for promotion into multiple-choice distractors
   * (see `lib/distractors.ts: promoteConfusionDistractor()`).
   */
  isWordMixup:        boolean
  count:              number
  lastConfusedAt:     string
}

// ─── CardConfusionLink ────────────────────────────────────────────────────────

export type ConfusionKind = 'intra' | 'inter'
/** Similarity categories for an intra-language confusion (for the future practice mode). Multiple of
 *  phonetic/semantic/temporal may apply; 'other' is exclusive; empty = not yet fully classified. */
export type ConfusionSimilarityTag = 'phonetic' | 'semantic' | 'temporal' | 'other'

/** A bidirectional "I confuse these two cards" link, either set manually or
 *  auto-created when a typed answer exactly matches another card. */
export interface CardConfusionLink {
  id:        string
  userId:    UserId
  cardAId:   CardId
  cardBId:   CardId
  /** 'intra' = same learned language (full response); 'inter' = cross-language (stored only for now). */
  kind:      ConfusionKind
  /** Similarity tags for intra links; empty for inter or not-yet-classified. */
  tags:      ConfusionSimilarityTag[]
  createdAt: string
}

// ─── TypedAnswerOverride ────────────────────────────────────────────────────

/**
 * A persisted "this typed answer counts as correct" override for a given
 * card + direction, set via TypingMode's "Override as correct" /
 * "Override as incorrect" controls (see engine/grading.ts and
 * components/session/TypingMode.tsx). `answerText` is stored normalized
 * (per the deck's grading settings at the time it was set) — the same form
 * gradeTyping() produces as `normalizedUser`.
 */
export interface TypedAnswerOverride {
  userId:     UserId
  cardId:     CardId
  answerSide: CardSide
  answerText: string
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
  // ── FSRS Due Now scheduler (migration 074) ────────────────────────────────
  /** FSRS difficulty (1–10); null until the card is scheduled under FSRS. */
  difficulty:       number | null
  /** FSRS stability in days; null until scheduled under FSRS. */
  stability:        number | null
  /** In the post-lapse relearn gate (must reach 2 Goods in a row / Easy to leave). */
  relearning:       boolean
  /** Consecutive Goods while relearning (2 → exit). */
  goodStreak:       number
  /** Consecutive Agains while relearning (3 → back to the learning ladder). */
  againStreak:      number
  reps:             number
  lapses:           number
  lastRating:       Rating | null
  lastReviewedAt:   string | null
  /** ISO date (YYYY-MM-DD) when this card was first introduced to the user. */
  introducedDate:   string | null
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
  /**
   * Pre-graduation only. Consecutive wrong answers on a *typing* step
   * (stepType === 'typing'), reset to 0 by any correct typing-step answer.
   * When this reaches 3, it rolls into `typingFailCycles` and resets to 0.
   */
  typingMistakeStreak: number
  /**
   * Pre-graduation only. Counts how many times `typingMistakeStreak` has
   * hit 3 since the last multiple-choice "redo". On the 3rd such cycle, the
   * card is sent back to redo both recognition (multiple-choice) steps
   * before resuming typing, and this resets to 0.
   */
  typingFailCycles:    number
  /**
   * Pre-graduation only. ISO date (YYYY-MM-DD) the card most recently
   * *entered* the final "same-day window" — the last 3 pipeline steps
   * (stages 3-5: typing back->front x2, typing front->back x2, final
   * recognition front->back). All steps in this window must be completed on
   * this same calendar day for the card to graduate; if a later step in the
   * window is completed on a different day, the card is sent back to the
   * window's first step and this is reset to that day. Null for cards that
   * haven't reached this window yet (or pre-date this field).
   */
  stage3EnteredDate: string | null
  /** Total number of times the learner pressed "I don't know" on this card (across all sessions). */
  iDontKnowCount: number
  /**
   * Cumulative pipeline struggle count (typing mistakes + "?" + Repeat) while
   * the card is still learning — accumulates across sessions. Reset to 0 when
   * the card graduates (snapshotted into graduationErrorCount) or re-enters the
   * pipeline.
   */
  pipelineErrorCount:    number
  /**
   * The pipelineErrorCount at the moment the card most recently graduated.
   * Determines which grad-interval bucket (0–7, 8+) its first post-graduation
   * reviews calibrate. 0 for cards that graduated cleanly or pre-date this field.
   */
  graduationErrorCount:  number
  // ── Per-card error tracking (for adaptive strictness) ─────────────────────
  accentMistakeCount:   number
  articleMistakeCount:  number
  genderMistakeCount:   number
  typoMistakeCount:     number
  semanticMistakeCount: number
  wrongSynonymCount:    number
  // ── Dormancy ──────────────────────────────────────────────────────────────
  /** True = card stays in the deck and is manually reviewable, but never becomes due automatically. */
  dormant:              boolean
  /** After this many *production* (Due Now) reviews the card auto-goes dormant. null = never. Stored on the forward row. */
  dormancyThreshold:    number | null
  // ── Fast-track (import-known) acceleration ────────────────────────────────
  /** 'import_known' = fast-tracked with boosted multipliers; 'bulk_known' = bulk-graduated without fast-track; 'none' = normal schedule. */
  acceleratedMode:        'none' | 'import_known' | 'bulk_known'
  /** Locks the fast-track toggle in the UI after the first actual review. */
  acceleratedLocked:      boolean
  /** Consecutive 'again' ratings since last correct. Resets on correct; ≥2 → mode = 'none'. */
  acceleratedWrongStreak: number
  /** Permanent wrong-answer count. Each wrong linearly reduces the acceleration boost. */
  acceleratedPenalty:     number
  /**
   * How many production attempts remain in the post-acceleration restart window
   * (set to 3 when acceleratedMode transitions 'import_known' → 'none').
   * 0 = not in window.
   */
  postAccelRestartWindow: number
  /** How many of those attempts were wrong (≥ 2 → pipeline restart). */
  postAccelWrongCount:    number
  // ── Dual-interval tracks (Phase 1 / Phase 2) ──────────────────────────────
  /**
   * When non-null, the card has entered Phase 2 (recall track active).
   * This is the "ideal" interval for the typed-production track specifically.
   * null = Phase 2 not yet unlocked (card still on single-interval legacy track).
   */
  typedIntervalDays:   number | null
  /** ISO timestamp when the typed-production track is next due. Null until Phase 2. */
  typedDueAt:          string | null
  /** Ideal interval for the self-graded recall track. Null until Phase 2 unlocked. */
  recallIntervalDays:  number | null
  /** ISO timestamp when the recall track is next due. Null until Phase 2. */
  recallDueAt:         string | null
  /**
   * Smart-typing track: an independent forward-production lane presented as typed
   * while its interval is below the pair's threshold and self-graded once past it.
   * Its own FSRS schedule (shares difficulty/stability on the row). Null when the
   * card isn't on the smart-typing track.
   */
  smartIntervalDays:   number | null
  /** ISO timestamp when the smart-typing track is next due. Null when not on this track. */
  smartDueAt:          string | null
  /**
   * Accelerated (import-known) cards switch to self-graded once confirmed by a correct
   * typed review — after that they never demand typing again (you already knew the word).
   */
  acceleratedTypedConfirmed: boolean
  /**
   * 'forward' = English→Spanish (typed + recall).
   * 'reverse' = Spanish→English (recall only, never typed).
   * Separate CardState rows per direction share the same cardId.
   */
  reviewDirection:     'forward' | 'reverse'
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
  /** True when this review was on the accelerated (import-known) track. Null for legacy rows. */
  wasAccelerated:      boolean | null
  /** Value of CardState.acceleratedPenalty at the time of this review. Null for legacy rows. */
  acceleratedPenalty:  number | null
  /** Which review direction triggered this event. Null for legacy rows. */
  reviewDirection:     'forward' | 'reverse' | null
  /** CardState.reps at the time of this review (before progression). 0 for pre-graduation / legacy rows. */
  reps:                number
  /** True when this review caused the card to be ungraduated (sent back to the learning pipeline). */
  lapsed:              boolean
  /** How much of a "Hint" was used on this Due Now review: 0 = none, 1 = first letter / syllable core, 2 = two letters / full first syllable. */
  hintLevel:           number
  /** True when the typed answer was an "almost" (accent/typo/article slip); the calibrator weights these as a partial error. */
  nearMiss:            boolean
  /** Magnitude of the near-miss as a fraction of a full error: 0 = full credit, 0.2 (accent/article), 0.3 (spelling), 1 = full wrong. Generalizes nearMiss. */
  nearMissWeight:      number
  /** Which loggable slip category this review's typed answer had, if any. */
  errorCategory:       TypedErrorCategory | null
  /** The card's graduationErrorCount at review time — buckets first-post-graduation reviews for grad-interval calibration. */
  graduationErrorCount: number
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
  cardsPerSession:      number | null
  /**
   * How many cards to show per elective (study-ahead / category) session batch.
   * Null = use app default (20). 0 = no cap. Positive integer = cap at that value.
   */
  electiveSessionLimit: number | null
  /**
   * When true (and cardsPerSession is set): cards are studied in strict groups
   * of cardsPerSession — ALL cards in the current group must graduate before
   * the next group unlocks. When false (default): rolling — as each card
   * graduates a new one enters immediately to keep the pipeline full.
   */
  learningBatchMode:    boolean
  /**
   * When true: new-card intake is additionally capped so that
   * `graduatedToday(pair) + inPipeline + newlyIntroduced ≤ the pair's daily goal`
   * (language_pairs.goals for today). I.e. keep topping the pipeline up toward the
   * daily goal, but never enough to graduate past it. Composes with cardsPerSession /
   * the daily limit — it's an extra ceiling, whichever binds first wins. Only meaningful
   * on a single-deck ladder (per-deck setting). Default false.
   */
  capNewToGoal:         boolean
  /** Audio playback speed for this deck (applied at playback time; pitch preserved). 1 = normal. */
  audioSpeed:           number
  /** Audio playback volume for this deck (applied at playback time). 0–1, 1 = full. */
  audioVolume:          number
}

export const DEFAULT_DAILY_NEW_CARDS = 20

// ─── Session helpers ──────────────────────────────────────────────────────────

/**
 * Structured result from gradeTyping().
 *
 * `status`:
 *   'correct'   — normalized match; default rating Good
 *   'almost'    — off by accent/article/typo only; default rating Hard
 *   'incorrect' — substantially wrong; default rating Again
 *
 * `correct` is a convenience alias for `status === 'correct'` kept for
 * backward-compat with callers that haven't migrated to the status field yet.
 */
export interface GradingResult {
  status:             GradingStatus
  reason:             string            // human-readable explanation (empty string when correct)
  issueType:          GradingIssueType
  expectedAnswer:     string
  typedAnswer:        string
  matchedAnswer?:     string            // the specific slash-alternative that matched (if any)
  // ── Backward-compat ───────────────────────────────────────────────────────
  correct:            boolean           // true iff status === 'correct'
  normalizedUser:     string
  normalizedExpected: string
}

/** Per-card error counters for adaptive strictness and analytics. */
export interface ErrorStats {
  accentMistakeCount:   number
  articleMistakeCount:  number
  genderMistakeCount:   number
  typoMistakeCount:     number
  semanticMistakeCount: number
  wrongSynonymCount:    number
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

// ─── Language Syncing ─────────────────────────────────────────────────────────

export type SyncMode    = 'review_first' | 'auto'
export type SyncTrigger = 'on_card_created' | 'on_card_graduated' | 'manual_only'
export type SyncedCardStatus = 'pending' | 'active' | 'dismissed' | 'manually_edited'

/** A rule that syncs vocab from one language pair into another. */
export interface LanguageSyncRule {
  id:                            string
  userId:                        UserId
  sourcePairId:                  string
  destinationPairId:             string
  enabled:                       boolean
  mode:                          SyncMode
  trigger:                       SyncTrigger
  allowSyncedCardsToTriggerSync: boolean
  createdAt:                     string
  updatedAt:                     string
}

/**
 * Tracks a single synced card: the generated pair for one source card in one
 * destination language pair. `syncedCardId = null` when dismissed.
 */
export interface SyncedCardLink {
  id:                string
  userId:            UserId
  sourceCardId:      CardId
  syncedCardId:      CardId | null
  sourcePairId:      string
  destinationPairId: string
  syncRuleId:        string
  sourceFrontAtSync: string
  sourceBackAtSync:  string
  generatedFront:    string
  generatedBack:     string
  confidence:        number | null
  warning:           string | null
  status:            SyncedCardStatus
  createdAt:         string
  updatedAt:         string
}

/** Stable folder/deck infrastructure for a (user, source pair, dest pair) combination. */
export interface LanguageSyncState {
  userId:            UserId
  sourcePairId:      string
  destinationPairId: string
  rootFolderId:      string
  subFolderId:       string
  deckId:            string
  createdAt:         string
  updatedAt:         string
}
