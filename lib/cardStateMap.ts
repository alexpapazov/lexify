import type { CardState } from '@/domain'

/**
 * Builds a cardId → forward CardState lookup that is robust to DUPLICATE forward
 * rows (a data anomaly some accounts have). A plain
 * `new Map(forwardStates.map(s => [s.cardId, s]))` keeps whichever row comes
 * last, so if one forward row is dormant/graduated and a stale duplicate isn't,
 * the map can resolve to the wrong row — letting a dormant card leak into Due Now.
 *
 * On a cardId collision we prefer the row that makes dormancy/graduation
 * card-level: a dormant row wins over any non-dormant row, then a graduated row
 * wins over an ungraduated one. For the common single-row case this is identical
 * to the plain Map.
 */
export function forwardStateMap(forwardStates: CardState[]): Map<string, CardState> {
  const m = new Map<string, CardState>()
  for (const s of forwardStates) {
    const cur = m.get(s.cardId)
    if (!cur) { m.set(s.cardId, s); continue }
    if (cur.dormant) continue                             // already dormant — keep it
    if (s.dormant) { m.set(s.cardId, s); continue }       // prefer a dormant row
    if (s.graduated && !cur.graduated) m.set(s.cardId, s) // else prefer a graduated row
  }
  return m
}
