/**
 * lib/onboardVerify.ts — client orchestration for the onboarding accuracy pass.
 *
 * Splits the pasted list into batches, runs them against /api/cards/verify with bounded concurrency,
 * and maps each batch's local indices back onto the caller's list. A batch that fails is reported as
 * `uncheckedCount` rather than aborting — the learner shouldn't lose a 1000-word verification
 * because one request timed out.
 */

import { apiUrl } from '@/lib/apiBase'
import { mapLimit, chunk } from '@/lib/mapLimit'

// Defined here, not in the verify route — client code must never import from `app/api/**`
// (the Capacitor build stashes it; see lib/practiceSchema.ts).
export type VerifyIssue = 'mistranslation' | 'ambiguous' | 'language'

export interface VerifyResult {
  /** Index into the request's `cards` array. */
  index:          number
  issue:          VerifyIssue
  /** One short sentence the learner can act on. */
  note:           string
  /** Corrected text, when the model can offer one. Absent = "you decide". */
  suggestedFront?: string
  suggestedBack?:  string
}

/** Cards per request. Comfortably under the route's VERIFY_BATCH_CAP, and small enough that one
 *  batch's flagged list can't exhaust the response token budget. */
const VERIFY_CHUNK = 50

/** Requests in flight. Matches the offline download's AI concurrency — enough to hide latency,
 *  low enough not to trip provider rate limits (a 429 here reads as "couldn't check"). */
const VERIFY_CONCURRENCY = 4

/** A flag against the caller's ORIGINAL list index. */
export interface FlaggedCard extends Omit<VerifyResult, 'index'> {
  index: number
}

export interface VerifyRun {
  flagged: FlaggedCard[]
  /** How many cards no batch could check (network/AI failures). Surfaced so a silent gap is visible. */
  uncheckedCount: number
}

interface VerifyCard { front: string; back: string }

/**
 * Verifies `cards`, reporting progress as `(checked, total)`.
 *
 * Flags come back sorted by the caller's index so the review UI lists them in list order.
 */
export async function verifyOnboardingCards(
  cards:          VerifyCard[],
  sourceLanguage: string,
  targetLanguage: string,
  onProgress?:    (checked: number, total: number) => void,
): Promise<VerifyRun> {
  if (cards.length === 0) return { flagged: [], uncheckedCount: 0 }

  const batches = chunk(cards.map((c, i) => ({ ...c, originalIndex: i })), VERIFY_CHUNK)
  let checked = 0

  const results = await mapLimit(batches, VERIFY_CONCURRENCY, async batch => {
    const res = await fetch(apiUrl('/api/cards/verify'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceLanguage,
        targetLanguage,
        cards: batch.map(c => ({ front: c.front, back: c.back })),
      }),
    })
    const data = await res.json()
    if (!data?.ok || !Array.isArray(data.flagged)) throw new Error(data?.reason ?? 'verify-failed')
    // Translate batch-local indices back to the caller's list.
    return (data.flagged as VerifyResult[]).map(f => ({
      ...f,
      index: batch[f.index]?.originalIndex ?? -1,
    })).filter(f => f.index >= 0)
  }, () => {
    // Progress is per BATCH, reported in cards so the bar moves in units the learner recognises.
    checked = Math.min(cards.length, checked + VERIFY_CHUNK)
    onProgress?.(checked, cards.length)
  })

  const flagged: FlaggedCard[] = []
  let uncheckedCount = 0
  results.forEach((r, i) => {
    if (r === null) { uncheckedCount += batches[i]!.length; return }
    flagged.push(...r)
  })
  flagged.sort((a, b) => a.index - b.index)

  onProgress?.(cards.length, cards.length)
  return { flagged, uncheckedCount }
}
