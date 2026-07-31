/**
 * lib/pipelineCost.ts — how long a new word will take, given the pipeline it actually has to climb.
 *
 * The old estimate was "recent ladder time ÷ recent words graduated" per language. That's measured,
 * but it's blind to the SHAPE of the pipeline: shorten a ladder from six rungs to two and the
 * estimate keeps quoting the old figure until a month of new history washes it out — and a language
 * with no history at all borrows a global average that may describe a completely different pipeline.
 *
 * The model here separates the two things that actually drive the number:
 *
 *   time per new word  =  minimum answers to graduate   (structure — known exactly, updates instantly)
 *                      ×  struggle factor               (measured — how many extra attempts you take)
 *                      ×  time per answer               (measured, per language)
 *
 * Structure comes from the live `Ladder`/`Pathway`, so editing a pipeline or switching a language to
 * pathway mode moves the estimate immediately. The two measured factors come from recency-weighted
 * history, so it keeps tracking reality as you get faster or slower.
 *
 * Pure — no React, no Supabase, no clock.
 */

import type { Ladder, Pathway } from '@/domain'

/** Fallback when a language has no measured history and no readable pipeline. */
export const DEFAULT_MS_PER_ANSWER = 12_000

/**
 * Struggle is clamped: 1 at the bottom because you cannot graduate in fewer than the minimum number
 * of answers, and 4 at the top so a handful of unlucky cards in a thin window can't quote an
 * absurd figure.
 */
export const MIN_STRUGGLE = 1
export const MAX_STRUGGLE = 4

/**
 * The fewest answers a card must give to climb a ladder.
 *
 * Per rung that's the smallest `times` among its advance rules (they're OR-ed, so the cheapest one
 * wins), falling back to the legacy single `advanceTimes`. Drop-backs and skip-aheads are ignored on
 * purpose: this is the FLOOR, and the struggle factor is what accounts for the messy real path.
 */
export function ladderMinAnswers(ladder: Ladder): number {
  return ladder.rungs.reduce((sum, rung) => {
    const rules = rung.advanceRules && rung.advanceRules.length > 0
      ? rung.advanceRules.map(r => r.times)
      : [rung.advanceTimes]
    const cheapest = Math.min(...rules.map(t => Math.max(1, t || 1)))
    return sum + cheapest
  }, 0)
}

/**
 * The fewest answers a card must give to reach a pathway's graduation state — a breadth-first
 * shortest path over the transition graph, counting one answer per state entered.
 *
 * A pathway has no fixed length (it can branch backwards indefinitely), so the shortest route is the
 * only structural number that means anything. Everything above it is struggle, which is exactly what
 * the measured factor is for.
 *
 * Returns 0 when graduation is unreachable — a broken pathway, which `validatePathway` reports
 * separately; the caller falls back rather than quoting a nonsense estimate.
 */
export function pathwayMinAnswers(pathway: Pathway): number {
  const terminals = new Set(pathway.states.filter(s => s.isTerminal).map(s => s.id))
  if (terminals.size === 0) return 0

  const out = new Map<string, string[]>()
  for (const t of pathway.transitions) {
    const arr = out.get(t.from)
    if (arr) arr.push(t.to); else out.set(t.from, [t.to])
  }

  // BFS from the start state. Entering a terminal costs nothing — you don't answer a graduation.
  const seen = new Set<string>([pathway.startStateId])
  let frontier = [pathway.startStateId]
  let answers = 0
  while (frontier.length > 0) {
    answers++
    const next: string[] = []
    for (const id of frontier) {
      for (const to of out.get(id) ?? []) {
        if (terminals.has(to)) return answers
        if (seen.has(to)) continue
        seen.add(to)
        next.push(to)
      }
    }
    frontier = next
  }
  return 0   // graduation unreachable
}

/** The structural floor for whichever pipeline a language is actually using. */
export function minAnswersForPipeline(
  mode: 'ladder' | 'pathway',
  ladder: Ladder | null,
  pathway: Pathway | null,
): number {
  if (mode === 'pathway' && pathway) return pathwayMinAnswers(pathway)
  if (ladder) return ladderMinAnswers(ladder)
  return 0
}

/**
 * How many answers a card takes in practice, as a multiple of the structural minimum.
 *
 * Measured ACROSS languages on purpose. Per-language it would be circular — dividing a language's
 * measured answers by its own structural minimum and then multiplying straight back gives you the
 * measurement again, so a pipeline change would have no effect, which is the whole problem being
 * fixed. Pooling means one language's edit moves only that language's estimate, while the "people
 * make about this many mistakes" factor stays steady.
 *
 * `answers` and `graduations` are recency-weighted totals; `minAnswers` is each pair's structural
 * floor, weighted by its share of graduations.
 */
export function struggleFactor(
  perPair: { answers: number; graduations: number; minAnswers: number }[],
): number {
  let observed = 0
  let expected = 0
  for (const p of perPair) {
    if (p.graduations <= 0 || p.minAnswers <= 0 || p.answers <= 0) continue
    observed += p.answers
    expected += p.minAnswers * p.graduations
  }
  if (expected <= 0 || observed <= 0) return MIN_STRUGGLE
  return Math.min(MAX_STRUGGLE, Math.max(MIN_STRUGGLE, observed / expected))
}

/**
 * Estimated time for ONE new word in a given language.
 *
 * `msPerAnswer` should already have fallen back to a global figure when the language itself is too
 * thin. When the pipeline can't be read (`minAnswers <= 0`) the caller has nothing structural to go
 * on, so this returns the historical per-word figure if one was supplied, else a plain default.
 */
export function newCardMs(args: {
  minAnswers:   number
  struggle:     number
  msPerAnswer:  number
  /** Optional measured ms-per-word for this language, used only when the pipeline is unreadable. */
  fallbackPerWordMs?: number
}): number {
  const { minAnswers, struggle, msPerAnswer } = args
  if (minAnswers <= 0 || msPerAnswer <= 0) {
    return args.fallbackPerWordMs && args.fallbackPerWordMs > 0 ? args.fallbackPerWordMs : DEFAULT_MS_PER_ANSWER * 5
  }
  return minAnswers * Math.max(MIN_STRUGGLE, struggle) * msPerAnswer
}
