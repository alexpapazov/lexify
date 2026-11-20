import { currentModality, modalityFlagWrites, seedReverseRow } from '../directions'
import { seedKnownStates, type RateDeps } from '../mediaRate'
import { initialCardState } from '../../engine/pipeline'
import type { CardState } from '@/domain'
import type { CardStateRepository } from '../data/interfaces'
import type { EnabledTracks } from '../sessionLimits'

const NOW = new Date('2026-11-20T12:00:00.000Z')

function grad(over: Partial<CardState> = {}): CardState {
  return { ...initialCardState('u1', 'c1', 'p'), graduated: true, graduatedAt: '2026-10-01T00:00:00.000Z',
    difficulty: 6.2, stability: 48, smartIntervalDays: 40, smartDueAt: '2026-12-01T00:00:00.000Z',
    intervalDays: 40, dueAt: '2026-12-01T00:00:00.000Z', reps: 9, lapses: 2, ...over }
}

describe('modality mapping', () => {
  it('derives one modality from the flags (smart wins; selfgraded only without typing lanes)', () => {
    expect(currentModality({ typed: true,  smart: true,  selfgraded: false })).toBe('smart')
    expect(currentModality({ typed: true,  smart: false, selfgraded: true  })).toBe('typed')
    expect(currentModality({ typed: false, smart: false, selfgraded: true  })).toBe('selfgraded')
    expect(currentModality({ typed: false, smart: false, selfgraded: false })).toBe('typed')
  })

  it('compiles a modality to exactly one production flag on', () => {
    const on = (m: 'typed' | 'smart' | 'selfgraded') =>
      modalityFlagWrites(m).filter(w => w.value).map(w => w.column)
    expect(on('smart')).toEqual(['forward_smart_enabled'])
    expect(on('typed')).toEqual(['forward_typed_enabled'])
    expect(on('selfgraded')).toEqual(['forward_recall_enabled'])
  })
})

describe('seedReverseRow — single → multiple conversion', () => {
  it('copies memory state, keeps the interval, spreads the first due within [1, interval]', () => {
    const fwd = grad()
    for (const r of [0, 0.5, 0.999]) {
      const rev = seedReverseRow(fwd, NOW, () => r)
      expect(rev.reviewDirection).toBe('reverse')
      expect(rev.graduated).toBe(true)
      expect(rev.difficulty).toBe(fwd.difficulty)
      expect(rev.stability).toBe(fwd.stability)
      expect(rev.intervalDays).toBe(40)
      expect(rev.recallIntervalDays).toBe(40)
      const offsetDays = (new Date(rev.dueAt!).getTime() - NOW.getTime()) / 86_400_000
      expect(offsetDays).toBeGreaterThanOrEqual(1)
      expect(offsetDays).toBeLessThanOrEqual(40)
      expect(rev.recallDueAt).toBe(rev.dueAt)
      expect(rev.reps).toBe(0)                       // a new schedule: its own review history
    }
  })

  it('carries dormancy and the auto-graduated marker over', () => {
    const rev = seedReverseRow(grad({ dormant: true, acceleratedMode: 'bulk_known' }), NOW, () => 0)
    expect(rev.dormant).toBe(true)
    expect(rev.acceleratedMode).toBe('bulk_known')
  })
})

describe('single-direction pairs never regrow reverse rows', () => {
  const deps = (reverse: boolean): RateDeps => ({
    userId: 'u1', src: 'fr', tgt: 'en', now: NOW,
    tracks: { typed: false, smart: true, recall: false, reverse } as EnabledTracks,
    retMap: new Map(), calMap: new Map(),
    stateRepo: {} as CardStateRepository, pipelineId: 'p', load: new Map<number, number>(),
  })

  it('seedKnownStates emits only the forward row when the reverse track is off', () => {
    expect(seedKnownStates('c1', 'long', undefined, undefined, deps(false))).toHaveLength(1)
    expect(seedKnownStates('c1', 'long', undefined, undefined, deps(true))).toHaveLength(2)
  })
})
