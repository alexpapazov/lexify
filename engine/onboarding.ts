/**
 * engine/onboarding.ts — turning a confidence self-rating into a scheduled, graduated card.
 *
 * Onboarding lets a learner paste a big word list (a frequency list, a course glossary) and rate how
 * well they already know each item, instead of climbing the ladder with words they've known for
 * years. A rating picks a BAND; the band decides when the card is first seen again and what memory
 * state it starts from.
 *
 * Band 1 ("don't know") is not represented here at all — it writes no CardState, so the card is
 * simply an unlearned card and the ladder picks it up normally.
 *
 * Pure: no React, no Supabase, no clock. The caller supplies `now` and persists the result.
 */

import type { OnboardingBand, Rating } from '@/domain'
import { initialDifficulty, stabilityForInterval } from './fsrs'

/**
 * Where each band lands. `center` is the intent ("about a week", "about a month", "about six
 * months"); `min`/`max` are the window the due date may be spread across so a 1000-card import
 * doesn't all come due on the same three days.
 *
 * The windows are deliberately NON-OVERLAPPING (11 < 15, 45 < 126) so the bands stay distinguishable
 * — a band-3 card is never seen sooner than a band-2 one. They widen with the interval: a day of
 * slack matters at 7 days and doesn't at 180.
 */
export const ONBOARD_BANDS: Record<Exclude<OnboardingBand, 1>, { center: number; min: number; max: number }> = {
  2: { center: 7,   min: 3,   max: 11  },
  3: { center: 30,  min: 15,  max: 45  },
  4: { center: 180, min: 126, max: 234 },
}

/** Human labels for the rating buttons. Kept next to the bands so the UI can't drift from the math. */
export const BAND_LABELS: Record<OnboardingBand, { title: string; detail: string }> = {
  1: { title: "Don't know it",  detail: 'Learn it from scratch' },
  2: { title: 'Recognize it',   detail: 'See it again in about a week' },
  3: { title: 'Know it',        detail: 'In about a month' },
  4: { title: 'Know it cold',   detail: 'In about six months' },
}

/**
 * The learning history a band stands in for. An onboarded card never actually climbed the ladder, so
 * its difficulty comes from the rating the learner would plausibly have given: band 2 ≈ Hard (shaky),
 * band 3 ≈ Good, band 4 ≈ Easy. Reusing `initialDifficulty` keeps onboarded and ladder-graduated
 * cards on one scale rather than inventing a second set of magic numbers.
 */
const BAND_AS_RATING: Record<Exclude<OnboardingBand, 1>, Rating> = { 2: 'hard', 3: 'good', 4: 'easy' }

export interface OnboardMemoryState { difficulty: number; stability: number }

/**
 * The FSRS state an onboarded card starts life with.
 *
 * `assignedDays` is the day the card ACTUALLY landed on after spreading — not the band's center — so
 * stability explains the card's own due date and its next interval grows from where it really sits.
 *
 * Retention calibration is deliberately NOT applied here: it's a correction learned from the
 * learner's measured review performance, and an onboarded card has no review history to correct for.
 * The first real review picks it up as normal.
 */
export function onboardMemoryState(band: Exclude<OnboardingBand, 1>, assignedDays: number, retention: number): OnboardMemoryState {
  return {
    difficulty: initialDifficulty([BAND_AS_RATING[band]]),
    stability:  stabilityForInterval(assignedDays, retention),
  }
}

/** The spread window for a band — what the due-date spreader is handed per card. */
export function bandWindow(band: Exclude<OnboardingBand, 1>): { min: number; max: number } {
  const b = ONBOARD_BANDS[band]
  return { min: b.min, max: b.max }
}

/** True for the bands that graduate a card immediately (everything except "don't know"). */
export function bandGraduates(band: OnboardingBand): band is Exclude<OnboardingBand, 1> {
  return band !== 1
}
