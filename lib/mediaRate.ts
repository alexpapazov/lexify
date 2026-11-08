/**
 * lib/mediaRate.ts — what saving a worklist page DOES (Extraction Engine Stage B).
 *
 *  - Painted "I don't know" (new word) → learning card in the book's deck, book sentences as
 *    stored cloze. Marked items carry their in-context gloss; unmarked ones gloss here
 *    (Haiku batch, single-translation rule).
 *  - Painted Short/Long term (new word) → card born graduated with the bucket's seeding —
 *    identical math to onboarding (spread day, band-style difficulty, bulk_known).
 *  - Painted Short/Long on an EXISTING never-studied card → graduates THAT card, no duplicate.
 *  - Recognition failure (marked + graduated) → the real FSRS Again on every scheduled track,
 *    due NOW, lapse counted — plus the card links into the book's deck with its sentences.
 *    sendToLadder is deliberately ignored (a book mark never un-graduates a card by itself).
 *  - No review_events anywhere: the entry's ratings map is the audit trail.
 */

import type { Card, CardState, Rating } from '@/domain'
import type { CardStateRepository } from '@/lib/data/interfaces'
import { scheduleGraduatedFsrs } from '@/engine/dueNow'
import { DEFAULT_FSRS_CONFIG, initialDifficulty, stabilityForInterval } from '@/engine/fsrs'
import { claimSpreadDay, onboardDueIso } from '@/engine/density'
import { initialCardState } from '@/engine/pipeline'
import { CHIP_WINDOWS, CHIP_SEED_RATING, parseGlosses } from '@/lib/mediaIntake'
import { activeProductionTrack, calibrationFor, retentionFor, type EnabledTracks } from '@/lib/sessionLimits'
import { apiUrl } from '@/lib/apiBase'
import { mapLimit, chunk } from '@/lib/mapLimit'

export interface RateDeps {
  userId:       string
  src:          string
  tgt:          string
  now:          Date
  tracks:       EnabledTracks | undefined
  retMap:       Map<string, number>
  calMap:       Map<string, number>
  stateRepo:    CardStateRepository
  pipelineId:   string
  /** Shared mutable day-load map (engine/density.seedOnboardLoad) so one save spreads evenly. */
  load:         Map<number, number>
}

/** Haiku batch glosses + display forms for chips that become cards without in-context data.
 *  `display` carries the noun-article flashcard form when the book's option asks for it. */
export async function fetchGlosses(lemmas: string[], src: string, tgt: string, nounArticle: boolean): Promise<Map<string, { gloss: string; display: string | null }>> {
  const out = new Map<string, { gloss: string; display: string | null }>()
  if (lemmas.length === 0) return out
  const batches = chunk(lemmas, 100)
  await mapLimit(batches, 2, async batch => {
    try {
      const res = await fetch(apiUrl('/api/media/gloss'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lemmas: batch, sourceLanguage: src, targetLanguage: tgt, nounArticle }),
      })
      const data = await res.json() as { ok: boolean }
      if (data.ok) {
        for (const [i, g] of parseGlosses(data)) {
          const lemma = batch[i]
          if (lemma) out.set(lemma, g)
        }
      }
    } catch { /* unglossed chips are skipped by the caller, never saved with an empty back */ }
    return null
  })
  return out
}

/** The graduated rows a short/long-painted word gets — onboarding's buildStates, bucket-flavored. */
export function seedKnownStates(
  cardId: string,
  bucket: 'short' | 'long',
  existingFwd: CardState | undefined,
  existingRev: CardState | undefined,
  deps: RateDeps,
): CardState[] {
  const nowIso = deps.now.toISOString()
  const prodTrack = activeProductionTrack(deps.tracks) ?? 'typed'
  const window = CHIP_WINDOWS[bucket]
  const make = (direction: 'forward' | 'reverse'): CardState => {
    const offset = claimSpreadDay(deps.load, window)
    const dueAt  = onboardDueIso(deps.now, offset)
    const field  = direction === 'forward' ? (prodTrack === 'smart' ? 'forward_smart' : 'forward_typed') : 'reverse_recall'
    const base   = (direction === 'forward' ? existingFwd : existingRev)
      ?? { ...initialCardState(deps.userId, cardId, existingFwd?.pipelineId ?? deps.pipelineId), reviewDirection: direction }
    return {
      ...base,
      reviewDirection: direction,
      graduated: true, graduatedAt: nowIso,
      relearning: false, relearningStep: 0, goodStreak: 0, againStreak: 0,
      difficulty: initialDifficulty([CHIP_SEED_RATING[bucket]]),
      stability:  stabilityForInterval(offset, retentionFor(deps.retMap, deps.src, deps.tgt, field)),
      intervalDays: offset, scheduledIntervalDays: offset, dueAt,
      ...(direction === 'forward'
        ? (prodTrack === 'smart'
            ? { smartIntervalDays: offset, smartDueAt: dueAt }
            : { typedIntervalDays: offset, typedDueAt: dueAt })
        : { recallIntervalDays: offset, recallDueAt: dueAt }),
      acceleratedMode: 'bulk_known' as const,
    }
  }
  return [make('forward'), make('reverse')]
}

export interface PenaltyOutcome { forward?: CardState; reverse?: CardState }

/**
 * The recognition-failure penalty: you underlined a word your lexicon says you know. The real
 * FSRS Again runs on each graduated row (stability collapses exactly as a failed review's
 * would, lapse counted, relearn gate armed) and every scheduled lane comes due NOW.
 */
export async function applyRecognitionPenalty(
  card: Card,
  forwardState: CardState | null,
  reverseState: CardState | null,
  deps: RateDeps,
): Promise<PenaltyOutcome> {
  const nowIso = deps.now.toISOString()
  const out: PenaltyOutcome = {}

  const again = (state: CardState, intervalDays: number, field: string) =>
    scheduleGraduatedFsrs({
      difficulty: state.difficulty, stability: state.stability,
      intervalDays, lapses: state.lapses,
      relearning: false, goodStreak: 0, againStreak: 0,
      elapsedDays: state.lastReviewedAt
        ? Math.max(0, (deps.now.getTime() - new Date(state.lastReviewedAt).getTime()) / 86_400_000)
        : intervalDays,
    }, 'again' as Rating, {
      ...DEFAULT_FSRS_CONFIG,
      requestRetention:     retentionFor(deps.retMap, deps.src, deps.tgt, field),
      retentionCalibration: calibrationFor(deps.calMap, deps.src, deps.tgt, field),
    }, {})

  if (forwardState?.graduated && !forwardState.dormant) {
    const prodTrack = activeProductionTrack(deps.tracks) ?? 'typed'
    const interval = forwardState.smartIntervalDays ?? forwardState.typedIntervalDays ?? forwardState.intervalDays
    const fsrs = again(forwardState, interval, prodTrack === 'smart' ? 'forward_smart' : 'forward_typed')
    out.forward = {
      ...forwardState,
      difficulty: fsrs.difficulty, stability: fsrs.stability,
      relearning: true, relearningStep: 1, goodStreak: 0, againStreak: fsrs.againStreak,
      lapses: forwardState.lapses + 1,
      lastRating: 'again', lastReviewedAt: nowIso,
      dueAt: nowIso,
      ...(forwardState.smartDueAt != null ? { smartDueAt: nowIso } : {}),
      ...(forwardState.typedDueAt != null ? { typedDueAt: nowIso } : {}),
      ...(forwardState.recallDueAt != null ? { recallDueAt: nowIso } : {}),
    }
    await deps.stateRepo.upsert(out.forward)
  }

  if (reverseState?.graduated && !reverseState.dormant) {
    const interval = reverseState.recallIntervalDays ?? reverseState.intervalDays
    const fsrs = again(reverseState, interval, 'reverse_recall')
    out.reverse = {
      ...reverseState,
      difficulty: fsrs.difficulty, stability: fsrs.stability,
      relearning: true, relearningStep: 1, goodStreak: 0, againStreak: fsrs.againStreak,
      lapses: reverseState.lapses + 1,
      lastRating: 'again', lastReviewedAt: nowIso,
      recallDueAt: nowIso, dueAt: nowIso,
    }
    await deps.stateRepo.upsert(out.reverse)
  }

  return out
}
