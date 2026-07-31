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
import { findConfusedSibling, confusionPenalty, confusionKind, classifyIntraTags, type SiblingCard } from '@/engine/confusion'
import { injectForcedDistractor } from '@/lib/distractors'
import { snapDueAtToStartOfDay } from '@/lib/dates'
import type { GradingSettings } from '@/domain'

const DAY_MS = 86_400_000
let cache: { userId: string; sibs: SiblingCard[] } | null = null

/** Whole-library {id, front} index, loaded once per user (lazily, only when a confusion is suspected). */
async function library(userId: string): Promise<SiblingCard[]> {
  if (cache?.userId === userId) return cache.sibs
  const rows = await new SupabaseCardRepository().listFrontsForUser(userId)
  const sibs = rows.map(r => ({ cardId: r.id, front: r.front, sourceLanguage: r.sourceLanguage }))
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

/** Add `word` as a distractor in `cardId`'s recognition MCQ (the "pick the target word" pool). */
async function mutualDistractor(cardId: string, word: string): Promise<void> {
  const repo = new SupabaseCardRepository()
  const card = await repo.get(cardId).catch(() => null)
  if (!card) return
  const choices = injectForcedDistractor(card, 'front', word)
  if (choices) await repo.update(cardId, { choices }).catch(() => {})
}

/**
 * Full response to a wrong typed PRODUCTION answer. If the typed word is a genuine different word
 * that matches another card (B):
 *   • INTRA-language (A & B same learned language) → link (tagged intra + similarity) AND penalize
 *     both recognition tracks. Returns {cardBId, cardBFront} for the immediate A-vs-B drill.
 *   • INTER-language (different languages) → just store the link (kind='inter'), no penalty, returns null.
 * Never throws.
 */
interface ConfusionDrillTarget { cardBId: string; cardBFront: string }

export async function respondToProductionConfusion(args: {
  userId: string; cardAId: string; sourceLanguageA: string; typed: string; expectedFront: string
  gradingSettings: GradingSettings; tz: string; turnover: number
}): Promise<ConfusionDrillTarget | null> {
  try {
    const sibs = await library(args.userId)
    const cardBId = findConfusedSibling(args.typed, args.expectedFront, args.cardAId, sibs, args.gradingSettings)
    if (!cardBId) return null
    const cardB = sibs.find(s => s.cardId === cardBId)!
    const linkRepo = new SupabaseCardConfusionLinkRepository()
    const kind = confusionKind(args.sourceLanguageA, cardB.sourceLanguage)

    if (kind === 'inter') {
      // Store only — a future cross-linguistic feature will act on inter-language mix-ups.
      await linkRepo.link(args.userId, args.cardAId, cardBId, 'inter', []).catch(() => {})
      return null
    }

    // Intra: tag by similarity (phonetic/temporal now; semantic is future), link, penalize both.
    const stateRepo = new SupabaseCardStateRepository()
    const [fwdA, fwdB] = await Promise.all([
      stateRepo.get(args.userId, args.cardAId, 'forward').catch(() => null),
      stateRepo.get(args.userId, cardBId, 'forward').catch(() => null),
    ])
    const tags = classifyIntraTags({
      frontA: args.expectedFront, frontB: cardB.front,
      introducedA: fwdA?.introducedDate, introducedB: fwdB?.introducedDate,
    })
    await linkRepo.link(args.userId, args.cardAId, cardBId, 'intra', tags).catch(() => {})
    await Promise.all([
      penalizeReverse(args.userId, args.cardAId, args.tz, args.turnover).catch(() => {}),
      penalizeReverse(args.userId, cardBId, args.tz, args.turnover).catch(() => {}),
      // Mutual distractors: make each word a distractor in the other's recognition MCQ (choices.front
      // = the "pick the target word" pool). Best-effort — skips if choices aren't generated yet.
      mutualDistractor(args.cardAId, cardB.front),
      mutualDistractor(cardBId, args.expectedFront),
    ])
    return { cardBId, cardBFront: cardB.front }
  } catch { return null }
}
