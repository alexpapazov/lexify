import type { Card, Deck, Grant, GatewayContext } from '@/domain'
import type { GatewayDeps } from '@/lib/agents/gateway'
import type { CallModel, Message, ModelResponse } from '@/lib/agents/anthropic'
import { runAgent } from '@/lib/agents/runner'

function deck(id: string): Deck {
  return { id, ownerId: 'u', name: id, sourceLanguage: 'fr', targetLanguage: 'en', folderId: null,
    pipelineId: 'p', gradingSettings: {} as Deck['gradingSettings'], isPublic: false, isPinned: false,
    position: 0, syncingComplete: true, createdAt: '', updatedAt: '', deletedAt: null } as Deck
}
function card(id: string, front: string, back: string): Card {
  return { id, ownerId: 'u', sourceLanguage: 'fr', targetLanguage: 'en', front, back, hints: [],
    choices: null, position: 0, createdAt: '', updatedAt: '', deletedAt: null } as Card
}

function makeDeps() {
  const cards = [card('c1', 'salut', 'hi/hello')]
  const writes: string[] = []
  const deps: GatewayDeps = {
    listDecks:   async () => [deck('d-fr')],
    listFolders: async () => [],
    listCards:   async () => cards,
    getCard:     async id => cards.find(c => c.id === id) ?? null,
    updateCard:  async (id, patch) => { writes.push(`update:${id}`); const c = cards.find(x => x.id === id)!; Object.assign(c, patch); return c },
    createCard:  async () => { writes.push('create'); return card('new', 'salut', 'hello') },
    deleteCard:  async () => { writes.push('delete') },
    recordAction: async () => { writes.push('audit') },
  }
  return { deps, writes }
}

const dryRunGrant: Grant = {
  operations: ['edit', 'create', 'delete'], languages: [], folderIds: [], deckIds: [], dryRunOnly: true,
}
const ctx: GatewayContext = { userId: 'u', grant: dryRunGrant, actor: 'card-editor' }

/** A CallModel that plays a fixed script of responses, ignoring the messages. */
function scriptModel(script: ModelResponse[]): { call: CallModel; seen: Message[][] } {
  const seen: Message[][] = []
  let i = 0
  const call: CallModel = async messages => { seen.push(messages.map(m => ({ ...m }))); return script[i++]! }
  return { call, seen }
}

describe('runAgent', () => {
  it('executes tool calls, collects proposals, and stops on end_turn (dry-run writes nothing)', async () => {
    const { deps, writes } = makeDeps()
    const { call } = scriptModel([
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'split_translation',
          input: { deckId: 'd-fr', cardId: 'c1', primaryBack: 'hi', extraBacks: ['hello'], reason: 'two glosses' } },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Split salut into hi + hello.' }] },
    ])
    const res = await runAgent({ ctx, deps, task: 'split multi-gloss cards', callModel: call, allowedTools: ['split_translation'] })
    expect(res.summary).toBe('Split salut into hi + hello.')
    expect(res.proposals.map(p => p.field)).toEqual(['back', 'create'])
    expect(writes).toEqual([])          // dry-run: nothing written
    expect(res.turns).toBe(2)
  })

  it('rejects tools not in the allowed set', async () => {
    const { deps } = makeDeps()
    const { call } = scriptModel([
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'delete_card', input: { deckId: 'd-fr', cardId: 'c1', reason: 'x' } },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    ])
    const res = await runAgent({ ctx, deps, task: 't', callModel: call, allowedTools: ['search_cards'] })
    expect(res.proposals).toHaveLength(0)   // delete_card was blocked
  })

  it('surfaces a tool error to the model without crashing', async () => {
    const { deps } = makeDeps()
    const { call, seen } = scriptModel([
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'edit_card_text', input: { deckId: 'nope', cardId: 'c1', back: 'hi', reason: 'r' } },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    ])
    const res = await runAgent({ ctx, deps, task: 't', callModel: call, allowedTools: ['edit_card_text'] })
    // Second turn's messages include a tool_result flagged is_error for the out-of-scope deck.
    const lastUser = seen[1]![seen[1]!.length - 1]!
    expect(Array.isArray(lastUser.content)).toBe(true)
    expect((lastUser.content as Array<{ is_error?: boolean }>)[0]!.is_error).toBe(true)
    expect(res.proposals).toHaveLength(0)
  })
})
