import { buildCatchUpPools, catchUpTypeOf, candidateKey, rescheduleOverdueTracks } from '@/lib/catchUpPools'
import { cardStateDueBucket } from '@/lib/dueStatus'
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

describe('rescheduleOverdueTracks', () => {
  const NEW  = '2026-09-01'
  const OLD  = '2026-08-01T04:00:00.000Z'
  const opts = { tracks: SMART, tz: TZ, today: TODAY }

  it('moves the smart production lane and keeps due_at in step', () => {
    const patch = rescheduleOverdueTracks(grad('a', { smartDueAt: OLD, dueAt: OLD }), NEW, opts)!
    expect(patch.smartDueAt).toBe('2026-09-01T04:00:00.000Z')
    expect(patch.dueAt).toBe('2026-09-01T04:00:00.000Z')
  })

  it('keeps the time of day, so the turnover offset survives', () => {
    const patch = rescheduleOverdueTracks(
      grad('a', { smartDueAt: '2026-08-01T09:30:00.000Z' }), NEW, opts)!
    expect(patch.smartDueAt).toBe('2026-09-01T09:30:00.000Z')
  })

  it('moves a legacy due_at card that has no lane column', () => {
    const patch = rescheduleOverdueTracks(
      grad('a', { smartDueAt: null, typedDueAt: null, dueAt: OLD }), NEW, opts)!
    expect(patch.dueAt).toBe('2026-09-01T04:00:00.000Z')
    expect(patch.smartDueAt).toBeUndefined()
  })

  it('leaves a FUTURE track alone while moving the overdue one', () => {
    // Rewriting a future due date would change an interval the scheduler chose — out of scope for
    // draining a backlog.
    const future = '2026-09-30T04:00:00.000Z'
    const patch = rescheduleOverdueTracks(grad('a', { smartDueAt: OLD, recallDueAt: future }), NEW, opts)!
    expect(patch.smartDueAt).toBe('2026-09-01T04:00:00.000Z')
    expect(patch.recallDueAt).toBeUndefined()
  })

  it('moves both tracks when both are overdue', () => {
    const patch = rescheduleOverdueTracks(
      grad('a', { smartDueAt: OLD, recallDueAt: '2026-07-20T04:00:00.000Z' }), NEW, opts)!
    expect(patch.smartDueAt).toBe('2026-09-01T04:00:00.000Z')
    expect(patch.recallDueAt).toBe('2026-09-01T04:00:00.000Z')
  })

  it('moves a reverse row on its own recall column', () => {
    const fwd = grad('c')
    const rev = grad('c', { reviewDirection: 'reverse', recallDueAt: OLD })
    const patch = rescheduleOverdueTracks(rev, NEW, { ...opts, forwardState: fwd })!
    expect(patch.recallDueAt).toBe('2026-09-01T04:00:00.000Z')
  })

  it('moves a legacy reverse row scheduled on due_at, filling in the recall column', () => {
    const fwd = grad('c')
    const rev = grad('c', { reviewDirection: 'reverse', recallDueAt: null, dueAt: OLD })
    const patch = rescheduleOverdueTracks(rev, NEW, { ...opts, forwardState: fwd })!
    expect(patch.recallDueAt).toBe('2026-09-01T04:00:00.000Z')
    expect(patch.dueAt).toBe('2026-09-01T04:00:00.000Z')
  })

  it('returns null for a card due today rather than pushing it later', () => {
    expect(rescheduleOverdueTracks(grad('a', { smartDueAt: `${TODAY}T04:00:00.000Z` }), NEW, opts)).toBeNull()
  })

  it('returns null for a dormant card and for a disabled track', () => {
    expect(rescheduleOverdueTracks(grad('a', { dormant: true, smartDueAt: OLD }), NEW, opts)).toBeNull()
    const noProd: EnabledTracks = { typed: false, smart: false, recall: false, reverse: true }
    expect(rescheduleOverdueTracks(grad('a', { smartDueAt: OLD }), NEW, { ...opts, tracks: noProd })).toBeNull()
  })

  it('returns null for a reverse row whose forward side has not graduated', () => {
    const fwd = grad('c', { graduated: false })
    const rev = grad('c', { reviewDirection: 'reverse', recallDueAt: OLD })
    expect(rescheduleOverdueTracks(rev, NEW, { ...opts, forwardState: fwd })).toBeNull()
  })
})

describe('one plan per card', () => {
  const opts = { tracks: SMART, tz: TZ, today: TODAY }

  it('is idempotent: a card already moved by an earlier plan is refused by the next', () => {
    // The guard that makes "only one catch-up per card" hold. After the first spread the card is no
    // longer overdue, so any later plan whose selection overlaps must leave it exactly where it is.
    const before = grad('a', { smartDueAt: '2026-08-01T04:00:00.000Z', dueAt: '2026-08-01T04:00:00.000Z' })
    const first  = rescheduleOverdueTracks(before, '2026-09-01', opts)!
    const after  = { ...before, ...first }

    expect(rescheduleOverdueTracks(after, '2026-09-20', opts)).toBeNull()
    expect(rescheduleOverdueTracks(after, '2026-08-25', opts)).toBeNull()
  })

  it('refuses a card an earlier plan placed on TODAY', () => {
    // Landing on today is a legitimate assignment; it must not be re-dealt by the next plan either.
    const onToday = grad('a', { smartDueAt: `${TODAY}T04:00:00.000Z`, dueAt: `${TODAY}T04:00:00.000Z` })
    expect(rescheduleOverdueTracks(onToday, '2026-09-10', opts)).toBeNull()
  })

  it('clears the whole row, so a part-moved card cannot linger in the backlog', () => {
    // A forward row can have production AND recall overdue. Both move together — leaving one behind
    // would keep the row reading as overdue forever, so it could never be cleared by any plan.
    const s = grad('a', {
      smartDueAt: '2026-08-01T04:00:00.000Z',
      recallDueAt: '2026-07-15T04:00:00.000Z',
      dueAt: '2026-08-01T04:00:00.000Z',
    })
    const moved = { ...s, ...rescheduleOverdueTracks(s, '2026-09-01', opts)! }
    expect(cardStateDueBucket(moved, opts)).toBeNull()
    expect(rescheduleOverdueTracks(moved, '2026-09-05', opts)).toBeNull()
  })
})

describe('reassign mode (replanThrough)', () => {
  const opts = { tracks: SMART, tz: TZ, today: TODAY }
  const WINDOW = '2026-09-05'

  /** A card an earlier plan pushed: last reviewed long ago, dealt onto a future day. */
  const planned = () => grad('a', {
    lastReviewedAt: '2026-02-01T04:00:00.000Z',
    scheduledIntervalDays: 30, intervalDays: 30,
    smartDueAt: '2026-08-30T04:00:00.000Z', dueAt: '2026-08-30T04:00:00.000Z',
  })

  /** A card sitting exactly where its own FSRS schedule put it, which happens to be in the window. */
  const normal = () => grad('b', {
    lastReviewedAt: '2026-08-01T04:00:00.000Z',
    scheduledIntervalDays: 30, intervalDays: 30,
    smartDueAt: '2026-08-31T04:00:00.000Z', dueAt: '2026-08-31T04:00:00.000Z',
  })

  it('re-deals a card an earlier plan placed in the window', () => {
    const patch = rescheduleOverdueTracks(planned(), '2026-08-25', { ...opts, replanThrough: WINDOW })
    expect(patch?.smartDueAt).toBe('2026-08-25T04:00:00.000Z')
  })

  it('leaves an unplanned card alone even though it falls inside the window', () => {
    // The guarantee the user asked for: reassign must not disturb normally-scheduled reviews.
    expect(rescheduleOverdueTracks(normal(), '2026-08-25', { ...opts, replanThrough: WINDOW })).toBeNull()
  })

  it('leaves a planned card scheduled BEYOND the window alone', () => {
    const far = { ...planned(), smartDueAt: '2026-10-10T04:00:00.000Z', dueAt: '2026-10-10T04:00:00.000Z' }
    expect(rescheduleOverdueTracks(far, '2026-08-25', { ...opts, replanThrough: WINDOW })).toBeNull()
  })

  it('without replanThrough, a planned future card is untouchable', () => {
    // Plain catch-up must never re-deal what another plan already claimed.
    expect(rescheduleOverdueTracks(planned(), '2026-08-25', opts)).toBeNull()
  })

  it('still claims overdue cards in reassign mode', () => {
    const late = grad('c', {
      lastReviewedAt: '2026-02-01T04:00:00.000Z',
      smartDueAt: '2026-08-01T04:00:00.000Z', dueAt: '2026-08-01T04:00:00.000Z',
    })
    expect(rescheduleOverdueTracks(late, '2026-08-25', { ...opts, replanThrough: WINDOW })?.smartDueAt)
      .toBe('2026-08-25T04:00:00.000Z')
  })
})
