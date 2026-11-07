import { creditCardSighting, type SightingContext } from '../implicitCredit'
import { initialCardState } from '../../engine/pipeline'
import type { Card, CardState } from '@/domain'
import type { CardStateRepository } from '../data/interfaces'
import type { EnabledTracks } from '../sessionLimits'

const NOW = new Date('2026-11-06T12:00:00.000Z')
const iso = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * 86_400_000).toISOString()

const card: Card = {
  id: 'c1', ownerId: 'u1', sourceLanguage: 'fr', targetLanguage: 'en',
  front: 'le sentier', back: 'path', hints: [], choices: null, position: 0,
  createdAt: '', updatedAt: '', deletedAt: null, pos: 'noun', lemma: 'sentier',
}

const ALL: EnabledTracks = { typed: false, smart: true, recall: false, reverse: true }

function fakeRepo() {
  const upserts: CardState[] = []
  const repo = {
    upsert: async (s: CardState) => { upserts.push(s); return s },
    countDueByDateRange: async () => new Map<string, number>(),
  } as unknown as CardStateRepository
  return { repo, upserts }
}

function ctx(repo: CardStateRepository, tracks: EnabledTracks = ALL): SightingContext {
  return {
    userId: 'u1', now: NOW, tz: 'UTC', turnoverHour: 0,
    retMap: new Map(), calMap: new Map(), tracks, stateRepo: repo,
  }
}

/** A long-term forward row on the smart lane: 90d interval, due in 30, last reviewed 60d ago. */
function longTermForward(overrides: Partial<CardState> = {}): CardState {
  return {
    ...initialCardState('u1', 'c1', 'p'),
    graduated: true, difficulty: 5, stability: 90,
    smartIntervalDays: 90, smartDueAt: iso(30),
    intervalDays: 90, dueAt: iso(30),
    lastReviewedAt: iso(-60), lastRating: 'good', reps: 7,
    ...overrides,
  }
}

function longTermReverse(overrides: Partial<CardState> = {}): CardState {
  return {
    ...initialCardState('u1', 'c1', 'p'),
    graduated: true, reviewDirection: 'reverse', difficulty: 5, stability: 90,
    recallIntervalDays: 90, recallDueAt: iso(30), dueAt: iso(30), intervalDays: 90,
    lastReviewedAt: iso(-60), reps: 4,
    ...overrides,
  }
}

describe('creditCardSighting', () => {
  it('credits a long-term production lane: interval grows, due date moves out, cap stamp set', async () => {
    const { repo, upserts } = fakeRepo()
    const forward = longTermForward()
    const out = await creditCardSighting({ card, forward, reverse: null }, ctx(repo))

    expect(out?.forward?.lanes).toEqual(['production'])
    const s = out!.forward!.state
    expect(s.smartIntervalDays!).toBeGreaterThanOrEqual(90)         // never shortens
    expect(new Date(s.smartDueAt!).getTime()).toBeGreaterThan(new Date(forward.smartDueAt!).getTime())
    expect(s.dueAt).toBe(s.smartDueAt)                              // smart lane syncs dueAt
    expect(s.lastImplicitAt).toBe(NOW.toISOString())
    expect(s.lastReviewedAt).toBe(NOW.toISOString())                // elapsed time was consumed
    expect(s.reps).toBe(7)                                          // NOT a review: reps untouched
    expect(s.lastRating).toBe('good')                               // rating untouched
    expect(upserts).toHaveLength(1)
  })

  it('a short-term lane earns nothing', async () => {
    const { repo, upserts } = fakeRepo()
    const forward = longTermForward({ smartIntervalDays: 20, intervalDays: 20 })
    expect(await creditCardSighting({ card, forward, reverse: null }, ctx(repo))).toBeNull()
    expect(upserts).toHaveLength(0)
  })

  it('an overdue card stays due — no credit', async () => {
    const { repo } = fakeRepo()
    const forward = longTermForward({ smartDueAt: iso(-2), dueAt: iso(-2) })
    expect(await creditCardSighting({ card, forward, reverse: null }, ctx(repo))).toBeNull()
  })

  it('the daily cap blocks a second sighting, a next-day sighting passes', async () => {
    const { repo } = fakeRepo()
    const sameDay = longTermForward({ lastImplicitAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() })
    expect(await creditCardSighting({ card, forward: sameDay, reverse: null }, ctx(repo))).toBeNull()

    const nextDay = longTermForward({ lastImplicitAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() })
    expect(await creditCardSighting({ card, forward: nextDay, reverse: null }, ctx(repo))).not.toBeNull()
  })

  it('credits the reverse row only when the forward counterpart is graduated', async () => {
    const { repo, upserts } = fakeRepo()
    const reverse = longTermReverse()
    const out = await creditCardSighting(
      { card, forward: longTermForward({ smartIntervalDays: 8, intervalDays: 8 }), reverse }, ctx(repo))
    expect(out?.reverse).toBeDefined()                              // reverse credited on its own maturity
    expect(out?.forward).toBeUndefined()                            // short-term production untouched
    expect(out!.reverse!.recallIntervalDays!).toBeGreaterThanOrEqual(90)
    expect(out!.reverse!.dueAt).toBe(out!.reverse!.recallDueAt)     // reverse mirrors dueAt
    expect(upserts).toHaveLength(1)

    const { repo: repo2 } = fakeRepo()
    const ungraduated = await creditCardSighting(
      { card, forward: longTermForward({ graduated: false }), reverse: longTermReverse() }, ctx(repo2))
    expect(ungraduated).toBeNull()
  })

  it('a disabled track is never credited (ghosted schedules stay ghosted)', async () => {
    const { repo } = fakeRepo()
    const none: EnabledTracks = { typed: false, smart: false, recall: false, reverse: false }
    expect(await creditCardSighting({ card, forward: longTermForward(), reverse: longTermReverse() }, ctx(repo, none))).toBeNull()
  })

  it('dormant and relearning rows are untouchable', async () => {
    const { repo } = fakeRepo()
    expect(await creditCardSighting({ card, forward: longTermForward({ dormant: true }), reverse: null }, ctx(repo))).toBeNull()
    expect(await creditCardSighting({ card, forward: longTermForward({ relearning: true }), reverse: null }, ctx(repo))).toBeNull()
  })
})
