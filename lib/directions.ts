/**
 * lib/directions.ts — card DIRECTIONS as a per-pair choice (Due Now Redesign Part 1, 2026-11-20).
 *
 * A pair is either SINGLE direction (native→target production only — no recognition schedules
 * exist at all) or MULTIPLE (each direction its own schedule). The underlying mechanism stays
 * the per-track enabled flags; what changed is the semantics at the edges (user decisions,
 * design draft round 2):
 *
 *  - Multiple → single DELETES the recognition rows outright (no ghosting — "cards pile up").
 *    A confirm dialog shows the count first. Review history (events) stays; it's log data.
 *  - Single → multiple seeds a recognition row per graduated production row: difficulty/
 *    stability/interval copied, first due date SPREAD randomly within the card's own interval
 *    window so the new direction phases in without a 2× spike. Then they diverge.
 *  - Production modality (typed / smart / self-graded) is ONE choice per direction — compiled
 *    to the three production flags (chosen on, others off).
 *
 * Future (NOT built): directions as ordered field pairs, so a three-field language (character/
 * pinyin/native) grows the checklist to six without a redesign. Keep new code keyed by the
 * direction's identity, not by deeper forward/reverse hardcoding.
 */

import type { Card, CardState, UserId } from '@/domain'
import { initialCardState } from '@/engine/pipeline'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'

export type ProductionModality = 'typed' | 'smart' | 'selfgraded'

/** The single modality a pair's production direction currently runs (smart wins over typed —
 *  they're mutually exclusive by construction; self-graded only when neither typing lane is on). */
export function currentModality(flags: { typed: boolean; smart: boolean; selfgraded: boolean }): ProductionModality {
  if (flags.smart) return 'smart'
  if (flags.typed) return 'typed'
  if (flags.selfgraded) return 'selfgraded'
  return 'typed'
}

/** What each modality compiles to: [answerField row, db column, value] triples. */
export function modalityFlagWrites(m: ProductionModality): { answerField: string; column: string; value: boolean }[] {
  return [
    { answerField: 'forward_typed',  column: 'forward_typed_enabled',  value: m === 'typed' },
    { answerField: 'forward_smart',  column: 'forward_smart_enabled',  value: m === 'smart' },
    { answerField: 'forward_recall', column: 'forward_recall_enabled', value: m === 'selfgraded' },
  ]
}

/**
 * A fresh recognition row seeded from a graduated production row. Memory state (difficulty/
 * stability) is copied — the directions share one memory until reviews diverge them — and the
 * first due date lands uniformly within [1, interval] days so enabling recognition on a big
 * library phases in instead of doubling one day's reviews. Dormancy and the auto-graduated
 * marker carry over (a paused or goal-exempt card stays paused/exempt in both directions).
 */
export function seedReverseRow(fwd: CardState, now: Date, rand: () => number = Math.random): CardState {
  const interval = Math.max(1, Math.round(fwd.smartIntervalDays ?? fwd.typedIntervalDays ?? fwd.intervalDays))
  const offset = 1 + Math.floor(rand() * interval)
  const dueAt = new Date(now.getTime() + offset * 86_400_000).toISOString()
  return {
    ...initialCardState(fwd.userId, fwd.cardId, fwd.pipelineId),
    reviewDirection: 'reverse',
    graduated: true,
    graduatedAt: fwd.graduatedAt ?? now.toISOString(),
    difficulty: fwd.difficulty, stability: fwd.stability,
    intervalDays: interval, scheduledIntervalDays: interval, dueAt,
    recallIntervalDays: interval, recallDueAt: dueAt,
    dormant: fwd.dormant,
    acceleratedMode: fwd.acceleratedMode,
  }
}

/** The pair's cards + states, grouped the way both conversions need them. */
async function loadPair(userId: UserId, src: string, tgt: string): Promise<{
  cards: Card[]
  forward: Map<string, CardState>
  reverse: Map<string, CardState>
}> {
  const [cards, states] = await Promise.all([
    new SupabaseCardRepository().listOwned(userId, src, tgt),
    new SupabaseCardStateRepository().listAllForUser(userId),
  ])
  const ids = new Set(cards.map(c => c.id))
  const forward = new Map<string, CardState>()
  const reverse = new Map<string, CardState>()
  for (const s of states) {
    if (!ids.has(s.cardId)) continue
    if (s.reviewDirection === 'reverse') reverse.set(s.cardId, s)
    else if (!forward.has(s.cardId) || s.graduated) forward.set(s.cardId, s)
  }
  return { cards, forward, reverse }
}

/** How many recognition schedules the single-direction switch would delete — for the confirm. */
export async function countRecognitionRows(userId: UserId, src: string, tgt: string): Promise<number> {
  return (await loadPair(userId, src, tgt)).reverse.size
}

/**
 * Sets one track flag, CREATING the params row first when the pair never had one — a plain
 * UPDATE on a missing row silently no-ops, which left "disabled" tracks effectively on
 * (bug found 2026-11-20 via Catch Up still listing reverse cards).
 */
export async function setTrackFlag(userId: UserId, src: string, tgt: string, answerField: string, column: string, value: boolean): Promise<void> {
  const repo = new SupabaseUserSchedulerParamsRepository()
  await repo.getOrCreate(userId, src, tgt, answerField)
  await repo.update(userId, src, tgt, answerField, { [column]: value })
}

/**
 * Multiple → single: permanently deletes every recognition row of the pair and turns the
 * reverse track off. Returns how many were deleted. IRREVERSIBLE by design (user decision:
 * no ghosting) — callers confirm first via `countRecognitionRows`.
 */
export async function disableRecognitionDirection(userId: UserId, src: string, tgt: string): Promise<number> {
  const { reverse } = await loadPair(userId, src, tgt)
  const ids = [...reverse.keys()]
  if (ids.length > 0) await new SupabaseCardStateRepository().deleteReverseForCards(userId, ids)
  await setTrackFlag(userId, src, tgt, 'reverse_recall', 'reverse_recall_enabled', false)
  return ids.length
}

/**
 * Single → multiple: turns the reverse track on and seeds a recognition row for every
 * graduated production row that doesn't have one (spread seeding — see `seedReverseRow`).
 * Cards still in the learning pipeline need nothing: graduation creates both directions.
 * Returns how many rows were seeded.
 */
export async function enableRecognitionDirection(userId: UserId, src: string, tgt: string): Promise<number> {
  await setTrackFlag(userId, src, tgt, 'reverse_recall', 'reverse_recall_enabled', true)
  const { forward, reverse } = await loadPair(userId, src, tgt)
  const now = new Date()
  const rows: CardState[] = []
  for (const [cardId, fwd] of forward) {
    if (!fwd.graduated || reverse.has(cardId)) continue
    rows.push(seedReverseRow(fwd, now))
  }
  if (rows.length > 0) await new SupabaseCardStateRepository().upsertBatch(rows)
  return rows.length
}
