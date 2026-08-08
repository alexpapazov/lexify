/**
 * lib/labelCards.ts — client orchestration for the vocabulary labeling pass (practice-mode groundwork).
 *
 * Takes any set of cards (typically the whole library's unlabeled ones), groups them by language
 * pair — the route prompts per pair — chunks each group, runs the chunks against /api/cards/label
 * with bounded concurrency, and PERSISTS EACH BATCH as it lands via `cardRepo.setLabels`. That
 * last part matters: a 2,000-card backfill that's interrupted keeps everything labeled so far, and
 * re-running only sends what's still unlabeled (the caller filters on `pos === null`).
 *
 * A batch that fails is counted in `failedCount` rather than aborting, same contract as
 * lib/onboardVerify.ts.
 */

import { apiUrl } from '@/lib/apiBase'
import { mapLimit, chunk } from '@/lib/mapLimit'
import { SupabaseCardRepository } from '@/lib/data/cards'
import type { LabelResult } from '@/app/api/cards/label/route'

/** Cards per request. Comfortably under the route's LABEL_BATCH_CAP. */
const LABEL_CHUNK = 60

/** Requests in flight — same reasoning as the onboarding verify pass. */
const LABEL_CONCURRENCY = 4

export interface LabelableCard {
  id:             string
  front:          string
  back:           string
  sourceLanguage: string
  targetLanguage: string
}

export interface LabelRun {
  /** Cards that received and persisted a label. */
  labeledCount: number
  /** Cards no batch could label (network/AI failures, or skipped by the model). */
  failedCount:  number
}

/**
 * Labels `cards`, reporting progress as `(done, total)` in cards. Labels are persisted batch by
 * batch, so partial progress survives navigation away.
 */
export async function labelCards(
  cards:       LabelableCard[],
  onProgress?: (done: number, total: number) => void,
): Promise<LabelRun> {
  if (cards.length === 0) return { labeledCount: 0, failedCount: 0 }

  // One batch never mixes language pairs — the route's prompt names a single pair.
  const byPair = new Map<string, LabelableCard[]>()
  for (const c of cards) {
    const key = `${c.sourceLanguage}|${c.targetLanguage}`
    const list = byPair.get(key) ?? []
    list.push(c)
    byPair.set(key, list)
  }
  const batches = [...byPair.values()].flatMap(group => chunk(group, LABEL_CHUNK))

  const repo = new SupabaseCardRepository()
  let done = 0
  let labeledCount = 0

  const results = await mapLimit(batches, LABEL_CONCURRENCY, async batch => {
    const res = await fetch(apiUrl('/api/cards/label'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceLanguage: batch[0]!.sourceLanguage,
        targetLanguage: batch[0]!.targetLanguage,
        cards: batch.map(c => ({ front: c.front, back: c.back })),
      }),
    })
    const data = await res.json()
    if (!data?.ok || !Array.isArray(data.labels)) throw new Error(data?.reason ?? 'label-failed')

    const entries = (data.labels as LabelResult[])
      .filter(l => batch[l.index] != null)
      .map(l => ({ id: batch[l.index]!.id, pos: l.pos, lemma: l.lemma }))
    await repo.setLabels(entries)
    return entries.length
  }, () => {
    done = Math.min(cards.length, done + LABEL_CHUNK)
    onProgress?.(done, cards.length)
  })

  results.forEach(r => { if (r !== null) labeledCount += r })
  onProgress?.(cards.length, cards.length)
  return { labeledCount, failedCount: cards.length - labeledCount }
}
