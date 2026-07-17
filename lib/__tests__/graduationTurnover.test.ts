import { snapDueAtToStartOfDay, localDateWithTurnover } from '@/lib/dates'

const DAY = 86_400_000
const plus1Day = (iso: string) => new Date(new Date(iso).getTime() + DAY).toISOString()
// Mirror the session pages' "due today" check, but with a controllable `now`.
const isDue = (dueAt: string, nowIso: string, tz: string, turnover: number) =>
  new Date(dueAt).toLocaleDateString('en-CA', { timeZone: tz }) <= localDateWithTurnover(nowIso, tz, turnover)

describe('graduation due date honors the day-turnover hour', () => {
  it('graduate 2:30am, 1-day interval, turnover 4am → due at 4:05am the SAME day (not before 4am)', () => {
    const dueAt = snapDueAtToStartOfDay(plus1Day('2026-07-17T02:30:00Z'), 'UTC', 4)
    expect(dueAt).toBe('2026-07-17T04:00:00.000Z')                      // start of the current study day
    expect(isDue(dueAt, '2026-07-17T04:05:00Z', 'UTC', 4)).toBe(true)  // 4:05am same day → due
    expect(isDue(dueAt, '2026-07-17T03:55:00Z', 'UTC', 4)).toBe(false) // 3:55am (before turnover) → not yet
  })

  it('graduate 10am (after turnover), 1-day interval → due next calendar day at 4am', () => {
    const dueAt = snapDueAtToStartOfDay(plus1Day('2026-07-17T10:00:00Z'), 'UTC', 4)
    expect(dueAt).toBe('2026-07-18T04:00:00.000Z')
    expect(isDue(dueAt, '2026-07-18T04:05:00Z', 'UTC', 4)).toBe(true)
    expect(isDue(dueAt, '2026-07-17T23:00:00Z', 'UTC', 4)).toBe(false)
  })
})
