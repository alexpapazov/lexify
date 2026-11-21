/**
 * lib/programPool.ts — assembling the Due page's BATCHES (Due Now Redesign Part 2): one batch
 * per language pair × direction, holding the graduated cards due right now in that direction.
 * Pure — the page feeds it cards/states/track flags.
 *
 * Relearn-loop rows ride ALONG in the batch (flagged `relearn`): the runner serves them as
 * REAL relearn reviews woven into the same session — the gate (Good×2 / Easy to escape) runs
 * intact, they just never leave the session (user decision 2026-11-20). They are excluded
 * from program stages and credits.
 */

import type { Card, CardState } from '@/domain'
import type { EnabledTracks } from '@/lib/sessionLimits'

export interface ProgramWord {
  card: Card
  state: CardState
  /** In the relearn loop: served inside the SAME session as real relearn reviews (written /
   *  recall), never through program stages, never a separate mode (user decision 2026-11-20). */
  relearn?: boolean
}

export interface ProgramBatch {
  key:        string            // `${src}|${tgt}|${direction}`
  src:        string
  tgt:        string
  direction:  'production' | 'recognition'
  words:      ProgramWord[]
  /** How many of `words` are relearn-loop rows (display only). */
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
        if (fwd.relearning) { b.relearning++; b.words.push({ card, state: fwd, relearn: true }) }
        else b.words.push({ card, state: fwd })
      }
    }

    // Recognition: its own row's schedule; forward must be graduated (same rule as sessions).
    const rev = reverse.get(card.id)
    if (rev?.graduated && !rev.dormant && fwd?.graduated && tracks?.reverse !== false) {
      if (isDue(rev.recallDueAt ?? rev.dueAt)) {
        const b = batch(card.sourceLanguage, card.targetLanguage, 'recognition')
        if (rev.relearning) { b.relearning++; b.words.push({ card, state: rev, relearn: true }) }
        else b.words.push({ card, state: rev })
      }
    }
  }

  return [...batches.values()]
    .filter(b => b.words.length > 0 || b.relearning > 0)
    .sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * The NEXT matching round: fresh words first, with the stage's earlier misses SPRINKLED in —
 * an even share per remaining round (user decision 2026-11-20: a missed pair redistributes
 * across the upcoming rounds, never clumped into one immediate redo) — unless misses are all
 * that's left, in which case they simply are the round. Tile texts stay unique per round so
 * two identical glosses never make the id-matched game a guessing game; a collided word just
 * waits for a later round.
 */
export function nextMatchingChunk(fresh: ProgramWord[], retry: ProgramWord[], size = 8): ProgramWord[] {
  const total = fresh.length + retry.length
  if (total === 0) return []
  const roundsLeft = Math.max(1, Math.ceil(total / size))
  const retryShare = Math.min(retry.length, Math.ceil(retry.length / roundsLeft))
  const pick: ProgramWord[] = []
  const ids = new Set<string>()
  const fronts = new Set<string>()
  const backs = new Set<string>()
  const tryAdd = (w: ProgramWord): void => {
    const f = w.card.front.trim().toLowerCase()
    const b = w.card.back.trim().toLowerCase()
    if (ids.has(w.card.id) || fronts.has(f) || backs.has(b)) return
    pick.push(w); ids.add(w.card.id); fronts.add(f); backs.add(b)
  }
  for (const w of fresh) { if (pick.length >= size - retryShare) break; tryAdd(w) }
  for (const w of retry) { if (pick.length >= size) break; tryAdd(w) }
  // Top up from whatever's left (few fresh words, or text collisions blocked some slots).
  for (const w of [...fresh, ...retry]) { if (pick.length >= size) break; tryAdd(w) }
  return pick
}
