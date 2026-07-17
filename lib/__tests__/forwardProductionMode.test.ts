import { forwardProductionMode } from '@/lib/sessionLimits'

const base = { acceleratedMode: 'none', acceleratedTypedConfirmed: false, smartIntervalDays: null as number | null, typedIntervalDays: null as number | null, intervalDays: null as number | null }

describe('forwardProductionMode — effective interval on the smart lane', () => {
  it('a legacy/ladder card with only interval_days is typed when that interval is below threshold', () => {
    // The ghost case: smart_due_at/smart_interval_days null, production on due_at/interval_days.
    expect(forwardProductionMode({ ...base, intervalDays: 4.29 }, 'smart', 20)).toBe('typed')
  })
  it('same card is self-graded once its interval passes the threshold', () => {
    expect(forwardProductionMode({ ...base, intervalDays: 25 }, 'smart', 20)).toBe('self-graded')
  })
  it('prefers smart_interval_days, then typed, then interval_days', () => {
    expect(forwardProductionMode({ ...base, smartIntervalDays: 30, intervalDays: 1 }, 'smart', 20)).toBe('self-graded')
    expect(forwardProductionMode({ ...base, typedIntervalDays: 5, intervalDays: 40 }, 'smart', 20)).toBe('typed')
  })
  it('the typed lane always types; accelerated-confirmed self-grades ON THE TYPED LANE', () => {
    expect(forwardProductionMode({ ...base, intervalDays: 40 }, 'typed', 20)).toBe('typed')
    expect(forwardProductionMode({ ...base, acceleratedMode: 'import_known', acceleratedTypedConfirmed: true, intervalDays: 1 }, 'typed', 20)).toBe('self-graded')
  })

  it('a lapse reverts a smart card to typed, even an accelerated-confirmed one, until it re-passes the threshold', () => {
    // Accelerated + confirmed but interval dropped below threshold → typed (revert wins over the shortcut).
    expect(forwardProductionMode({ ...base, acceleratedMode: 'import_known', acceleratedTypedConfirmed: true, smartIntervalDays: 1 }, 'smart', 20)).toBe('typed')
    // Still relearning (interval not dropped yet) → typed.
    expect(forwardProductionMode({ ...base, smartIntervalDays: 30, relearning: true }, 'smart', 20)).toBe('typed')
    // Recovered past the threshold, not relearning → self-graded again.
    expect(forwardProductionMode({ ...base, smartIntervalDays: 30, relearning: false }, 'smart', 20)).toBe('self-graded')
  })
})
