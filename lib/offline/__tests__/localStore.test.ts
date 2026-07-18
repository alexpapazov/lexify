import 'fake-indexeddb/auto'
import { LocalStore } from '@/lib/offline/localStore'
import { cardStateKey, ladderKey, paramKey, overrideKey } from '@/lib/offline/keys'
import { initialCardState } from '@/engine/pipeline'
import type { Card } from '@/domain'
import type { DownloadBundle, StoredCardState } from '@/lib/offline/types'

const PIPE = '00000000-0000-0000-0000-000000000001'
const iso = '2026-07-18T00:00:00.000Z'
let dbSeq = 0
const freshStore = () => new LocalStore(`test-${dbSeq++}`)

const card = (id: string, front = 'hola'): Card => ({
  id, ownerId: 'u1', sourceLanguage: 'es', targetLanguage: 'en', front, back: 'hi',
  hints: [], choices: null, position: 0, createdAt: iso, updatedAt: iso, deletedAt: null,
})
const state = (cardId: string): StoredCardState => ({
  ...initialCardState('u1', cardId, PIPE), key: cardStateKey(cardId, 'forward'), serverUpdatedAt: iso,
})
const bundle = (over: Partial<DownloadBundle> = {}): DownloadBundle => ({
  manifest: { userId: 'u1', scope: { kind: 'library' }, dueWindowDays: 7, includeAudio: false, downloadedAt: iso, cardCount: 2 },
  cards: [card('a'), card('b')],
  cardStates: [state('a'), state('b')],
  ladderClimb: [], ladders: [], schedulerParams: [], decks: [], folders: [], confusionLinks: [], overrides: [],
  deckCards: [],
  ...over,
})

describe('offline keys', () => {
  it('derive stable composite keys', () => {
    expect(cardStateKey('c1', 'forward')).toBe('c1:forward')
    expect(ladderKey('es', 'en')).toBe('es|en')
    expect(ladderKey(null, null)).toBe('default')
    expect(paramKey('es', 'en', 'forward_typed')).toBe('es|en:forward_typed')
    expect(overrideKey('c1', 'front', 'hola')).toBe('c1:front:hola')
  })
})

describe('LocalStore', () => {
  it('hydrates a bundle and reads it back', async () => {
    const s = freshStore()
    expect(await s.isDownloaded()).toBe(false)
    await s.hydrate(bundle())
    expect(await s.isDownloaded()).toBe(true)
    expect((await s.getManifest())?.cardCount).toBe(2)
    expect(await s.allCards()).toHaveLength(2)
    expect((await s.getCard('a'))?.front).toBe('hola')
    expect((await s.getCardState('a', 'forward'))?.cardId).toBe('a')
    await s.destroy()
  })

  it('putCardState upserts by derived key (no duplicate row)', async () => {
    const s = freshStore()
    await s.hydrate(bundle())
    const before = await s.getCardState('a', 'forward')
    await s.putCardState({ ...before!, reps: 5 })
    expect((await s.getCardState('a', 'forward'))?.reps).toBe(5)
    expect(await s.allCardStates()).toHaveLength(2) // still 2, not 3
    await s.destroy()
  })

  it('re-hydrating replaces content but keeps the outbox', async () => {
    const s = freshStore()
    await s.hydrate(bundle())
    await s.enqueue({ entity: 'cardState', key: 'a:forward', op: 'upsert', payload: {}, localUpdatedAt: iso })
    await s.hydrate(bundle({ cards: [card('c')], cardStates: [state('c')] }))
    expect(await s.getCard('a')).toBeUndefined()   // old content cleared
    expect((await s.getCard('c'))?.id).toBe('c')
    expect(await s.outboxCount()).toBe(1)          // outbox survived
    await s.destroy()
  })

  it('outbox: enqueue, list, delete, clear', async () => {
    const s = freshStore()
    const id1 = await s.enqueue({ entity: 'reviewEvent', key: 'r1', op: 'insert', payload: { n: 1 }, localUpdatedAt: iso })
    await s.enqueue({ entity: 'ladderEvent', key: 'e1', op: 'insert', payload: { n: 2 }, localUpdatedAt: iso })
    expect(await s.outboxCount()).toBe(2)
    const rows = await s.outbox()
    expect(rows[0]!.entity).toBe('reviewEvent')
    await s.deleteOutbox([id1])
    expect(await s.outboxCount()).toBe(1)
    await s.clearOutbox()
    expect(await s.outboxCount()).toBe(0)
    await s.destroy()
  })

  it('clearAll wipes content and outbox', async () => {
    const s = freshStore()
    await s.hydrate(bundle())
    await s.enqueue({ entity: 'cardState', key: 'a:forward', op: 'upsert', payload: {}, localUpdatedAt: iso })
    await s.clearAll()
    expect(await s.isDownloaded()).toBe(false)
    expect(await s.allCards()).toHaveLength(0)
    expect(await s.outboxCount()).toBe(0)
    await s.destroy()
  })
})
