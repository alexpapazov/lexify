/**
 * lib/practiceBank.ts — assembling a practice session. Fresh sentences EVERY time.
 *
 * ── There is deliberately NO sentence cache here ──────────────────────────────
 * This file used to run a reuse bank (`practice_sentences`, migration 113): every generated
 * sentence was filed and replayed in later sessions. The user removed it on purpose, twice over:
 *
 *  1. The bank was MODE-BLIND. It stored full-target-language sentences from normal sessions and
 *     native-cloze sessions reused them verbatim — a "one Greek word only" session served an
 *     all-Greek sentence from an earlier session's cache.
 *  2. Even mode-filtered, replaying the same sentence for the same word defeats the exercise:
 *     the learner starts recognising the SENTENCE, not recalling the word.
 *
 * So every session generates anew. The `practice_sentences` table still exists (data is harmless)
 * but nothing reads or writes it; drop it whenever convenient. Do not reintroduce caching here
 * without the user asking for it.
 *
 * ── The order is decided FIRST, then generated ────────────────────────────────
 * A session's play order is fixed up front as a shuffled, interleaved list of SLOTS (every word
 * appears once, in random order, before any word appears again — no more "both sentences for word
 * A, then both for word B", which let the learner answer the second from short-term memory).
 * Generation then fills the slots in that order: one call per word (all of a word's sentences come
 * from a single call, so they stay varied), the first slot carved off as a single-sentence starter
 * so the learner's wait is ONE sentence. Later slots stream in behind the player in slot order.
 */

import { plannedTotal, planGenerationBatches, type SentencePlan } from '@/engine/practiceBank'
import type { PracticeTarget } from '@/engine/practice'
import { generatePracticeExercises, type PreparedExercise } from '@/lib/practiceGenerate'
import { GENERATE_CAP } from '@/app/api/practice/generate/route'
import { mapLimit } from '@/lib/mapLimit'
import type { ClozeMode } from '@/lib/practiceSchema'

/** Per-word generation calls in flight. */
const JOB_CONCURRENCY = 3

export interface PrepareOptions {
  userId:         string
  targets:        PracticeTarget[]
  sourceLanguage: string
  targetLanguage: string
  plan:           SentencePlan
  /** Native-language sentence with only the blank in the target language. */
  mode?: ClozeMode
}

export interface PreparedSession {
  exercises: PreparedExercise[]
  /** Sentences the plan asked for that never materialised. */
  missingCount: number
}

/** How a progressive session reports back while its later batches are still in flight. */
export interface ProgressCallbacks {
  /**
   * Fires ONCE, with the first playable exercise(s) — the learner starts here; everything else
   * streams in behind them.
   */
  onReady:  (first: PreparedExercise[]) => void
  /** Fires per background batch as it lands, already prepared for the player. */
  onAppend: (more: PreparedExercise[]) => void
}

function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/**
 * The session's play order, fixed before anything is generated: rounds of the target words, each
 * round its own shuffle, so every word appears once before any appears twice. Per-word plans lay
 * down exactly `perWord` full rounds; total plans cycle rounds until `count` slots exist (a partial
 * last round is a random subset — a 3-sentence session over 20 words drills 3 random words).
 * A word is kept off the boundary between rounds when there's more than one word to swap with.
 */
export function buildSlotOrder(targets: PracticeTarget[], plan: SentencePlan): PracticeTarget[] {
  const wanted = plannedTotal(plan, targets.length)
  if (targets.length === 0 || wanted <= 0) return []
  const out: PracticeTarget[] = []
  while (out.length < wanted) {
    const round = shuffled(targets).slice(0, wanted - out.length)
    if (out.length > 0 && round.length > 1 && round[0] === out[out.length - 1]) {
      ;[round[0], round[1]] = [round[1]!, round[0]!]
    }
    out.push(...round)
  }
  return out
}

/** One generation call: a word and the slot positions its sentences will fill. */
interface SlotJob { target: PracticeTarget; slotIdxs: number[] }

/**
 * Groups the slot order into per-word jobs (one call per word keeps its sentences varied — a model
 * asked for two sentences in one call writes two different ones; two separate calls often repeat).
 * The very first slot is carved off as its own single-sentence job so the learner's wait is one
 * sentence, not that word's whole quota. Jobs are ordered by their first slot, so generation runs
 * in roughly the order the learner will meet the results.
 */
export function buildSlotJobs(slots: PracticeTarget[]): SlotJob[] {
  const byCard = new Map<string, SlotJob>()
  slots.forEach((t, i) => {
    const job = byCard.get(t.cardId)
    if (job) job.slotIdxs.push(i)
    else byCard.set(t.cardId, { target: t, slotIdxs: [i] })
  })
  const jobs = [...byCard.values()]   // insertion order = first-slot order
  const first = jobs[0]
  if (first && first.slotIdxs.length > 1) {
    const rest: SlotJob = { target: first.target, slotIdxs: first.slotIdxs.slice(1) }
    first.slotIdxs = [first.slotIdxs[0]!]
    const at = jobs.findIndex(j => j.slotIdxs[0]! > rest.slotIdxs[0]!)
    if (at === -1) jobs.push(rest)
    else jobs.splice(at, 0, rest)
  }
  return jobs
}

/**
 * Builds a session progressively: the order is decided first (see `buildSlotOrder`), then the
 * learner waits only for the FIRST slot's sentence while the rest generate behind the player.
 *
 * Results are released strictly in slot order — a batch that lands out of turn waits for the slots
 * before it. A failed or short call vacates its slots (reported via `missingCount`) so the stream
 * never stalls on them. The returned promise resolves when everything has settled; it rejects only
 * when NOTHING could be prepared — once `onReady` has fired, later failures degrade to a shorter
 * session, never a dead one.
 */
export async function preparePracticeSessionProgressive(
  opts: PrepareOptions,
  cb: ProgressCallbacks,
): Promise<PreparedSession> {
  const { targets, sourceLanguage, targetLanguage, plan } = opts
  const wanted = plannedTotal(plan, targets.length)
  if (targets.length === 0 || wanted <= 0) {
    cb.onReady([])
    return { exercises: [], missingCount: 0 }
  }
  const mode = opts.mode ?? 'target'

  const slots = buildSlotOrder(targets, plan)
  const jobs = buildSlotJobs(slots)

  const filled: (PreparedExercise | null)[] = new Array(slots.length).fill(null)
  const vacated: boolean[] = new Array(slots.length).fill(false)
  // Sentences already used per word, so a word whose quota spans calls (the starter split) can't
  // show the same sentence twice — a repeat vacates the slot instead.
  const usedSentences = new Map<string, Set<string>>()
  let flushedTo = 0
  let ready = false
  let produced = 0
  const errors: unknown[] = []

  /** Releases the contiguous run of decided slots (filled or vacated) past the flush point. */
  const flush = () => {
    const out: PreparedExercise[] = []
    while (flushedTo < slots.length && (filled[flushedTo] !== null || vacated[flushedTo])) {
      const ex = filled[flushedTo]
      if (ex) out.push(ex)
      flushedTo++
    }
    if (out.length === 0) return
    if (ready) cb.onAppend(out)
    else { ready = true; cb.onReady(out) }
  }

  await mapLimit(jobs, JOB_CONCURRENCY, async job => {
    const { target: t, slotIdxs } = job
    const used = usedSentences.get(t.cardId) ?? new Set<string>()
    usedSentences.set(t.cardId, used)
    const got: PreparedExercise[] = []
    try {
      // A word's quota above the route cap (a huge per-word ask) chunks into further calls.
      for (let done = 0; done < slotIdxs.length; done += GENERATE_CAP) {
        const run = await generatePracticeExercises({
          targets: [t], sourceLanguage, targetLanguage,
          count: Math.min(GENERATE_CAP, slotIdxs.length - done), mode,
        })
        got.push(...run.exercises)
      }
    } catch (err) {
      errors.push(err)
    }
    let next = 0
    for (const ex of got) {
      if (next >= slotIdxs.length) break
      const key = ex.exercise.sentence.trim()
      if (used.has(key)) continue
      used.add(key)
      filled[slotIdxs[next++]!] = ex
      produced++
    }
    for (; next < slotIdxs.length; next++) vacated[slotIdxs[next]!] = true
    flush()
  })

  if (!ready) {
    // Nothing at all became playable. Surface the first real failure rather than an empty session.
    if (produced === 0 && errors.length > 0) throw errors[0]
    ready = true
    cb.onReady([])
  }
  return {
    exercises: [],        // streamed via callbacks; kept for the wrapper below
    missingCount: Math.max(0, wanted - produced),
  }
}

/**
 * The all-at-once wrapper: collects the progressive stream and returns everything together. Kept
 * because tests and any non-streaming caller want a single array, and so the progressive core has
 * exactly one implementation.
 */
export async function preparePracticeSession(opts: PrepareOptions): Promise<PreparedSession> {
  const collected: PreparedExercise[] = []
  const session = await preparePracticeSessionProgressive(opts, {
    onReady:  (first) => collected.push(...first),
    onAppend: (more)  => collected.push(...more),
  })
  return { ...session, exercises: collected }
}

/** Re-exported so the page can size its controls against the same cap the planner uses. */
export { GENERATE_CAP, planGenerationBatches }
export type { SentencePlan }
