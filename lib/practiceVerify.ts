/**
 * lib/practiceVerify.ts — the client half of the sentence quality gate.
 *
 * Generation (Haiku) writes sentences; this asks a stronger model whether each one is actually good
 * in the target language, and drops the ones that aren't. Only survivors reach the learner or the
 * bank, so a bad sentence is never cached and never seen twice.
 *
 * FAIL-OPEN. If the judge is unavailable or unparseable, every sentence passes. A quality gate that
 * empties the session when it can't run is worse than a session with an occasional clumsy sentence.
 */

import { apiUrl } from '@/lib/apiBase'
import { mapLimit, chunk } from '@/lib/mapLimit'
import type { PracticeExercise } from '@/lib/practiceSchema'
import type { SentenceVerdict } from '@/app/api/practice/verify/route'

/** Sentences per request. Comfortably under the route's cap. */
const VERIFY_CHUNK = 12

/** Requests in flight — same shape as the app's other AI fan-outs. */
const VERIFY_CONCURRENCY = 3

export interface VerifyOutcome<T> {
  kept:     T[]
  /** Rejected sentences with the judge's reason, for logging/diagnosis. */
  rejected: { item: T; issue: string }[]
}

/**
 * Filters `items` down to the sentences a native speaker would accept.
 *
 * `pick` maps an item to the exercise being judged, so this works on bare exercises or on the
 * prepared wrapper the session uses.
 */
export async function verifySentences<T>(
  items:          T[],
  pick:           (item: T) => PracticeExercise,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<VerifyOutcome<T>> {
  if (items.length === 0) return { kept: [], rejected: [] }

  const batches = chunk(items.map((item, i) => ({ item, i })), VERIFY_CHUNK)

  const results = await mapLimit(batches, VERIFY_CONCURRENCY, async batch => {
    const res = await fetch(apiUrl('/api/practice/verify'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceLanguage,
        targetLanguage,
        sentences: batch.map(({ item }) => {
          const ex = pick(item)
          return { sentence: ex.sentence, translation: ex.translation, targetWord: ex.answer }
        }),
      }),
    })
    const data = await res.json()
    if (!data?.ok || !Array.isArray(data.verdicts)) throw new Error(data?.reason ?? 'verify-failed')
    // Batch-local indices back to positions in `items`.
    return (data.verdicts as SentenceVerdict[])
      .filter(v => batch[v.index] != null)
      .map(v => ({ index: batch[v.index]!.i, ok: v.ok, issue: v.issue }))
  })

  // Default every sentence to accepted; only an explicit rejection removes one. A batch that failed
  // outright contributes nothing, so its sentences keep their default and pass.
  const verdictByIndex = new Map<number, { ok: boolean; issue?: string }>()
  for (const batchResult of results) {
    if (!batchResult) continue
    for (const v of batchResult) verdictByIndex.set(v.index, { ok: v.ok, issue: v.issue })
  }

  const kept: T[] = []
  const rejected: { item: T; issue: string }[] = []
  items.forEach((item, i) => {
    const verdict = verdictByIndex.get(i)
    if (verdict && !verdict.ok) rejected.push({ item, issue: verdict.issue ?? 'rejected' })
    else kept.push(item)
  })

  return { kept, rejected }
}
