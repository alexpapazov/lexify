import { buildCatchUpPools, catchUpTypeOf, candidateKey } from '@/lib/catchUpPools'
import { initialCardState } from '@/engine/pipeline'
import { scopeKey } from '@/lib/catchUp'
import type { CardState } from '@/domain'
import type { EnabledTracks } from '@/lib/sessionLimits'

const TODAY = '2026-08-22'
const TZ    = 'UTC'
const NOW   = Date.parse(`${TODAY}T12:00:00.000Z`)
const PAIR  = 'bg|en'
const SMART: EnabledTracks = { typed: false, smart: true, recall: true, reverse: true }

function grad(id: string, overrides: Partial<CardState> = {}): CardState {
  return { ...initialCardState('u', id, 'p'), graduated: true, stability: 20, ...overrides }
}

function build(rows: CardState[], tracks: EnabledTracks = SMART) {
  const forwardByCard = new Map(rows.filter(r => r.reviewDirection === 'forward').map(r => [r.cardId, r]))
  return buildCatchUpPools({
    rows: rows.map(state => ({ pairKey: PAIR, state })),
    forwardByCard,
    tracksByPair:    new Map([[PAIR, tracks]]),
    thresholdByPair: new Map([[PAIR, 20]]),
    retentionByPair: new Map([[PAIR, 0.85]]),
    tz: TZ, today: TODAY, now: NOW,
  })
}

describe('buildCatchUpPools', () => {
  it('splits overdue from due-today and files each row under BOTH its language and its type', () => {
    const pools = build([
      grad('a', { smartDueAt: '2026-08-01T00:00:00.000Z', smartIntervalDays: 5 }),   // overdue, typing
      grad('b', { smartDueAt: `${TODAY}T00:00:00.000Z`,   smartIntervalDays: 5 }),   // today,   typing
    ])
    const lang = pools.get(PAIR)!
    expect(lang.overdue.map(c => c.key)).toEqual(['a:forward'])
    expect(lang.dueToday.map(c => c.key)).toEqual(['b:forward'])
    // Same rows, reachable by the type key a type-level plan would use.
    expect(pools.get(scopeKey(PAIR, 'typing'))!.overdue).toHaveLength(1)
    expect(pools.get(scopeKey(PAIR, 'typing'))!.dueToday).toHaveLength(1)
  })

  it('leaves out cards that are not due', () => {
    const pools = build([grad('a', { smartDueAt: '2026-09-30T00:00:00.000Z' })])
    expect(pools.get(PAIR)).toBeUndefined()
  })

  it('separates the three popover buckets', () => {
    const rows = [
      grad('a', { smartDueAt: '2026-08-01T00:00:00.000Z', smartIntervalDays: 5 }),    // below threshold → typing
      grad('b', { smartDueAt: '2026-08-01T00:00:00.000Z', smartIntervalDays: 400 }),  // past threshold  → self-graded
      grad('c'),
      grad('c', { reviewDirection: 'reverse', recallDueAt: '2026-08-01T00:00:00.000Z', recallIntervalDays: 30 }),
    ]
    const pools = build(rows)
    expect(pools.get(scopeKey(PAIR, 'typing'))!.overdue.map(c => c.key)).toEqual(['a:forward'])
    expect(pools.get(scopeKey(PAIR, 'sgForward'))!.overdue.map(c => c.key)).toEqual(['b:forward'])
    expect(pools.get(scopeKey(PAIR, 'sgReverse'))!.overdue.map(c => c.key)).toEqual(['c:reverse'])
  })

  it('gives a forward and a reverse review of the same card distinct keys', () => {
    // They are two separate reviews and both have to be served; collapsing them would undercount.
    const fwd = grad('c', { smartDueAt: '2026-08-01T00:00:00.000Z' })
    const rev = grad('c', { reviewDirection: 'reverse', recallDueAt: '2026-08-01T00:00:00.000Z' })
    expect(candidateKey(fwd)).not.toBe(candidateKey(rev))
    expect(build([fwd, rev]).get(PAIR)!.overdue).toHaveLength(2)
  })

  it('accumulates decay for a long-overdue card', () => {
    // A card 200 days late must rank as forgotten, not as freshly due.
    const pools = build([grad('a', {
      smartDueAt: '2026-02-03T00:00:00.000Z', smartIntervalDays: 10, lastReviewedAt: null,
    })])
    const c = pools.get(PAIR)!.overdue[0]!
    expect(c.elapsedDays).toBeGreaterThan(200)
  })

  it('seeds a stability for a row that has none stored', () => {
    const pools = build([grad('a', {
      stability: null, smartDueAt: '2026-08-01T00:00:00.000Z', smartIntervalDays: 30,
    })])
    expect(pools.get(PAIR)!.overdue[0]!.stability).toBeGreaterThan(0)
  })

  it('ignores a disabled track, matching the due count exactly', () => {
    const noProd: EnabledTracks = { typed: false, smart: false, recall: false, reverse: true }
    const pools = build([grad('a', { smartDueAt: '2026-08-01T00:00:00.000Z', dueAt: '2026-08-01T00:00:00.000Z' })], noProd)
    expect(pools.get(PAIR)).toBeUndefined()
  })

  it('ignores a dormant card', () => {
    const pools = build([grad('a', { dormant: true, smartDueAt: '2026-08-01T00:00:00.000Z' })])
    expect(pools.get(PAIR)).toBeUndefined()
  })
})

describe('catchUpTypeOf', () => {
  const opts = { tracks: SMART, threshold: 20, tz: TZ, today: TODAY }

  it('classifies a reverse row as self-graded recognition without consulting the lane', () => {
    expect(catchUpTypeOf(grad('c', { reviewDirection: 'reverse' }), opts)).toBe('sgReverse')
  })

  it('classifies a recall-only due forward card as self-graded, not typing', () => {
    const s = grad('a', { smartDueAt: '2026-09-30T00:00:00.000Z', recallDueAt: '2026-08-01T00:00:00.000Z' })
    expect(catchUpTypeOf(s, opts)).toBe('sgForward')
  })

  it('classifies by the ACTIVE lane, so a legacy due_at card lands where the session puts it', () => {
    const s = grad('a', { smartDueAt: null, typedDueAt: null, dueAt: '2026-08-01T00:00:00.000Z', intervalDays: 5 })
    expect(catchUpTypeOf(s, opts)).toBe('typing')
  })
})
