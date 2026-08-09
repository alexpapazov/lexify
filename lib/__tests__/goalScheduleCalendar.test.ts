/**
 * Date-grid maths for the schedule calendar. Hand-rolled calendars break at month lengths, leap
 * years and the year boundary, and none of those are visible in a screenshot of the current month.
 */
import { monthsBetween, monthGrid } from '@/components/settings/GoalScheduleCalendar'

describe('monthsBetween', () => {
  it('covers the months a schedule touches, inclusive at both ends', () => {
    expect(monthsBetween('2026-09-15', '2026-11-02')).toEqual(['2026-09', '2026-10', '2026-11'])
    expect(monthsBetween('2026-09-01', '2026-09-30')).toEqual(['2026-09'])
  })

  it('rolls over the year boundary', () => {
    expect(monthsBetween('2026-11-20', '2027-02-03')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
  })

  it('is bounded, so a mistyped year renders a page rather than freezing it', () => {
    expect(monthsBetween('2026-01-01', '2999-01-01')).toHaveLength(60)
  })

  it('is empty when the deadline precedes the start', () => {
    expect(monthsBetween('2026-09-01', '2026-08-01')).toEqual([])
  })
})

describe('monthGrid', () => {
  it('pads to whole Monday-start weeks', () => {
    // 2026-09-01 is a Tuesday, so one leading blank; 30 days + 1 lead = 31 -> padded to 35.
    const grid = monthGrid('2026-09')
    expect(grid).toHaveLength(35)
    expect(grid[0]).toBeNull()
    expect(grid[1]).toBe('2026-09-01')
    expect(grid[30]).toBe('2026-09-30')
    expect(grid[31]).toBeNull()
    expect(grid.length % 7).toBe(0)
  })

  it('gets month lengths right, including the year boundary', () => {
    const days = (ym: string) => monthGrid(ym).filter(Boolean).length
    expect(days('2026-01')).toBe(31)
    expect(days('2026-04')).toBe(30)
    expect(days('2026-12')).toBe(31)
    expect(monthGrid('2026-12').filter(Boolean).at(-1)).toBe('2026-12-31')
  })

  it('handles February in common and leap years', () => {
    expect(monthGrid('2026-02').filter(Boolean)).toHaveLength(28)
    expect(monthGrid('2028-02').filter(Boolean)).toHaveLength(29)
    expect(monthGrid('2028-02').filter(Boolean).at(-1)).toBe('2028-02-29')
  })

  it('puts a Monday first with no leading blanks', () => {
    // 2026-06-01 is a Monday.
    expect(monthGrid('2026-06')[0]).toBe('2026-06-01')
  })

  it('emits zero-padded ISO dates that sort lexically', () => {
    const days = monthGrid('2026-09').filter(Boolean) as string[]
    expect(days[0]).toBe('2026-09-01')
    expect([...days].sort()).toEqual(days)
  })
})
