import { isCardStateDueNow, isDueByLocalDate, cardStateDueBucket, daysOverdue } from '../dueStatus'
import { initialCardState } from '../../engine/pipeline'
import type { CardState } from '@/domain'
import type { EnabledTracks } from '../sessionLimits'

const TODAY = '2026-07-20'
const TZ = 'UTC'
const ALL: EnabledTracks = { typed: true, recall: true, reverse: true, smart: false }

function grad(overrides: Partial<CardState> = {}): CardState {
  return { ...initialCardState('u', 'c', 'p'), graduated: true, ...overrides }
}

describe('isDueByLocalDate', () => {
  it('is date-level, not timestamp-level: a due time later TODAY still counts', () => {
    // due_at snapped to today 23:00; "now" earlier today would fail a `<= now` check but this is date-level.
    expect(isDueByLocalDate(`${TODAY}T23:00:00.000Z`, TZ, TODAY)).toBe(true)
  })
  it('a future day does not count', () => {
    expect(isDueByLocalDate('2026-07-25T00:00:00.000Z', TZ, TODAY)).toBe(false)
  })
})

describe('isCardStateDueNow', () => {
  it('reads smart_due_at over a stale due_at (the deck-vs-dashboard divergence)', () => {
    // Real schedule in the future on the smart lane, but a stale past due_at. Must NOT be due.
    const s = grad({ smartDueAt: '2026-07-25T00:00:00.000Z', dueAt: '2026-01-01T00:00:00.000Z' })
    expect(isCardStateDueNow(s, { tracks: { ...ALL, smart: true, typed: false }, tz: TZ, today: TODAY })).toBe(false)
  })

  it('counts a production card due today on the smart lane', () => {
    const s = grad({ smartDueAt: `${TODAY}T23:00:00.000Z`, dueAt: null })
    expect(isCardStateDueNow(s, { tracks: { ...ALL, smart: true, typed: false }, tz: TZ, today: TODAY })).toBe(true)
  })

  it('does NOT count a card whose production track is disabled (ghosted)', () => {
    const s = grad({ typedDueAt: `${TODAY}T00:00:00.000Z`, dueAt: `${TODAY}T00:00:00.000Z` })
    const noProd: EnabledTracks = { typed: false, smart: false, recall: false, reverse: true }
    expect(isCardStateDueNow(s, { tracks: noProd, tz: TZ, today: TODAY })).toBe(false)
  })

  it('legacy card with only due_at counts as production when enabled', () => {
    const s = grad({ smartDueAt: null, typedDueAt: null, dueAt: `${TODAY}T00:00:00.000Z` })
    expect(isCardStateDueNow(s, { tracks: ALL, tz: TZ, today: TODAY })).toBe(true)
  })

  it('recall track due on recall_due_at', () => {
    const s = grad({ smartDueAt: null, typedDueAt: null, dueAt: null, recallDueAt: `${TODAY}T00:00:00.000Z` })
    expect(isCardStateDueNow(s, { tracks: ALL, tz: TZ, today: TODAY })).toBe(true)
  })

  it('reverse row: due on recall_due_at only if the forward counterpart is graduated', () => {
    const rev = grad({ reviewDirection: 'reverse', recallDueAt: `${TODAY}T00:00:00.000Z`, dueAt: '2026-01-01T00:00:00.000Z' })
    expect(isCardStateDueNow(rev, { tracks: ALL, tz: TZ, today: TODAY, forwardState: grad() })).toBe(true)
    expect(isCardStateDueNow(rev, { tracks: ALL, tz: TZ, today: TODAY, forwardState: grad({ graduated: false }) })).toBe(false)
  })

  it('dormancy is per-direction: a dormant FORWARD row does not pause recognition', () => {
    // Deliberate change (migration 105): the forward flag used to be a master switch, which made
    // "Resume recognition" on a dormant card a no-op. Each direction now gates on its own flag.
    const rev = grad({ reviewDirection: 'reverse', recallDueAt: `${TODAY}T00:00:00.000Z`, dueAt: '2026-01-01T00:00:00.000Z' })
    expect(isCardStateDueNow(rev, { tracks: ALL, tz: TZ, today: TODAY, forwardState: grad({ dormant: true }) })).toBe(true)
    // ...and the reverse row's OWN flag still pauses it, whatever production is doing.
    const revDormant = { ...rev, dormant: true }
    expect(isCardStateDueNow(revDormant, { tracks: ALL, tz: TZ, today: TODAY, forwardState: grad() })).toBe(false)
    expect(isCardStateDueNow(revDormant, { tracks: ALL, tz: TZ, today: TODAY, forwardState: grad({ dormant: true }) })).toBe(false)
  })

  it('dormant cards are never due', () => {
    const s = grad({ dormant: true, dueAt: `${TODAY}T00:00:00.000Z` })
    expect(isCardStateDueNow(s, { tracks: ALL, tz: TZ, today: TODAY })).toBe(false)
  })

  it('non-graduated cards are never due', () => {
    expect(isCardStateDueNow(grad({ graduated: false, dueAt: `${TODAY}T00:00:00.000Z` }), { tracks: ALL, tz: TZ, today: TODAY })).toBe(false)
  })
})

describe('cardStateDueBucket', () => {
  const YESTERDAY = '2026-07-19'
  const OLD       = '2026-07-01'

  it('splits the backlog from today\'s arrivals', () => {
    expect(cardStateDueBucket(grad({ dueAt: `${TODAY}T00:00:00.000Z` }), { tracks: ALL, tz: TZ, today: TODAY })).toBe('today')
    expect(cardStateDueBucket(grad({ dueAt: `${OLD}T00:00:00.000Z` }),   { tracks: ALL, tz: TZ, today: TODAY })).toBe('overdue')
    expect(cardStateDueBucket(grad({ dueAt: '2026-08-01T00:00:00.000Z' }), { tracks: ALL, tz: TZ, today: TODAY })).toBeNull()
  })

  it('is null for a card that has not graduated', () => {
    expect(cardStateDueBucket(grad({ graduated: false, dueAt: `${OLD}T00:00:00.000Z` }), { tracks: ALL, tz: TZ, today: TODAY })).toBeNull()
  })

  it('takes the OLDER track when one is overdue and another lands today', () => {
    // The row is served once; how far behind you are is decided by the older debt.
    const s = grad({ typedDueAt: `${OLD}T00:00:00.000Z`, recallDueAt: `${TODAY}T00:00:00.000Z` })
    expect(cardStateDueBucket(s, { tracks: ALL, tz: TZ, today: TODAY })).toBe('overdue')
  })

  it('ignores a disabled track, exactly as the due count does', () => {
    const s = grad({ typedDueAt: `${OLD}T00:00:00.000Z`, dueAt: `${OLD}T00:00:00.000Z` })
    const noProd: EnabledTracks = { typed: false, smart: false, recall: false, reverse: true }
    expect(cardStateDueBucket(s, { tracks: noProd, tz: TZ, today: TODAY })).toBeNull()
  })

  it('agrees with isCardStateDueNow on every row', () => {
    // The two must never drift — that divergence is the reason this module exists.
    const rows = [
      grad({ dueAt: `${TODAY}T00:00:00.000Z` }),
      grad({ dueAt: `${OLD}T00:00:00.000Z` }),
      grad({ dueAt: '2026-08-01T00:00:00.000Z' }),
      grad({ graduated: false, dueAt: `${OLD}T00:00:00.000Z` }),
      grad({ dormant: true, dueAt: `${OLD}T00:00:00.000Z` }),
      grad({ smartDueAt: `${YESTERDAY}T00:00:00.000Z`, dueAt: '2026-01-01T00:00:00.000Z' }),
    ]
    for (const r of rows) {
      const opts = { tracks: { ...ALL, smart: true }, tz: TZ, today: TODAY }
      expect(cardStateDueBucket(r, opts) !== null).toBe(isCardStateDueNow(r, opts))
    }
  })
})

describe('daysOverdue', () => {
  it('is zero on the day a card comes due, and counts calendar days after', () => {
    expect(daysOverdue(grad({ dueAt: `${TODAY}T23:00:00.000Z` }), { tracks: ALL, tz: TZ, today: TODAY })).toBe(0)
    expect(daysOverdue(grad({ dueAt: '2026-07-10T00:00:00.000Z' }), { tracks: ALL, tz: TZ, today: TODAY })).toBe(10)
  })

  it('measures from the EARLIEST due track', () => {
    const s = grad({ typedDueAt: '2026-07-05T00:00:00.000Z', recallDueAt: '2026-07-18T00:00:00.000Z' })
    expect(daysOverdue(s, { tracks: ALL, tz: TZ, today: TODAY })).toBe(15)
  })

  it('is zero for a card that is not due at all', () => {
    expect(daysOverdue(grad({ dueAt: '2026-08-01T00:00:00.000Z' }), { tracks: ALL, tz: TZ, today: TODAY })).toBe(0)
  })
})
