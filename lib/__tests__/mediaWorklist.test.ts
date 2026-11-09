import { buildWorklist, normKey } from '../mediaWorklist'
import { applyRecognitionPenalty, seedKnownStates } from '../mediaRate'
import { initialCardState } from '../../engine/pipeline'
import type { Card, CardState, MediaPage } from '@/domain'
import type { CardStateRepository } from '../data/interfaces'
import type { EnabledTracks } from '../sessionLimits'

const NOW = new Date('2026-11-08T12:00:00.000Z')
const iso = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()

function card(id: string, front: string, back: string, over: Partial<Card> = {}): Card {
  return {
    id, ownerId: 'u1', sourceLanguage: 'fr', targetLanguage: 'en',
    front, back, hints: [], choices: null, position: 0,
    createdAt: '', updatedAt: '', deletedAt: null, pos: 'noun',
    lemma: front.replace(/^(le|la|l')\s*/i, ''), ...over,
  }
}

function page(idx: number, pageNumber: number | null, result: Record<string, unknown> | null, status: MediaPage['status'] = 'done'): MediaPage {
  return { id: `pg${idx}`, userId: 'u1', entryId: 'e1', pageIndex: idx, pageNumber, status, covered: false, result, error: null }
}

const occ = (text: string, lemma: string, over: Record<string, unknown> = {}) =>
  ({ text, lemma, kind: 'word', gloss: 'g', sentence: `Une phrase avec ${text}.`, marker: 'underlined', ...over })

function grad(cardId: string, over: Partial<CardState> = {}): CardState {
  return { ...initialCardState('u1', cardId, 'p'), graduated: true, difficulty: 5, stability: 90,
    smartIntervalDays: 90, smartDueAt: iso(30), intervalDays: 90, dueAt: iso(30), lastReviewedAt: iso(-45), reps: 6, ...over }
}

describe('normKey — OCR variance folding', () => {
  it('curly apostrophes, ligatures, case, and whitespace all collapse to one key', () => {
    expect(normKey('s’absenter')).toBe(normKey("s'absenter"))
    expect(normKey('Œil')).toBe(normKey('oeil'))
    expect(normKey('  Le   Temps ')).toBe('le temps')
  })
})

describe('buildWorklist — classification', () => {
  const cards = [
    card('known-long', 'le sentier', 'path'),                     // graduated long-term
    card('known-short', 'la berge', 'bank'),                      // graduated short-term
    card('never', 'la mousse', 'moss'),                           // in library, never studied
    card('failed', 'le fourré', 'thicket'),                       // graduated — will be MARKED
  ]
  const forward = new Map<string, CardState>([
    ['known-long', grad('known-long')],
    ['known-short', grad('known-short', { smartIntervalDays: 10, intervalDays: 10 })],
    ['failed', grad('failed')],
  ])

  const pages = [
    page(0, 42, {
      occurrences: [occ('fourré', 'fourré'), occ('inconnu', 'inconnu', { display: "l'inconnu" })],
      allLemmas: ['sentier', 'berge', 'mousse', 'nouveau', 'inconnu'],
      pageLanguage: 'fr',
    }),
    page(1, 43, {
      occurrences: [occ('inconnus', 'inconnu')],                  // re-marked on the next page
      allLemmas: ['sentier', 'nouveau', 'autre'],
      pageLanguage: 'fr',
    }),
  ]

  const wl = buildWorklist(pages, {}, cards, forward, 'fr', 'en')
  const byKey = new Map(wl.pages.flatMap(p => p.items).map(i => [i.key, i]))

  it('marked + graduated = penalty; marked + new = dontknow (display form shown)', () => {
    expect(byKey.get('fourré')!.cls).toBe('penalty')
    const inconnu = byKey.get('inconnu')!
    expect(inconnu.cls).toBe('dontknow')
    expect(inconnu.display).toBe("l'inconnu")
    expect(inconnu.sentences).toHaveLength(2)                     // merged from both pages
  })

  it('dedupes to the earliest page; unmarked knowns split credit / quiet / rate', () => {
    expect(byKey.get('inconnu')!.pageIdx).toBe(0)                 // marked p.42 first
    expect(wl.creditTargets.map(t => t.key)).toEqual(['sentier']) // long-term → credit
    expect(wl.quietCount).toBe(1)                                 // berge: short-term, nothing
    expect(byKey.get('mousse')!.cls).toBe('rate')                 // never studied → paintable
    expect(byKey.get('nouveau')!.cls).toBe('rate')
    expect(byKey.get('autre')!.pageIdx).toBe(1)
  })

  it('ratings settle items off the worklist and into the section counts', () => {
    const rated = buildWorklist(pages, { inconnu: 'dontknow', sentier: 'credited' }, cards, forward, 'fr', 'en')
    const keys = rated.pages.flatMap(p => p.items).map(i => i.key)
    expect(keys).not.toContain('inconnu')
    expect(rated.creditTargets).toHaveLength(0)
    expect(rated.pages[0]!.credited).toBe(1)
    expect(rated.pages[0]!.settled).toBe(1)
    expect(rated.remaining).toBe(keys.length)
  })

  it('reads the majority page language and labels pages by printed number', () => {
    expect(wl.detectedLang).toBe('fr')
    expect(wl.pages.map(p => p.label)).toEqual(['p. 42', 'p. 43'])
  })
})

describe('recognition-failure penalty', () => {
  function fakeRepo() {
    const upserts: CardState[] = []
    return { upserts, repo: { upsert: async (s: CardState) => { upserts.push(s); return s } } as unknown as CardStateRepository }
  }
  const tracks: EnabledTracks = { typed: false, smart: true, recall: false, reverse: true }
  const deps = (repo: CardStateRepository) => ({
    userId: 'u1', src: 'fr', tgt: 'en', now: NOW, tracks,
    retMap: new Map<string, number>(), calMap: new Map<string, number>(),
    stateRepo: repo, pipelineId: 'p', load: new Map<number, number>(),
  })

  it('applies the real Again: stability collapses, lapse counted, every lane due now', async () => {
    const { repo, upserts } = fakeRepo()
    const fwd = grad('failed')
    const out = await applyRecognitionPenalty(card('failed', 'le fourré', 'thicket'), fwd, null, deps(repo))
    const s = out.forward!
    expect(s.stability!).toBeLessThan(fwd.stability!)             // collapsed like a failed review
    expect(s.lapses).toBe(fwd.lapses + 1)
    expect(s.relearning).toBe(true)
    expect(s.dueAt).toBe(NOW.toISOString())                       // due today
    expect(s.smartDueAt).toBe(NOW.toISOString())
    expect(s.lastRating).toBe('again')
    expect(upserts).toHaveLength(1)
  })

  it('a card still in the pipeline is never punished', async () => {
    const { repo, upserts } = fakeRepo()
    const learning = { ...initialCardState('u1', 'c', 'p') }       // not graduated
    const out = await applyRecognitionPenalty(card('c', 'x', 'y'), learning, null, deps(repo))
    expect(out.forward).toBeUndefined()
    expect(upserts).toHaveLength(0)
  })
})

describe('seedKnownStates', () => {
  it('long bucket lands 80-100 days out on forward + reverse rows, bulk_known', () => {
    const deps = {
      userId: 'u1', src: 'fr', tgt: 'en', now: NOW,
      tracks: { typed: false, smart: true, recall: false, reverse: true } as EnabledTracks,
      retMap: new Map<string, number>(), calMap: new Map<string, number>(),
      stateRepo: {} as CardStateRepository, pipelineId: 'p', load: new Map<number, number>(),
    }
    const [fwd, rev] = seedKnownStates('c1', 'long', undefined, undefined, deps)
    for (const s of [fwd!, rev!]) {
      expect(s.graduated).toBe(true)
      expect(s.acceleratedMode).toBe('bulk_known')
      expect(s.intervalDays).toBeGreaterThanOrEqual(80)
      expect(s.intervalDays).toBeLessThanOrEqual(100)
    }
    expect(fwd!.smartDueAt).toBeTruthy()                          // smart lane columns
    expect(rev!.recallDueAt).toBeTruthy()
    expect(rev!.reviewDirection).toBe('reverse')
  })
})
