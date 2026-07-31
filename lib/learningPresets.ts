/**
 * lib/learningPresets.ts — ready-made ladders and pathways.
 *
 * Pure data + builders: no React, no Supabase. A preset is just a starting point — picking one drops
 * its shape into the editor, where it can be renamed and reshaped before saving.
 *
 * See `features/Learning Pathways (proposal).md` for what the pathway pieces mean, and
 * `domain/index.ts` for `Ladder` / `Pathway`.
 */

import type { Ladder, Pathway, PathwayState, Transition, TypedStrictness } from '@/domain'

const STRICT: TypedStrictness = { spelling: 'penalize', accents: 'penalize', articles: 'penalize' }
const LENIENT: TypedStrictness = { spelling: 'retype', accents: 'accept', articles: 'accept' }

const GRAD_STATE_ID = '__graduated__'
const TERMINAL: PathwayState = {
  id: GRAD_STATE_ID, name: 'Graduated', type: 'self_graded', direction: 'produce_target',
  selfRated: false, intervalInit: false, isTerminal: true,
}

const MIN = 60

export interface LearningPreset<T> {
  id:    string
  label: string
  /** One line explaining who it's for — shown under the name in the picker. */
  blurb: string
  build: () => T
}

// ─── Ladder presets ──────────────────────────────────────────────────────────

/** Classic: recognise both ways, then type it, then self-rate. The app's long-standing default. */
function balancedLadder(): Ladder {
  return {
    betweenRungWaitSeconds: 180,
    rungs: [
      { id: 'r1', type: 'mcq',    direction: 'produce_native', distractorSource: 'deck', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
      { id: 'r2', type: 'mcq',    direction: 'produce_target', distractorSource: 'smart', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
      { id: 'r3', type: 'typing', direction: 'produce_target', strictness: STRICT, selfRated: false, intervalInit: false, advanceTimes: 2, advanceInARow: true,
        dropBacks: [{ on: 'miss', times: 2, inARow: true, toRungId: 'r2' }] },
      { id: 'r4', type: 'typing', direction: 'produce_target', strictness: STRICT, selfRated: true, intervalInit: true, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
      { id: 'r5', type: 'self_graded', direction: 'produce_native', selfRated: true, intervalInit: true, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
    ],
  }
}

/** Two rungs, lenient typing — for words you half-know and want moving fast. */
function fastLadder(): Ladder {
  return {
    betweenRungWaitSeconds: 60,
    rungs: [
      { id: 'f1', type: 'mcq',    direction: 'produce_target', distractorSource: 'smart', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true,
        skipAheads: [{ on: 'pass', times: 1, inARow: true, toRungId: 'f2' }], dropBacks: [] },
      { id: 'f2', type: 'typing', direction: 'produce_target', strictness: LENIENT, selfRated: true, intervalInit: true, advanceTimes: 1, advanceInARow: true,
        advanceRules: [{ times: 1, inARow: true, minRating: 'easy' }, { times: 2, inARow: true, minRating: 'good' }],
        dropBacks: [{ on: 'again', times: 1, inARow: true, toRungId: 'f1' }] },
    ],
  }
}

/** Every direction, strict typing, dictation for listening — for words that must stick. */
function thoroughLadder(): Ladder {
  return {
    betweenRungWaitSeconds: 300,
    rungs: [
      { id: 't1', type: 'mcq',       direction: 'produce_native', distractorSource: 'smart', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
      { id: 't2', type: 'mcq',       direction: 'produce_target', distractorSource: 'smart', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
      { id: 't3', type: 'dictation', direction: 'produce_target', strictness: STRICT, selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true,
        dropBacks: [{ on: 'miss', times: 2, inARow: true, toRungId: 't2' }] },
      { id: 't4', type: 'typing',    direction: 'produce_target', strictness: STRICT, selfRated: false, intervalInit: false, advanceTimes: 2, advanceInARow: true,
        dropBacks: [{ on: 'miss', times: 2, inARow: true, toRungId: 't3' }] },
      { id: 't5', type: 'typing',    direction: 'produce_target', strictness: STRICT, selfRated: true, intervalInit: true, advanceTimes: 1, advanceInARow: true,
        advanceRules: [{ times: 1, inARow: true, minRating: 'easy' }, { times: 2, inARow: true, minRating: 'good' }], dropBacks: [] },
      { id: 't6', type: 'self_graded', direction: 'produce_native', selfRated: true, intervalInit: true, advanceTimes: 1, advanceInARow: true,
        advanceRules: [{ times: 1, inARow: true, minRating: 'easy' }, { times: 2, inARow: true, minRating: 'good' }], dropBacks: [] },
    ],
  }
}

export const LADDER_PRESETS: LearningPreset<Ladder>[] = [
  { id: 'balanced', label: 'Balanced',  blurb: 'Recognise both ways, then type it, then self-rate. A good default.', build: balancedLadder },
  { id: 'fast',     label: 'Fast',      blurb: 'Two rungs, lenient typing — for words you half-know already.',        build: fastLadder },
  { id: 'thorough', label: 'Thorough',  blurb: 'Every direction plus dictation, strict typing. For words that must stick.', build: thoroughLadder },
]

// ─── Pathway presets ─────────────────────────────────────────────────────────

/** Straight line: recognise, type, graduate. The shape most people expect. */
function simplePathway(): Pathway {
  const states: PathwayState[] = [
    { id: 'p1', name: 'Recognise', type: 'mcq', direction: 'produce_native', distractorSource: 'smart', selfRated: false, intervalInit: false },
    { id: 'p2', name: 'Produce',   type: 'typing', direction: 'produce_target', strictness: STRICT, selfRated: true, intervalInit: true },
    { id: 'p3', name: 'Recall',    type: 'self_graded', direction: 'produce_native', selfRated: true, intervalInit: true },
    { ...TERMINAL },
  ]
  const transitions: Transition[] = [
    { id: 'p1-ok',   from: 'p1', to: 'p2', priority: 100, when: [{ kind: 'correct', is: true }] },
    { id: 'p2-easy', from: 'p2', to: 'p3', priority: 10,  when: [{ kind: 'rating', is: 'easy' }] },
    { id: 'p2-good', from: 'p2', to: 'p3', priority: 20,  when: [{ kind: 'counter', name: 'consecutiveGood', gte: 2 }] },
    { id: 'p2-bad',  from: 'p2', to: 'p1', priority: 30,  when: [{ kind: 'rating', is: 'again' }] },
    { id: 'p3-easy', from: 'p3', to: GRAD_STATE_ID, priority: 10, when: [{ kind: 'rating', is: 'easy' }] },
    { id: 'p3-good', from: 'p3', to: GRAD_STATE_ID, priority: 20, when: [{ kind: 'counter', name: 'consecutiveGood', gte: 2 }] },
    { id: 'p3-bad',  from: 'p3', to: 'p2', priority: 30, when: [{ kind: 'rating', is: 'again' }] },
  ]
  return { id: 'simple', startStateId: 'p1', states, transitions, betweenStateWaitSeconds: 180 }
}

/** Branches on the KIND of mistake — spelling slips retype, wrong words go back to recognition. */
function errorAwarePathway(): Pathway {
  const states: PathwayState[] = [
    { id: 'e1', name: 'Recognise',      type: 'mcq', direction: 'produce_target', distractorSource: 'smart', selfRated: false, intervalInit: false },
    { id: 'e2', name: 'Type it',        type: 'typing', direction: 'produce_target', strictness: STRICT, selfRated: true, intervalInit: true },
    { id: 'e3', name: 'Spelling drill', type: 'typing', direction: 'produce_target', strictness: STRICT, selfRated: false, intervalInit: false, minReshowSeconds: 60 },
    { id: 'e4', name: 'Recall',         type: 'self_graded', direction: 'produce_native', selfRated: true, intervalInit: true },
    { ...TERMINAL },
  ]
  const transitions: Transition[] = [
    { id: 'e1-ok',      from: 'e1', to: 'e2', priority: 100, when: [{ kind: 'correct', is: true }] },
    // A spelling or accent slip is a different failure from not knowing the word — drill it, don't demote.
    { id: 'e2-spell',   from: 'e2', to: 'e3', priority: 10, when: [{ kind: 'errorType', is: 'spelling' }] },
    { id: 'e2-accent',  from: 'e2', to: 'e3', priority: 11, when: [{ kind: 'errorType', is: 'accent' }] },
    { id: 'e2-wrong',   from: 'e2', to: 'e1', priority: 20, when: [{ kind: 'errorType', is: 'wrong_word' }] },
    { id: 'e2-easy',    from: 'e2', to: 'e4', priority: 30, when: [{ kind: 'rating', is: 'easy' }] },
    { id: 'e2-good',    from: 'e2', to: 'e4', priority: 40, when: [{ kind: 'counter', name: 'consecutiveGood', gte: 2 }] },
    { id: 'e3-ok',      from: 'e3', to: 'e2', priority: 100, when: [{ kind: 'correct', is: true }] },
    { id: 'e4-easy',    from: 'e4', to: GRAD_STATE_ID, priority: 10, when: [{ kind: 'rating', is: 'easy' }] },
    { id: 'e4-good',    from: 'e4', to: GRAD_STATE_ID, priority: 20, when: [{ kind: 'counter', name: 'consecutiveGood', gte: 2 }] },
    { id: 'e4-bad',     from: 'e4', to: 'e2', priority: 30, when: [{ kind: 'rating', is: 'again' }] },
  ]
  return { id: 'error-aware', startStateId: 'e1', states, transitions, betweenStateWaitSeconds: 120 }
}

/**
 * ADAPTIVE (advanced) — the fast route is three questions and two minutes.
 *
 * ```
 * A. Initial target MCQ ──1 correct──▶ B. Target setter (typed) ──success──▶ C. Native setter
 *                                              │                                  (dictation)
 *                                              └──failure──▶ A                      │
 *                                                                    success ───────┴──▶ graduated
 *                                                                    failure ──▶ D. Native support MCQ ──▶ C
 * ```
 *
 * The design point: the DIAGNOSTIC and the INTERVAL SETTER are the same stage, so a transparent
 * cognate can graduate in three questions. Support stages (A on the way back, D) exist only to catch
 * a card that actually failed — a learner who knows the word never sees them twice.
 *
 * Success is **one Easy or two Goods in a row**, deliberately not two Easies: Easy should mean "that
 * single exposure was enough", and demanding it twice would slow down exactly the transparent words
 * this pathway exists to accelerate.
 */
function adaptiveAdvancedPathway(): Pathway {
  const states: PathwayState[] = [
    {
      // A wrong answer here re-shows after a minute — no self-transition, see the note below.
      id: 'a', name: 'Initial target exposure', type: 'mcq', direction: 'produce_target',
      distractorSource: 'smart', selfRated: false, intervalInit: false, minReshowSeconds: 1 * MIN,
    },
    {
      // Sets the TARGET-production interval and tests the word in one go.
      id: 'b', name: 'Target setter (typed)', type: 'typing', direction: 'produce_target',
      strictness: STRICT, selfRated: true, intervalInit: true, minReshowSeconds: 2 * MIN,
    },
    {
      // Sets the NATIVE-direction interval; dictation also forces auditory comprehension.
      id: 'c', name: 'Native setter (dictation)', type: 'dictation', direction: 'produce_native',
      strictness: LENIENT, selfRated: true, intervalInit: true, minReshowSeconds: 2 * MIN,
    },
    {
      id: 'd', name: 'Native support', type: 'mcq', direction: 'produce_native',
      distractorSource: 'smart', selfRated: false, intervalInit: false, minReshowSeconds: 1 * MIN,
    },
    { ...TERMINAL },
  ]

  // NO SELF-TRANSITIONS. Taking any transition — even one pointing back at the same state — runs
  // `enterState`, which resets the per-state counters. A "repeat this stage" self-loop would
  // therefore wipe `consecutiveGood` on every single Good, so "two Goods in a row" could never be
  // reached. Instead, an outcome that should repeat the stage matches NOTHING: the engine keeps the
  // card where it is, preserves the counters, and re-shows after the state's `minReshowSeconds` —
  // which is where the spec's "wait 2 minutes" lives.
  //
  // One deliberate deviation from the written spec: "2 Hard in a row" has no direct expression,
  // because `consecutiveAgain` is streak-NEUTRAL for Hard by design. `attemptsInState >= 3` covers
  // it — two Hards means the third attempt sends the card back anyway — and it also implements the
  // spec's own "3 attempts without meeting a success condition" rule.
  const transitions: Transition[] = [
    // ── A. Initial target exposure ──────────────────────────────────────────
    // A wrong MCQ already reveals the answer, so there's no separate "show the pairing" stage.
    { id: 'a-ok', from: 'a', to: 'b', priority: 10, when: [{ kind: 'correct', is: true }], waitSecondsOverride: 1 * MIN },

    // ── B. Target-direction setter ──────────────────────────────────────────
    { id: 'b-easy',  from: 'b', to: 'c', priority: 10, when: [{ kind: 'rating', is: 'easy' }], waitSecondsOverride: 1 * MIN },
    { id: 'b-good2', from: 'b', to: 'c', priority: 20, when: [{ kind: 'counter', name: 'consecutiveGood', gte: 2 }], waitSecondsOverride: 1 * MIN },
    // Again sends the card back for a supported exposure; it returns here after one correct MCQ.
    { id: 'b-again', from: 'b', to: 'a', priority: 50, when: [{ kind: 'rating', is: 'again' }], waitSecondsOverride: 1 * MIN },
    { id: 'b-stuck', from: 'b', to: 'a', priority: 70, when: [{ kind: 'attemptsInState', gte: 3 }], waitSecondsOverride: 1 * MIN },

    // ── C. Native-direction setter ──────────────────────────────────────────
    { id: 'c-easy',  from: 'c', to: GRAD_STATE_ID, priority: 10, when: [{ kind: 'rating', is: 'easy' }] },
    { id: 'c-good2', from: 'c', to: GRAD_STATE_ID, priority: 20, when: [{ kind: 'counter', name: 'consecutiveGood', gte: 2 }] },
    { id: 'c-again', from: 'c', to: 'd', priority: 50, when: [{ kind: 'rating', is: 'again' }], waitSecondsOverride: 1 * MIN },
    { id: 'c-stuck', from: 'c', to: 'd', priority: 70, when: [{ kind: 'attemptsInState', gte: 3 }], waitSecondsOverride: 1 * MIN },

    // ── D. Native support ───────────────────────────────────────────────────
    // Not redundant with A: you only get here after failing the UNSUPPORTED native-direction setter.
    { id: 'd-ok', from: 'd', to: 'c', priority: 10, when: [{ kind: 'correct', is: true }], waitSecondsOverride: 1 * MIN },
  ]

  return { id: 'adaptive-advanced', startStateId: 'a', states, transitions, betweenStateWaitSeconds: 60 }
}

export const PATHWAY_PRESETS: LearningPreset<Pathway>[] = [
  { id: 'simple',            label: 'Simple',            blurb: 'Recognise, produce, recall. A straight line with a way back.', build: simplePathway },
  { id: 'error-aware',       label: 'Error-aware',       blurb: 'Branches on the kind of mistake — spelling slips drill, wrong words demote.', build: errorAwarePathway },
  { id: 'adaptive-advanced', label: 'Adaptive (advanced)', blurb: 'Diagnostic and interval-setter in one. A word you know graduates in three questions.', build: adaptiveAdvancedPathway },
]
