/**
 * lib/externalSession.ts — the EXTERNAL study session log (2026-11-15).
 *
 * The learner studies words outside Lexify (ChatGPT batch drills, writing exercises, tutoring)
 * and pastes the word list in afterwards so the scheduler catches up. Pure helpers:
 *
 *  - `parseSessionWords` — paste text → words (+ optional inline glosses)
 *  - `matchSessionItems` — lexicon match (same lemma-primary index as media intake) + status
 *  - `statesForExternalRating` — what a rating does to an ALREADY-GRADUATED card:
 *      · fresh ("just learned") → both rows pinned into the 2–4 day window (explicit override —
 *        the learner had to relearn it, so the long interval was a lie)
 *      · short ("know it") → a real FSRS Good review on each graduated row
 *      · long ("know it well") → a real FSRS Easy review
 *    Non-graduated cards never come here — they go through `seedKnownStates` (the rating
 *    graduates THAT card), and brand-new words get a card + `seedKnownStates`.
 *
 * No review_events anywhere: the session row's items are the audit trail (same rule as media).
 */

import type { Card, CardState, Rating } from '@/domain'
import { scheduleGraduatedFsrs } from '@/engine/dueNow'
import { DEFAULT_FSRS_CONFIG, stabilityForInterval } from '@/engine/fsrs'
import { maturityPhase } from '@/engine/implicitCredit'
import { normalizeKey, compareWithLexicon, CHIP_WINDOWS, type IntakeCandidate, type SeedBucket } from '@/lib/mediaIntake'
import { activeProductionTrack, calibrationFor, retentionFor } from '@/lib/sessionLimits'
import type { RateDeps } from '@/lib/mediaRate'

// ─── Parsing the paste ─────────────────────────────────────────────────────────

export interface ParsedWord { word: string; gloss: string | null }

/** Leading list decorations: "- ", "• ", "3. ", "3) ", "* ". */
const BULLET = /^\s*(?:[-–—•*]|\d+[.)])\s+/
/** Inline gloss separators, tried in order. Spaced hyphen only — "porte-manteau" survives. */
const SEPARATORS = ['\t', ' — ', ' – ', ' - ', ' = ', ': ']

/**
 * One word (optionally `word — gloss`) per line; a single-line paste splits on commas or
 * semicolons instead. Deduped by `normalizeKey`, first occurrence wins.
 */
export function parseSessionWords(text: string): ParsedWord[] {
  let lines = text.split('\n').map(l => l.replace(BULLET, '').trim()).filter(Boolean)
  if (lines.length === 1 && /[;,]/.test(lines[0]!)) {
    lines = lines[0]!.split(/[;,]/).map(s => s.trim()).filter(Boolean)
  }
  const seen = new Set<string>()
  const out: ParsedWord[] = []
  for (const line of lines) {
    let word = line
    let gloss: string | null = null
    for (const sep of SEPARATORS) {
      const i = line.indexOf(sep)
      if (i > 0) {
        word = line.slice(0, i).trim()
        gloss = line.slice(i + sep.length).trim() || null
        break
      }
    }
    if (!word) continue
    const key = normalizeKey(word)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ word, gloss })
  }
  return out
}

// ─── Matching against the lexicon ──────────────────────────────────────────────

export type SessionStatus = 'new' | 'never' | 'learning' | 'shortterm' | 'longterm'

/** FULLY SERIALIZABLE — the session row stores these as its audit trail. */
export interface SessionItem {
  key:           string
  /** As pasted — becomes a new card's front. */
  word:          string
  /** Pasted inline, or Haiku-glossed by the page before rating. */
  gloss:         string | null
  existingId:    string | null
  existingFront: string | null
  existingBack:  string | null
  /** The card's standing when the session was logged. */
  status:        SessionStatus
  /** The rating given; null = skipped (×). */
  bucket:        SeedBucket | null
  /** What saving actually did: created | graduated | reviewed | pinned | skipped | glossless. */
  outcome:       string | null
}

/** Status shorthand off the forward row (production-lane interval, same as `cardMaturity`). */
export function sessionStatus(state: CardState | undefined): SessionStatus {
  if (!state) return 'never'
  if (state.graduated) {
    return maturityPhase(state.smartIntervalDays ?? state.typedIntervalDays ?? state.intervalDays) === 'long_term'
      ? 'longterm' : 'shortterm'
  }
  return state.reps > 0 || state.currentStepOrder > 0 || state.correctInStep > 0 ? 'learning' : 'never'
}

/** Pasted words → session items via the SAME lemma-primary lexicon index media intake uses. */
export function matchSessionItems(
  parsed: ParsedWord[],
  cards: Card[],
  forward: Map<string, CardState>,
  sourceLanguage: string,
  targetLanguage: string,
): SessionItem[] {
  const matches = compareWithLexicon(
    parsed.map(p => ({ text: p.word, lemma: p.word, kind: 'word', gloss: p.gloss ?? '', sentences: [], count: 1, markers: [] } as IntakeCandidate)),
    cards, sourceLanguage, targetLanguage,
  )
  return parsed.map((p, i) => {
    const existing = matches[i]!.existing
    return {
      key: normalizeKey(p.word), word: p.word, gloss: p.gloss,
      existingId:    existing?.id ?? null,
      existingFront: existing?.front ?? null,
      existingBack:  existing?.back ?? null,
      status: existing ? sessionStatus(forward.get(existing.id)) : 'new',
      bucket: 'fresh', outcome: null,
    }
  })
}

// ─── What a rating does to a graduated card ────────────────────────────────────

/** A real FSRS review on one graduated row: stability/difficulty advance exactly as an
 *  in-session rating's would, every scheduled lane moves to the new due date. */
function reviewRow(state: CardState, direction: 'forward' | 'reverse', grade: Rating, deps: RateDeps): CardState {
  const nowIso = deps.now.toISOString()
  const prodTrack = activeProductionTrack(deps.tracks) ?? 'typed'
  const field = direction === 'forward' ? (prodTrack === 'smart' ? 'forward_smart' : 'forward_typed') : 'reverse_recall'
  const intervalDays = direction === 'forward'
    ? state.smartIntervalDays ?? state.typedIntervalDays ?? state.intervalDays
    : state.recallIntervalDays ?? state.intervalDays
  const fsrs = scheduleGraduatedFsrs({
    difficulty: state.difficulty, stability: state.stability,
    intervalDays, lapses: state.lapses,
    relearning: false, goodStreak: 0, againStreak: 0,
    elapsedDays: state.lastReviewedAt
      ? Math.max(0, (deps.now.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
      : intervalDays,
  }, grade, {
    ...DEFAULT_FSRS_CONFIG,
    requestRetention:     retentionFor(deps.retMap, deps.src, deps.tgt, field),
    retentionCalibration: calibrationFor(deps.calMap, deps.src, deps.tgt, field),
  }, {})
  const days  = fsrs.intervalDays ?? 1
  const dueAt = new Date(deps.now.getTime() + days * 86_400_000).toISOString()
  return {
    ...state,
    difficulty: fsrs.difficulty, stability: fsrs.stability,
    relearning: false, relearningStep: 0, goodStreak: fsrs.goodStreak, againStreak: 0,
    reps: state.reps + 1,
    lastRating: grade, lastReviewedAt: nowIso,
    intervalDays: days, scheduledIntervalDays: days, dueAt,
    ...(direction === 'forward'
      ? {
          ...(state.smartDueAt  != null ? { smartIntervalDays: days, smartDueAt: dueAt } : {}),
          ...(state.typedDueAt  != null ? { typedIntervalDays: days, typedDueAt: dueAt } : {}),
          ...(state.recallDueAt != null ? { recallIntervalDays: days, recallDueAt: dueAt } : {}),
        }
      : { recallIntervalDays: days, recallDueAt: dueAt }),
  }
}

/** Pin one graduated row into a short window (the "just learned" override): the interval is
 *  SET, stability re-seeded to match so later reviews grow from it honestly. */
function pinRow(state: CardState, direction: 'forward' | 'reverse', offset: number, deps: RateDeps): CardState {
  const nowIso = deps.now.toISOString()
  const dueAt  = new Date(deps.now.getTime() + offset * 86_400_000).toISOString()
  return {
    ...state,
    relearning: false, relearningStep: 0, goodStreak: 0, againStreak: 0,
    stability: stabilityForInterval(offset, DEFAULT_FSRS_CONFIG.requestRetention),
    lastRating: 'good', lastReviewedAt: nowIso,
    intervalDays: offset, scheduledIntervalDays: offset, dueAt,
    ...(direction === 'forward'
      ? {
          ...(state.smartDueAt  != null ? { smartIntervalDays: offset, smartDueAt: dueAt } : {}),
          ...(state.typedDueAt  != null ? { typedIntervalDays: offset, typedDueAt: dueAt } : {}),
          ...(state.recallDueAt != null ? { recallIntervalDays: offset, recallDueAt: dueAt } : {}),
        }
      : { recallIntervalDays: offset, recallDueAt: dueAt }),
  }
}

/**
 * The graduated-card path: both rows move together. `fresh` pins into the 2–4 day window
 * (one shared offset so the directions stay side by side); `short` = real Good; `long` =
 * real Easy. Returns the updated rows to upsert (dormant rows are left asleep).
 */
export function statesForExternalRating(
  forwardState: CardState | undefined,
  reverseState: CardState | undefined,
  bucket: SeedBucket,
  deps: RateDeps,
): CardState[] {
  const out: CardState[] = []
  const w = CHIP_WINDOWS.fresh
  const offset = w.min + Math.floor(Math.random() * (w.max - w.min + 1))
  const apply = (state: CardState | undefined, direction: 'forward' | 'reverse') => {
    if (!state?.graduated || state.dormant) return
    out.push(bucket === 'fresh'
      ? pinRow(state, direction, offset, deps)
      : reviewRow(state, direction, bucket === 'long' ? 'easy' : 'good', deps))
  }
  apply(forwardState, 'forward')
  apply(reverseState, 'reverse')
  return out
}
