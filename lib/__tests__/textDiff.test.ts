import { diffWords, diffStats } from '@/lib/textDiff'

describe('diffWords', () => {
  it('identical texts are one same-run', () => {
    expect(diffWords('el perro duerme', 'el perro duerme')).toEqual([
      { type: 'same', text: 'el perro duerme' },
    ])
  })

  it('marks additions, removals, and changes (removal before addition)', () => {
    expect(diffWords('yo como pan', 'yo como pan fresco')).toEqual([
      { type: 'same', text: 'yo como pan' },
      { type: 'added', text: 'fresco' },
    ])
    expect(diffWords('yo como pan fresco', 'yo como pan')).toEqual([
      { type: 'same', text: 'yo como pan' },
      { type: 'removed', text: 'fresco' },
    ])
    expect(diffWords('el gato duerme', 'el perro duerme')).toEqual([
      { type: 'same', text: 'el' },
      { type: 'removed', text: 'gato' },
      { type: 'added', text: 'perro' },
      { type: 'same', text: 'duerme' },
    ])
  })

  it('whitespace runs and newlines do not create phantom changes', () => {
    expect(diffWords('yo  como\npan', 'yo como pan')).toEqual([
      { type: 'same', text: 'yo como pan' },
    ])
  })

  it('handles empty sides', () => {
    expect(diffWords('', '')).toEqual([])
    expect(diffWords('', 'hola')).toEqual([{ type: 'added', text: 'hola' }])
    expect(diffWords('hola', '')).toEqual([{ type: 'removed', text: 'hola' }])
  })

  it('returns null above the size cap instead of freezing the UI', () => {
    const big = Array.from({ length: 2500 }, (_, i) => `w${i}`).join(' ')
    expect(diffWords(big, `${big} extra`)).toBeNull()
  })
})

describe('diffStats', () => {
  it('counts added and removed words', () => {
    const segs = diffWords('el gato duerme mucho', 'el perro duerme')!
    expect(diffStats(segs)).toEqual({ added: 1, removed: 2 })
  })
})
