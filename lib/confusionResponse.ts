/**
 * lib/confusionResponse.ts — session-side orchestration of the production-confusion response.
 * On a wrong typed production answer whose text is a genuine different word matching another card,
 * we LINK the pair (persistent — foundation for the distinguish tool) and PENALIZE both cards'
 * recognition (reverse) tracks. Detection + penalty math live in engine/confusion.ts.
 *
 * The immediate A-vs-B drill, mutual distractors, and interleaving are separate consumers of the
 * confusion link (built on top of this).
 */

import { SupabaseCardConfusionLinkRepository } from '@/lib/data/cardConfusionLinks'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { findConfusedSibling, confusionPenalty, type SiblingCard } from '@/engine/confusion'
import { snapDueAtToStartOfDay } from '@/lib/dates'
import type { GradingSettings } from '@/domain'

const DAY_MS = 86_400_000
let cache: { userId: string; sibs: SiblingCard[] } | null = null

/** Whole-library {id, front} index, loaded once per user (lazily, only when a confusion is suspected). */
async function library(userId: string): Promise<SiblingCard[]> {
  if (cache?.userId === userId) return cache.sibs
  const rows = await new SupabaseCardRepository().listFrontsForUser(userId)
  const sibs = rows.map(r => ({ cardId: r.id, front: r.front }))
  cache = { userId, sibs }
  return sibs
}

/** Cut a card's recognition (reverse) track: reduce stability, bump difficulty, pull recall due sooner. */
async function penalizeReverse(userId: string, cardId: string, tz: string, turnover: number): Promise<void> {
  const repo = new SupabaseCardStateRepository()
  const rev = await repo.get(userId, cardId, 'reverse').catch(() => null)
  if (!rev || !rev.graduated || rev.dormant) return
  const pen = confusionPenalty({ difficulty: rev.difficulty, stability: rev.stability })
  if (!pen) return
  const dueAt = snapDueAtToStartOfDay(new Date(Date.now() + pen.intervalDays * DAY_MS).toISOString(), tz, turnover)
  await repo.upsert({
    ...rev, difficulty: pen.difficulty, stability: pen.stability,
    recallIntervalDays: pen.intervalDays, recallDueAt: dueAt, intervalDays: pen.intervalDays, dueAt,
  })
}

/**
 * Full response to a wrong typed PRODUCTION answer. If the typed word is a genuine different word
 * that matches another card (B), link A↔B and penalize both recognition tracks. Returns B's id (for
 * the caller to queue the A-vs-B drill), or null if it wasn't a confusion. Never throws.
 */
export async function respondToProductionConfusion(args: {
  userId: string; cardAId: string; typed: string; expectedFront: string
  gradingSettings: GradingSettings; tz: string; turnover: number
}): Promise<string | null> {
  try {
    const sibs = await library(args.userId)
    const cardBId = findConfusedSibling(args.typed, args.expectedFront, args.cardAId, sibs, args.gradingSettings)
    if (!cardBId) return null
    await new SupabaseCardConfusionLinkRepository().link(args.userId, args.cardAId, cardBId).catch(() => {})
    await Promise.all([
      penalizeReverse(args.userId, args.cardAId, args.tz, args.turnover).catch(() => {}),
      penalizeReverse(args.userId, cardBId, args.tz, args.turnover).catch(() => {}),
    ])
    return cardBId
  } catch { return null }
}
