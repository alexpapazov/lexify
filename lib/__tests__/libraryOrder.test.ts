import type { Deck, Folder } from '@/domain'
import { interleaveLibrary, planMixedReorder } from '../libraryOrder'

const folder = (id: string, position: number): Folder => ({ id, name: `F${id}`, position } as unknown as Folder)
const deck = (id: string, position: number): Deck => ({ id, name: `D${id}`, position } as unknown as Deck)

describe('interleaveLibrary', () => {
  it('orders across both types by position', () => {
    const rows = interleaveLibrary([folder('f1', 2)], [deck('d1', 0), deck('d2', 5)])
    expect(rows.map(r => r.id)).toEqual(['d1', 'f1', 'd2'])
  })

  it('keeps folders first on equal positions — the legacy look for never-reordered libraries', () => {
    const rows = interleaveLibrary([folder('f1', 0), folder('f2', 1)], [deck('d1', 0), deck('d2', 1)])
    expect(rows.map(r => r.id)).toEqual(['f1', 'd1', 'f2', 'd2'])
  })
})

describe('planMixedReorder', () => {
  const rows = interleaveLibrary([folder('f1', 0)], [deck('d1', 1), deck('d2', 2)]) // f1, d1, d2

  it('places a deck ABOVE a folder — the bug this exists to fix', () => {
    const plan = planMixedReorder(rows, { type: 'deck', id: 'd1' }, 'f1', 'before')!
    // New order: d1, f1, d2 — shared indices across both tables.
    expect(plan.decks).toEqual([{ id: 'd1', position: 0 }, { id: 'd2', position: 2 }])
    expect(plan.folders).toEqual([{ id: 'f1', position: 1 }])
  })

  it('places a folder after a deck', () => {
    const plan = planMixedReorder(rows, { type: 'folder', id: 'f1' }, 'd2', 'after')!
    expect(plan.folders).toEqual([{ id: 'f1', position: 2 }])
    expect(plan.decks).toEqual([{ id: 'd1', position: 0 }, { id: 'd2', position: 1 }])
  })

  it('returns null for a no-op or an unknown id', () => {
    expect(planMixedReorder(rows, { type: 'deck', id: 'd2' }, 'd1', 'after')).toBeNull()
    expect(planMixedReorder(rows, { type: 'deck', id: 'zz' }, 'f1', 'before')).toBeNull()
    expect(planMixedReorder(rows, { type: 'deck', id: 'd1' }, 'd1', 'before')).toBeNull()
  })

  it('moving down past the target lands after it, not off by one', () => {
    const plan = planMixedReorder(rows, { type: 'folder', id: 'f1' }, 'd1', 'after')!
    // f1 moves below d1: d1, f1, d2
    expect(plan.decks).toEqual([{ id: 'd1', position: 0 }, { id: 'd2', position: 2 }])
    expect(plan.folders).toEqual([{ id: 'f1', position: 1 }])
  })
})
