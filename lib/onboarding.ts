import type { Ladder } from '@/domain'
import { DEFAULT_LADDER } from '@/domain'

// ── Study style → Due Now review tracks ─────────────────────────────────────
export type StudyStyle = 'smart' | 'typed' | 'selfgraded'

export const STUDY_STYLES: { id: StudyStyle; icon: string; title: string; desc: string }[] = [
  { id: 'smart',      icon: '🧠', title: 'Smart typing',   desc: 'Type new words until they stick, then just recall them. Best of both — recommended.' },
  { id: 'typed',      icon: '⌨️', title: 'Type everything', desc: 'Always type the answer. The most rigorous.' },
  { id: 'selfgraded', icon: '👁️', title: 'No typing',       desc: 'Flashcards you grade yourself. Fastest, least strict.' },
]

/** The four per-pair review-track flags for a chosen style (+ reverse recognition). */
export function tracksForStyle(style: StudyStyle, reverse: boolean) {
  return {
    forward_typed_enabled:  style === 'typed',
    forward_smart_enabled:  style === 'smart',
    forward_recall_enabled: style === 'selfgraded',
    reverse_recall_enabled: reverse,
  }
}

// ── Ladder depth presets ────────────────────────────────────────────────────
export type LadderDepth = 'quick' | 'standard' | 'thorough'

const STRICT = { spelling: 'penalize', accents: 'penalize', articles: 'penalize' } as const

export const LADDER_PRESETS: Record<LadderDepth, { title: string; desc: string; ladder: Ladder }> = {
  quick: {
    title: 'Quick',
    desc: 'Recognize it, type it once, recall it. Fewest steps to graduate.',
    ladder: {
      rungs: [
        { id: 'r1', type: 'mcq',         direction: 'produce_native', distractorSource: 'deck', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
        { id: 'r2', type: 'typing',      direction: 'produce_target', strictness: STRICT,        selfRated: true,  intervalInit: true,  advanceTimes: 1, advanceInARow: true, dropBacks: [] },
        { id: 'r3', type: 'self_graded', direction: 'produce_native',                            selfRated: true,  intervalInit: true,  advanceTimes: 1, advanceInARow: true, dropBacks: [] },
      ],
    },
  },
  standard: {
    title: 'Standard',
    desc: 'Recognize both ways, type it twice, then recall. A balanced default — recommended.',
    ladder: DEFAULT_LADDER,
  },
  thorough: {
    title: 'Thorough',
    desc: 'Adds dictation and extra reps for deeper mastery.',
    ladder: {
      rungs: [
        { id: 'r1', type: 'mcq',         direction: 'produce_native', distractorSource: 'deck', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
        { id: 'r2', type: 'mcq',         direction: 'produce_target', distractorSource: 'deck', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
        { id: 'r3', type: 'typing',      direction: 'produce_target', strictness: STRICT,        selfRated: false, intervalInit: false, advanceTimes: 2, advanceInARow: true, dropBacks: [] },
        { id: 'r4', type: 'dictation',   direction: 'produce_target', strictness: STRICT,        selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
        { id: 'r5', type: 'typing',      direction: 'produce_target', strictness: STRICT,        selfRated: true,  intervalInit: true,  advanceTimes: 1, advanceInARow: true, dropBacks: [] },
        { id: 'r6', type: 'self_graded', direction: 'produce_native',                            selfRated: true,  intervalInit: true,  advanceTimes: 2, advanceInARow: true, dropBacks: [] },
      ],
    },
  },
}

// ── Daily pace → new words/day goal ─────────────────────────────────────────
export type Pace = 'casual' | 'regular' | 'intense'

export const PACES: { id: Pace; label: string; perDay: number; desc: string }[] = [
  { id: 'casual',  label: 'Casual',  perDay: 5,  desc: 'A few minutes a day' },
  { id: 'regular', label: 'Regular', perDay: 15, desc: 'A steady daily habit' },
  { id: 'intense', label: 'Intense', perDay: 30, desc: 'Learning fast' },
]

/** A weekly goal object (all 7 days = perDay) for LanguagePair.goals. */
export function goalsForPace(perDay: number): Record<string, number> {
  return { 0: perDay, 1: perDay, 2: perDay, 3: perDay, 4: perDay, 5: perDay, 6: perDay }
}
