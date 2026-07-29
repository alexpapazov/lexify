import { isCardStateDueNow, isDueByLocalDate } from '../dueStatus'
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
