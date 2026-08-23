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
  it('files overdue rows under both the language and the type key', () => {
    const pools = build([
      grad('a', { smartDueAt: '2026-08-01T00:00:00.000Z', smartIntervalDays: 5 }),   // overdue → in
      grad('b', { smartDueAt: `${TODAY}T00:00:00.000Z`,   smartIntervalDays: 5 }),   // today → OUT:
      // a card due today is today's legitimate work, and a spread must never push it later.
    ])
    const lang = pools.get(PAIR)!
    expect(lang.overdue.map(c => c.key)).toEqual(['a:forward'])
    expect(pools.get(scopeKey(PAIR, 'typing'))!.overdue.map(c => c.key)).toEqual(['a:forward'])
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

describe('no double assignment, end to end', () => {
  // The full chain the panel runs — pools → spread → write → pools again — twice, with overlapping
  // selections. This is the invariant the unit guards exist to serve, so it gets its own test.
  const opts = { tracks: SMART, tz: TZ, today: TODAY }

  function poolsFor(rows: CardState[]) {
    return build(rows)
  }

  function runSpread(rows: CardState[], candidates: { key: string }[], targetDay: string) {
    // Mirrors the panel: assign days, patch each row, return the new rows.
    const byKey = new Map(rows.map(st => [candidateKey(st), st]))
    const forwards = new Map(rows.filter(r => r.reviewDirection !== 'reverse').map(r => [r.cardId, r]))
    const moved: string[] = []
    const next = rows.map(st => ({ ...st }))
    for (const c of candidates) {
      const st = byKey.get(c.key)
      if (!st) continue
      const patch = rescheduleOverdueTracks(st, targetDay, { ...opts, forwardState: forwards.get(st.cardId) })
      if (patch) {
        moved.push(c.key)
        const i = next.findIndex(n => candidateKey(n) === c.key)
        next[i] = { ...next[i]!, ...patch }
      }
    }
    return { next, moved }
  }

  it('a second overlapping spread moves nothing the first one claimed', () => {
    const rows = [
      grad('a', { smartDueAt: '2026-08-01T04:00:00.000Z', dueAt: '2026-08-01T04:00:00.000Z', smartIntervalDays: 5 }),
      grad('b', { smartDueAt: '2026-08-05T04:00:00.000Z', dueAt: '2026-08-05T04:00:00.000Z', smartIntervalDays: 400 }),
      grad('c', { reviewDirection: 'reverse', recallDueAt: '2026-08-03T04:00:00.000Z', recallIntervalDays: 30 }),
      grad('c'),
    ]
    // First spread: the typing scope only.
    const typingPool = poolsFor(rows).get(scopeKey(PAIR, 'typing'))!
    const first = runSpread(rows, typingPool.overdue, '2026-08-30')
    expect(first.moved).toEqual(['a:forward'])

    // Second spread: the WHOLE language, which overlaps the typing scope.
    const langPool = poolsFor(first.next).get(PAIR)!
    const second = runSpread(first.next, langPool.overdue, '2026-09-10')
    // 'a' is claimed and gone from the backlog; only b and the reverse row move.
    expect(second.moved.sort()).toEqual(['b:forward', 'c:reverse'])
    expect(langPool.overdue.map(c => c.key)).not.toContain('a:forward')

    // Third pass: everything claimed, nothing overdue anywhere, nothing movable.
    const finalPools = poolsFor(second.next)
    expect(finalPools.get(PAIR)).toBeUndefined()
    const third = runSpread(second.next, [
      ...typingPool.overdue, ...langPool.overdue,     // even replaying stale candidate lists
    ], '2026-09-20')
    expect(third.moved).toEqual([])
  })

  it('each due row yields exactly one candidate across all type pools', () => {
    // The panel builds its entry list from the three type pools; a row landing in two would be
    // spread twice in one run.
    const rows = [
      grad('a', { smartDueAt: '2026-08-01T04:00:00.000Z', recallDueAt: '2026-07-20T04:00:00.000Z', smartIntervalDays: 5 }),
      grad('b', { smartDueAt: '2026-08-05T04:00:00.000Z', smartIntervalDays: 400 }),
      grad('c', { reviewDirection: 'reverse', recallDueAt: '2026-08-03T04:00:00.000Z' }),
      grad('c'),
    ]
    const pools = poolsFor(rows)
    const allTypeKeys = (['typing', 'sgForward', 'sgReverse'] as const)
      .flatMap(t => (pools.get(scopeKey(PAIR, t))?.overdue ?? []).map(c => c.key))
    expect(allTypeKeys.length).toBe(new Set(allTypeKeys).size)
    expect(allTypeKeys.sort()).toEqual(['a:forward', 'b:forward', 'c:reverse'])
  })
})

describe('plannedDebt bucket and supersession', () => {
  const opts = { tracks: SMART, tz: TZ, today: TODAY }
  const WINDOW = '2026-09-05'

  /** Pushed by an earlier spread: reviewed long ago, dealt onto an in-window future day. */
  const plannedRow = (id: string, day = '2026-08-30') => grad(id, {
    lastReviewedAt: '2026-02-01T04:00:00.000Z',
    scheduledIntervalDays: 30, intervalDays: 30, smartIntervalDays: 30,
    smartDueAt: `${day}T04:00:00.000Z`, dueAt: `${day}T04:00:00.000Z`,
  })

  /** Sitting exactly where its own schedule put it (gap == interval). */
  const normalRow = (id: string, day: string) => grad(id, {
    lastReviewedAt: '2026-08-01T04:00:00.000Z',
    scheduledIntervalDays: 29, intervalDays: 29, smartIntervalDays: 29,
    smartDueAt: `${day}T04:00:00.000Z`, dueAt: `${day}T04:00:00.000Z`,
  })

  it('buckets today separately, collects future debt, and never a normal future card', () => {
    const pools = build([
      plannedRow('p1', TODAY),            // piled onto today by an earlier spread
      plannedRow('p2', '2026-08-30'),     // placed later in the window by an earlier spread
      normalRow('n1', '2026-08-30'),      // the scheduler's own future date — untouchable
      normalRow('n2', TODAY),             // genuinely due today — deferrable, so claimable
    ])
    const pool = pools.get(PAIR)!
    // Everything due TODAY is deferrable — an overloaded today is what catching up relieves.
    expect(pool.dueToday.map(c => c.key).sort()).toEqual(['n2:forward', 'p1:forward'])
    expect(pool.plannedDebt.map(c => c.key)).toEqual(['p2:forward'])
    expect(pool.overdue).toEqual([])
  })

  it('never collects a mid-relearn row into any bucket', () => {
    // A relearn row's due date is a timer, not a schedule — spreading it would break the gate.
    const pools = build([
      grad('r1', { relearningStep: 1, smartDueAt: '2026-08-01T04:00:00.000Z', dueAt: '2026-08-01T04:00:00.000Z' }),
      grad('r2', { relearning: true, smartDueAt: `${TODAY}T04:00:00.000Z`, dueAt: `${TODAY}T04:00:00.000Z` }),
    ])
    expect(pools.get(PAIR)).toBeUndefined()
  })

  it('a fresh spread defers today outright, supersedes future debt, refuses normal future cards', () => {
    const moved = (st: CardState) =>
      rescheduleOverdueTracks(st, '2026-08-27', { ...opts, replanThrough: WINDOW })
    expect(moved(plannedRow('p1', TODAY))?.smartDueAt).toBe('2026-08-27T04:00:00.000Z')
    expect(moved(plannedRow('p2'))?.smartDueAt).toBe('2026-08-27T04:00:00.000Z')
    // Due today: deferrable even with no provable debt — this IS the overloaded-today relief.
    expect(moved(normalRow('n2', TODAY))?.smartDueAt).toBe('2026-08-27T04:00:00.000Z')
    // The scheduler's own future date: still absolutely untouchable.
    expect(moved(normalRow('n1', '2026-08-30'))).toBeNull()
    // And a relearn row is refused whatever its date says.
    expect(moved(grad('r', { relearningStep: 2, smartDueAt: `${TODAY}T04:00:00.000Z` }))).toBeNull()
  })

  it('without a plan window, today-due cards remain untouchable', () => {
    // The deferral only exists inside an explicit spread; plain claims still stop at overdue.
    expect(rescheduleOverdueTracks(normalRow('n2', TODAY), '2026-08-27', opts)).toBeNull()
  })

  it('supersession still leaves each card exactly one due date', () => {
    // Spread #1 deals overdue cards; spread #2 over the same scope re-deals them. The card follows
    // the LATEST plan — one current date, never two assignments.
    const before = grad('a', {
      lastReviewedAt: '2026-02-01T04:00:00.000Z',
      scheduledIntervalDays: 30, intervalDays: 30, smartIntervalDays: 30,
      smartDueAt: '2026-08-01T04:00:00.000Z', dueAt: '2026-08-01T04:00:00.000Z',
    })
    const p1 = rescheduleOverdueTracks(before, '2026-08-30', opts)!
    const afterFirst = { ...before, ...p1 }
    const p2 = rescheduleOverdueTracks(afterFirst, '2026-08-25', { ...opts, replanThrough: WINDOW })!
    const afterSecond = { ...afterFirst, ...p2 }
    expect(afterSecond.smartDueAt).toBe('2026-08-25T04:00:00.000Z')
    expect(afterSecond.dueAt).toBe('2026-08-25T04:00:00.000Z')
    // And without replanThrough (no new plan), the first claim still cannot be re-dealt.
    expect(rescheduleOverdueTracks(afterFirst, '2026-08-25', opts)).toBeNull()
  })
})
