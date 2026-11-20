/**
 * lib/programPool.ts — assembling the Due page's BATCHES (Due Now Redesign Part 2): one batch
 * per language pair × direction, holding the graduated cards due right now in that direction.
 * Pure — the page feeds it cards/states/track flags.
 *
 * Relearn-loop rows are counted but NOT batched: the relearn gate (Good×2 / Easy to escape)
 * belongs to a normal session, so the batch row links those out instead of weakening them
 * through program stages.
 */

import type { Card, CardState } from '@/domain'
import type { EnabledTracks } from '@/lib/sessionLimits'

export interface ProgramWord { card: Card; state: CardState }

export interface ProgramBatch {
  key:        string            // `${src}|${tgt}|${direction}`
  src:        string
  tgt:        string
  direction:  'production' | 'recognition'
  words:      ProgramWord[]
  /** Due but in the relearn loop — review them in a normal session. */
  relearning: number
}

export function buildProgramBatches(
  cards: Card[],
  forward: Map<string, CardState>,
  reverse: Map<string, CardState>,
  tracksByPair: Map<string, EnabledTracks>,
  now: Date,
): ProgramBatch[] {
  const batches = new Map<string, ProgramBatch>()
  const batch = (src: string, tgt: string, direction: ProgramBatch['direction']): ProgramBatch => {
    const key = `${src}|${tgt}|${direction}`
    let b = batches.get(key)
    if (!b) { b = { key, src, tgt, direction, words: [], relearning: 0 }; batches.set(key, b) }
    return b
  }
  const isDue = (iso: string | null | undefined) => iso != null && new Date(iso).getTime() <= now.getTime()

  for (const card of cards) {
    const tracks = tracksByPair.get(`${card.sourceLanguage}|${card.targetLanguage}`)
    const fwd = forward.get(card.id)

    // Production: the enabled lane's due date (typing lanes, else the self-graded lane).
    if (fwd?.graduated && !fwd.dormant) {
      const typing = tracks?.smart === true || tracks?.typed !== false
      const prodOn = typing || tracks?.recall === true
      const dueIso = typing ? fwd.smartDueAt ?? fwd.typedDueAt ?? fwd.dueAt : fwd.recallDueAt ?? fwd.dueAt
      if (prodOn && isDue(dueIso)) {
        const b = batch(card.sourceLanguage, card.targetLanguage, 'production')
        if (fwd.relearning) b.relearning++
        else b.words.push({ card, state: fwd })
      }
    }

    // Recognition: its own row's schedule; forward must be graduated (same rule as sessions).
    const rev = reverse.get(card.id)
    if (rev?.graduated && !rev.dormant && fwd?.graduated && tracks?.reverse !== false) {
      if (isDue(rev.recallDueAt ?? rev.dueAt)) {
        const b = batch(card.sourceLanguage, card.targetLanguage, 'recognition')
        if (rev.relearning) b.relearning++
        else b.words.push({ card, state: rev })
      }
    }
  }

  return [...batches.values()]
    .filter(b => b.words.length > 0 || b.relearning > 0)
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** Matching chunks of up to `size`, keeping each chunk's tile texts unique so two identical
 *  glosses never sit in one round (the id-matched game would otherwise be a guessing game).
 *  Collided words just land in a later chunk. */
export function matchingChunks(words: ProgramWord[], size = 8): ProgramWord[][] {
  const chunks: ProgramWord[][] = []
  let pending = [...words]
  while (pending.length > 0) {
    const chunk: ProgramWord[] = []
    const fronts = new Set<string>()
    const backs = new Set<string>()
    const rest: ProgramWord[] = []
    for (const w of pending) {
      const f = w.card.front.trim().toLowerCase()
      const b = w.card.back.trim().toLowerCase()
      if (chunk.length < size && !fronts.has(f) && !backs.has(b)) {
        chunk.push(w); fronts.add(f); backs.add(b)
      } else {
        rest.push(w)
      }
    }
    chunks.push(chunk)
    pending = rest
  }
  return chunks
}
