/**
 * lib/agents/tools.ts — the SDK-agnostic tool manifest for the agent platform.
 *
 * Each entry pairs a JSON-schema tool definition (usable directly as a Claude
 * tool-use `tools[]` entry AND as an MCP tool) with a handler that calls the
 * scoped gateway. Both the in-app runner (Phase 2) and the MCP server
 * (`lib/agents/mcp/`) consume THIS map, so a new tool is defined in one place.
 */

import type { GatewayContext } from '@/domain'
import type { GatewayDeps } from './gateway'
import * as gw from './gateway'

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>
  run: (ctx: GatewayContext, deps: GatewayDeps, args: Record<string, unknown>) => Promise<unknown>
}

const str = (v: unknown): string => String(v ?? '')
const strArr = (v: unknown): string[] => Array.isArray(v) ? v.map(str) : []

export const TOOLS: Record<string, ToolDef> = {
  list_decks: {
    name: 'list_decks',
    description: 'List the decks in your grant scope (deckId, name, source/target language). Call this FIRST — you need a real deckId before you can search or edit anything.',
    inputSchema: { type: 'object', properties: {} },
    run: async (ctx, deps) => {
      const decks = await gw.listDecksInScope(ctx, deps)
      return decks.map(d => ({ deckId: d.id, name: d.name, source: d.sourceLanguage, target: d.targetLanguage }))
    },
  },

  search_cards: {
    name: 'search_cards',
    description: 'List cards in an in-scope deck, optionally filtered by a substring on either side.',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'string', description: 'Deck to search (must be in the grant scope).' },
        query:  { type: 'string', description: 'Optional case-insensitive substring to match on front or back.' },
      },
      required: ['deckId'],
    },
    run: (ctx, deps, args) => gw.searchCards(ctx, deps, { deckId: str(args.deckId), query: args.query ? str(args.query) : undefined }),
  },

  edit_card_text: {
    name: 'edit_card_text',
    description: 'Edit a card\'s front and/or back text. Under a dry-run grant this only proposes the change.',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'string' },
        cardId: { type: 'string' },
        front:  { type: 'string', description: 'New front text (omit to leave unchanged).' },
        back:   { type: 'string', description: 'New back text (omit to leave unchanged).' },
        reason: { type: 'string', description: 'Why this edit is being made (shown in the review UI).' },
      },
      required: ['deckId', 'cardId', 'reason'],
    },
    run: (ctx, deps, args) => gw.editCardText(ctx, deps, {
      deckId: str(args.deckId), cardId: str(args.cardId),
      front: args.front !== undefined ? str(args.front) : undefined,
      back:  args.back  !== undefined ? str(args.back)  : undefined,
      reason: str(args.reason),
    }),
  },

  create_card: {
    name: 'create_card',
    description: 'Create a new card in an in-scope deck.',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'string' },
        front:  { type: 'string', description: 'Source-language (learned) text.' },
        back:   { type: 'string', description: 'Target-language (native) text.' },
        reason: { type: 'string' },
      },
      required: ['deckId', 'front', 'back', 'reason'],
    },
    run: (ctx, deps, args) => gw.createCard(ctx, deps, {
      deckId: str(args.deckId), front: str(args.front), back: str(args.back), reason: str(args.reason),
    }),
  },

  delete_card: {
    name: 'delete_card',
    description: 'Soft-delete a card (removes it from every deck that references it).',
    inputSchema: {
      type: 'object',
      properties: {
        deckId: { type: 'string' },
        cardId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['deckId', 'cardId', 'reason'],
    },
    run: (ctx, deps, args) => gw.deleteCard(ctx, deps, {
      deckId: str(args.deckId), cardId: str(args.cardId), reason: str(args.reason),
    }),
  },

  split_translation: {
    name: 'split_translation',
    description: 'Split a card whose back holds multiple glosses (e.g. "hi / hello") into a primary card plus one new sibling per extra gloss.',
    inputSchema: {
      type: 'object',
      properties: {
        deckId:      { type: 'string' },
        cardId:      { type: 'string' },
        primaryBack: { type: 'string', description: 'The gloss the original card keeps.' },
        extraBacks:  { type: 'array', items: { type: 'string' }, description: 'One new sibling card is created per extra gloss.' },
        reason:      { type: 'string' },
      },
      required: ['deckId', 'cardId', 'primaryBack', 'extraBacks', 'reason'],
    },
    run: (ctx, deps, args) => gw.splitTranslation(ctx, deps, {
      deckId: str(args.deckId), cardId: str(args.cardId),
      primaryBack: str(args.primaryBack), extraBacks: strArr(args.extraBacks), reason: str(args.reason),
    }),
  },
}

export type ToolName = keyof typeof TOOLS

/** The tool definitions a given agent is allowed to use (for a Claude `tools[]` array). */
export function toolsForNames(names: readonly string[]): ToolDef[] {
  return names.map(n => TOOLS[n]).filter((t): t is ToolDef => !!t)
}
