/**
 * lib/ladder.ts — pure helpers for the configurable learning ladder (Stage 1).
 * Framework-free so the rules are unit-testable.
 */

import type { Ladder, Rung, RungType, RungDirection } from '@/domain'
import { DEFAULT_LADDER, DEFAULT_TYPED_STRICTNESS } from '@/domain'

/** The ladder that actually governs a pair: its own if set, else the user's default, else the built-in. */
export function resolveEffectiveLadder(pairLadder: Ladder | null, defaultLadder: Ladder | null): Ladder {
  if (pairLadder && pairLadder.rungs.length > 0) return pairLadder
  if (defaultLadder && defaultLadder.rungs.length > 0) return defaultLadder
  return DEFAULT_LADDER
}

/** A fresh rung of the given type with sensible defaults. */
export function newRung(type: RungType): Rung {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `r${Date.now()}${Math.random().toString(36).slice(2, 7)}`
  const base: Rung = {
    id, type,
    direction: 'produce_target',
    selfRated: type === 'self_graded',
    intervalInit: false,
    advanceTimes: 1,
    advanceInARow: true,
    dropBacks: [],
  }
  if (type === 'mcq')       base.distractorSource = 'deck'
  if (type === 'typing' || type === 'dictation') base.strictness = { ...DEFAULT_TYPED_STRICTNESS }
  if (type === 'dictation') base.direction = 'produce_target'   // dictation is always produce-target
  return base
}

/**
 * True when a rung is allowed to set (graduate) its direction's starting interval.
 * Typing and self-graded always can. **Dictation can only when producing the NATIVE word**
 * (hear the target → type its translation) — that demonstrates you can translate it. Producing the
 * target on a dictation rung is just transcribing the audio you heard, so it can't set the interval.
 * `direction` is optional for backward-compat; dictation without a direction is treated as not-allowed.
 */
export function canInitInterval(type: RungType, direction?: RungDirection): boolean {
  if (type === 'typing' || type === 'self_graded') return true
  if (type === 'dictation') return direction === 'produce_native'
  return false
}

/**
 * Validates a ladder for saving. Returns a list of human-readable problems
 * (empty = OK). Mirrors the spec: at least one rung; interval-init only on eligible rungs
 * (typing/self_graded, or native-producing dictation); and interval-init is all-or-nothing —
 * either none, or exactly one per direction.
 */
export function validateLadder(ladder: Ladder): string[] {
  const errors: string[] = []
  const rungs = ladder.rungs
  if (rungs.length === 0) { errors.push('Add at least one rung.'); return errors }

  rungs.forEach((r, i) => {
    const n = i + 1
    // Dictation can produce either side: you always HEAR the target word; producing the target = type
    // what you hear, producing the native = type the translation of what you hear.
    if (r.intervalInit && !canInitInterval(r.type, r.direction)) {
      errors.push(r.type === 'dictation'
        ? `Rung ${n}: a dictation rung can only set the interval when it produces the native word (translation).`
        : `Rung ${n}: only typing, self-graded, or native-producing dictation rungs can set the interval.`)
    }
    if (r.advanceTimes < 1) errors.push(`Rung ${n}: "times" must be at least 1.`)
  })

  const initRungs = rungs.filter(r => r.intervalInit)
  if (initRungs.length > 0) {
    const targetInits = initRungs.filter(r => r.direction === 'produce_target').length
    const nativeInits = initRungs.filter(r => r.direction === 'produce_native').length
    if (targetInits !== 1 || nativeInits !== 1) {
      errors.push('Interval-setting: pick exactly one for each direction (one target, one native) — or none at all.')
    }
  }
  return errors
}
