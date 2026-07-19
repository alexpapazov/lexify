import 'fake-indexeddb/auto'
import { getLocalStore } from '@/lib/offline/localStore'
import {
  localDecks, localGetDeck, localFolders, localCardsByDeck, localGetCard,
  localCardStatesByDeck, localClimbForCards, localLadderForPair, localSchedulerParams,
  localOverridesForUser, localUpsertCardState, localDeleteCardState, localSaveClimb,
  localRemoveClimb, localLogLadderEvent, localDeleteLadderEvent, localAddOverride,
  localRemoveOverride, localUpdateCard, localOwnedCards,
  localCreateDeck, localCreateFolder, localCreateCard, localLinkDeckCard,
  localSaveLadder, localResetLadder, localAllLadders,
} from '@/lib/offline/localRepos'
import { cardStateKey, ladderKey } from '@/lib/offline/keys'
import { initialCardState } from '@/engine/pipeline'
import { DEFAULT_GRADING_SETTINGS } from '@/domain'
import type { Card, Deck } from '@/domain'
import type { DownloadBundle, StoredCardState } from '@/lib/offline/types'
import type { LadderEventInput } from '@/lib/data/ladderEvents'

const PIPE = '00000000-0000-0000-0000-000000000001'
const iso = '2026-07-18T00:00:00.000Z'

const card = (id: string, front = 'hola'): Card => ({
  id, ownerId: 'u1', sourceLanguage: 'es', targetLanguage: 'en', front, back: 'hi',
  hints: [], choices: null, position: 0, createdAt: iso, updatedAt: iso, deletedAt: null,
})
const cstate = (cardId: string): StoredCardState => ({
  ...initialCardState('u1', cardId, PIPE), key: cardStateKey(cardId, 'forward'), serverUpdatedAt: iso,
})
const bundle = (): DownloadBundle => ({
  manifest: { userId: 'u1', scope: { kind: 'library' }, dueWindowDays: 7, includeAudio: false, downloadedAt: iso, cardCount: 2 },
  cards: [card('a'), card('b')],
  cardStates: [cstate('a'), cstate('b')],
  ladderClimb: [],
  ladders: [{ key: ladderKey('es', 'en'), source: 'es', target: 'en', ladder: { rungs: [], betweenRungWaitSeconds: 180 } }],
  schedulerParams: [],
  decks: [{
    id: 'd1', ownerId: 'u1', name: 'Deck 1', sourceLanguage: 'es', targetLanguage: 'en',
    pipelineId: PIPE, gradingSettings: DEFAULT_GRADING_SETTINGS, isPublic: false, isPinned: false,
    folderId: null, position: 0, syncingComplete: true, createdAt: iso, updatedAt: iso, deletedAt: null,
  } satisfies Deck],
  folders: [],
  confusionLinks: [],
  overrides: [],
  deckCards: [{ key: 'd1:a', deckId: 'd1', cardId: 'a' }, { key: 'd1:b', deckId: 'd1', cardId: 'b' }],
})

beforeEach(async () => {
  await getLocalStore().hydrate(bundle())
  await getLocalStore().clearOutbox()
})

describe('localRepos reads', () => {
  it('reads decks, cards, states, ladder from the local store', async () => {
    expect((await localDecks()).map(d => d.id)).toEqual(['d1'])
    expect((await localGetDeck('d1'))?.name).toBe('Deck 1')
    expect(await localFolders()).toEqual([])
    expect((await localCardsByDeck('d1')).map(c => c.id).sort()).toEqual(['a', 'b'])
    expect((await localGetCard('a'))?.front).toBe('hola')
    expect((await localCardStatesByDeck('d1')).length).toBe(2)
    expect((await localLadderForPair('es', 'en'))?.betweenRungWaitSeconds).toBe(180)
    expect(await localSchedulerParams()).toEqual([])
    expect(await localClimbForCards(['a'])).toEqual(new Map())
    expect(await localOverridesForUser()).toEqual([])
  })
})

describe('localRepos writes queue to the outbox', () => {
  it('upsert/delete card state', async () => {
    const s = { ...(await localCardStatesByDeck('d1'))[0]!, reps: 3 }
    await localUpsertCardState(s)
    expect((await localCardStatesByDeck('d1')).find(x => x.cardId === s.cardId)?.reps).toBe(3)
    await localDeleteCardState(s.cardId, 'forward')
    const box = await getLocalStore().outbox()
    expect(box.filter(o => o.entity === 'cardState').map(o => o.op)).toEqual(['upsert', 'delete'])
  })

  it('climb save/remove', async () => {
    await localSaveClimb('a', 'd1', { rung: 0 } as never)
    expect((await localClimbForCards(['a'])).has('a')).toBe(true)
    await localRemoveClimb('a')
    expect((await localClimbForCards(['a'])).has('a')).toBe(false)
    expect((await getLocalStore().outbox()).filter(o => o.entity === 'ladderClimb').length).toBe(2)
  })

  it('ladder event insert then undo removes the pending insert', async () => {
    const e: LadderEventInput = {
      sessionId: 's1', cardId: 'a', deckId: 'd1', label: null, sourceLanguage: 'es', targetLanguage: 'en',
      fromRung: 0, toRung: 1, rungCount: 1, rungType: 'mcq', outcome: 'good', advanced: true, graduated: false,
      overridden: false, durationMs: 1000,
    }
    const id = await localLogLadderEvent(e)
    expect((await getLocalStore().outbox()).filter(o => o.entity === 'ladderEvent').length).toBe(1)
    await localDeleteLadderEvent(id)
    expect((await getLocalStore().outbox()).filter(o => o.entity === 'ladderEvent').length).toBe(0)
  })

  it('override add/remove', async () => {
    await localAddOverride('a', 'front', 'hola')
    expect(await localOverridesForUser()).toHaveLength(1)
    await localRemoveOverride('a', 'front', 'hola')
    expect(await localOverridesForUser()).toHaveLength(0)
    expect((await getLocalStore().outbox()).filter(o => o.entity === 'override').map(o => o.op)).toEqual(['insert', 'delete'])
  })

  it('card update merges the patch and queues an upsert', async () => {
    const updated = await localUpdateCard('a', { front: 'adiós' })
    expect(updated.front).toBe('adiós')
    expect((await localGetCard('a'))?.front).toBe('adiós')
    expect((await getLocalStore().outbox()).filter(o => o.entity === 'card').length).toBe(1)
  })

  it('creates a deck (+ folder, cards, link) offline and queues them in order', async () => {
    const folder = await localCreateFolder({
      id: 'f-new', ownerId: 'u1', name: 'New', parentId: null, position: 0,
      createdAt: iso, updatedAt: iso, deletedAt: null, isSynced: false, sourceLanguage: null, targetLanguage: null,
    })
    const deck = await localCreateDeck({
      id: 'd-new', ownerId: 'u1', name: 'Fresh', sourceLanguage: 'es', targetLanguage: 'en', pipelineId: PIPE,
      gradingSettings: DEFAULT_GRADING_SETTINGS, isPublic: false, isPinned: false,
      folderId: folder.id, position: 0, syncingComplete: true, createdAt: iso, updatedAt: iso, deletedAt: null,
    })
    await localCreateCard(card('n1', 'nuevo'), deck.id)
    await localLinkDeckCard(deck.id, 'a', 1)   // link an existing downloaded card

    // Both new deck + its new card are visible locally and studyable.
    expect((await localDecks()).map(d => d.id).sort()).toEqual(['d-new', 'd1'])
    expect((await localCardsByDeck('d-new')).map(c => c.id).sort()).toEqual(['a', 'n1'])

    // Outbox preserves FK-safe order: folder → deck → card → link.
    const box = await getLocalStore().outbox()
    expect(box.map(o => o.entity)).toEqual(['folderCreate', 'deckCreate', 'cardCreate', 'deckCardLink'])
  })

  it('localOwnedCards returns downloaded cards for the pair (offline dup check)', async () => {
    expect((await localOwnedCards('es', 'en')).map(c => c.id).sort()).toEqual(['a', 'b'])
    expect(await localOwnedCards('fr', 'en')).toEqual([])
  })

  it('saves and resets a ladder offline (local + outbox)', async () => {
    const lad = { rungs: [], betweenRungWaitSeconds: 90 }
    await localSaveLadder('es', 'en', lad)
    expect((await localLadderForPair('es', 'en'))?.betweenRungWaitSeconds).toBe(90)
    expect((await localAllLadders()).some(l => l.source === 'es' && l.target === 'en')).toBe(true)

    await localSaveLadder('', '', { rungs: [], betweenRungWaitSeconds: 120 })  // the default
    expect((await getLocalStore().getLadder('default'))?.ladder).toEqual({ rungs: [], betweenRungWaitSeconds: 120 })

    await localResetLadder('es', 'en')
    expect(await localLadderForPair('es', 'en')).toBeNull()

    expect((await getLocalStore().outbox()).filter(o => o.entity === 'ladderSave' || o.entity === 'ladderReset').map(o => o.entity))
      .toEqual(['ladderSave', 'ladderSave', 'ladderReset'])
  })
})
