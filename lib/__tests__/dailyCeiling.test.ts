import { shareDayAcrossLanguages, applyDailyCeiling } from '../dailyCeiling'

const days = (...d: string[]) => d
const planOf = (entries: [string, number][]) => new Map(entries)

describe('shareDayAcrossLanguages', () => {
  it('gives everyone what they asked for when the day fits', () => {
    const share = shareDayAcrossLanguages(20, [{ key: 'es', words: 8 }, { key: 'ko', words: 5 }])
    expect(share.get('es')).toBe(8)
    expect(share.get('ko')).toBe(5)
  })

  it('is a no-op without a ceiling', () => {
    const share = shareDayAcrossLanguages(null, [{ key: 'es', words: 40 }])
    expect(share.get('es')).toBe(40)
  })

  it('never trims a small demand to make room for a large one', () => {
    // 10 to share; Korean only wants 2, so it keeps all 2 and Spanish takes the other 8.
    const share = shareDayAcrossLanguages(10, [{ key: 'es', words: 30 }, { key: 'ko', words: 2 }])
    expect(share.get('ko')).toBe(2)
    expect(share.get('es')).toBe(8)
  })

  it('splits evenly between languages that both want more than their share', () => {
    const share = shareDayAcrossLanguages(10, [{ key: 'es', words: 20 }, { key: 'ko', words: 20 }])
    expect(share.get('es')).toBe(5)
    expect(share.get('ko')).toBe(5)
  })

  it('never hands out more than the ceiling', () => {
    const share = shareDayAcrossLanguages(7, [{ key: 'a', words: 5 }, { key: 'b', words: 5 }, { key: 'c', words: 5 }])
    expect([...share.values()].reduce((a, b) => a + b, 0)).toBe(7)
  })
})

describe('applyDailyCeiling', () => {
  it('leaves an under-subscribed plan untouched', () => {
    const res = applyDailyCeiling({
      dates: days('2026-09-01', '2026-09-02'),
      demand: new Map([['es', planOf([['2026-09-01', 5], ['2026-09-02', 5]])]]),
      ceiling: 10,
    })
    expect(res.fits).toBe(true)
    expect(res.planned.get('es')!.get('2026-09-01')).toBe(5)
    expect(res.overflow.size).toBe(0)
  })

  it('moves what does not fit onto the next day', () => {
    const res = applyDailyCeiling({
      dates: days('2026-09-01', '2026-09-02'),
      demand: new Map([['es', planOf([['2026-09-01', 15], ['2026-09-02', 0]])]]),
      ceiling: 10,
    })
    expect(res.planned.get('es')!.get('2026-09-01')).toBe(10)
    expect(res.planned.get('es')!.get('2026-09-02')).toBe(5)   // the 5 that didn't fit
    expect(res.deferredDays).toEqual(['2026-09-01'])
    expect(res.overflow.size).toBe(0)
  })

  it('cascades across several days rather than dumping it all on tomorrow', () => {
    const res = applyDailyCeiling({
      dates: days('2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'),
      demand: new Map([['es', planOf([['2026-09-01', 25]])]]),
      ceiling: 10,
    })
    expect(res.planned.get('es')!.get('2026-09-01')).toBe(10)
    expect(res.planned.get('es')!.get('2026-09-02')).toBe(10)
    expect(res.planned.get('es')!.get('2026-09-03')).toBe(5)
    expect(res.planned.get('es')!.get('2026-09-04')).toBeUndefined()
  })

  it('reports what still has not fit when the horizon runs out', () => {
    const res = applyDailyCeiling({
      dates: days('2026-09-01', '2026-09-02'),
      demand: new Map([['es', planOf([['2026-09-01', 100]])]]),
      ceiling: 10,
    })
    expect(res.overflow.get('es')).toBe(80)   // 100 - 10 - 10
    expect(res.fits).toBe(false)
  })

  it('conserves every word — planned + overflow always equals what was asked for', () => {
    const demand = new Map([
      ['es', planOf([['2026-09-01', 18], ['2026-09-02', 4], ['2026-09-03', 9]])],
      ['ko', planOf([['2026-09-01', 7], ['2026-09-02', 7], ['2026-09-03', 7]])],
    ])
    const asked = [...demand.values()].reduce(
      (sum, m) => sum + [...m.values()].reduce((a, b) => a + b, 0), 0)

    const res = applyDailyCeiling({ dates: days('2026-09-01', '2026-09-02', '2026-09-03'), demand, ceiling: 12 })

    const got = [...res.planned.values()].reduce(
      (sum, m) => sum + [...m.values()].reduce((a, b) => a + b, 0), 0)
    const left = [...res.overflow.values()].reduce((a, b) => a + b, 0)
    expect(got + left).toBe(asked)   // nothing invented, nothing lost
  })

  it('never lets a capped day exceed the ceiling', () => {
    const res = applyDailyCeiling({
      dates: days('2026-09-01', '2026-09-02', '2026-09-03'),
      demand: new Map([
        ['es', planOf([['2026-09-01', 30], ['2026-09-02', 30]])],
        ['ko', planOf([['2026-09-01', 30], ['2026-09-02', 30]])],
      ]),
      ceiling: 12,
    })
    for (const date of days('2026-09-01', '2026-09-02', '2026-09-03')) {
      const total = [...res.planned.values()].reduce((sum, m) => sum + (m.get(date) ?? 0), 0)
      expect(total).toBeLessThanOrEqual(12)
    }
  })

  it('shares a crowded day between languages instead of starving one', () => {
    const res = applyDailyCeiling({
      dates: days('2026-09-01', '2026-09-02'),
      demand: new Map([
        ['es', planOf([['2026-09-01', 10]])],
        ['ko', planOf([['2026-09-01', 10]])],
      ]),
      ceiling: 10,
    })
    expect(res.planned.get('es')!.get('2026-09-01')).toBe(5)
    expect(res.planned.get('ko')!.get('2026-09-01')).toBe(5)
    // Each carries its unmet 5 into the next day, where they fit.
    expect(res.planned.get('es')!.get('2026-09-02')).toBe(5)
    expect(res.planned.get('ko')!.get('2026-09-02')).toBe(5)
  })

  it('does nothing at all without a ceiling', () => {
    const res = applyDailyCeiling({
      dates: days('2026-09-01'),
      demand: new Map([['es', planOf([['2026-09-01', 999]])]]),
      ceiling: null,
    })
    expect(res.planned.get('es')!.get('2026-09-01')).toBe(999)
    expect(res.fits).toBe(true)
  })
})
