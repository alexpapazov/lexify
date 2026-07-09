/**
 * lib/agents/registry.ts — the agent roster. THIS is the extensibility point:
 * a new agent is one entry here (id + prompt + a subset of the shared tools).
 * The runner, gateway, audit, and review UI are all agent-agnostic.
 */

import type { ToolName } from './tools'

export interface AgentConfig {
  id:           string
  label:        string
  model:        string
  systemPrompt: string
  /** Which shared gateway tools this agent may call. */
  tools:        ToolName[]
  /** When true, runs are forced dry-run (propose only); the user approves before applying. */
  defaultDryRun: boolean
}

const CARD_EDITOR_PROMPT = `You are Lexify's card-editor agent. You clean up a language-learner's
flashcards within the scope you're given. Cards have a "front" (the word in the
language being learned) and a "back" (the learner's native-language gloss).

Your job for this run is described in the user's task. Work ONLY within the decks
you can see via the tools. A common task: find cards whose back holds two or more
distinct glosses (e.g. "hi / hello", "leader; guide") and split them so each card
has ONE clean gloss — keep the best gloss on the original card via edit_card_text,
and create one sibling card per additional gloss via split_translation.

Rules:
- ALWAYS start by calling list_decks to get the deckIds in your scope. Never guess
  a deckId — only use ids returned by list_decks. Then work through each deck.
- Use search_cards to inspect a deck before proposing changes.
- Only propose changes you're confident about. Give a clear, short "reason" for each.
- Do NOT touch cards that are already clean.
- You are in DRY-RUN mode: your tool calls only PROPOSE changes; a human reviews
  and approves them. Be precise — every proposal will be shown as a diff.
- When done, briefly summarize what you proposed and why.`

export const AGENTS: Record<string, AgentConfig> = {
  'card-editor': {
    id:           'card-editor',
    label:        'Card editor',
    // Date-suffixed id proven to work with this project's key (same as api/distractors).
    // Bump to a stronger model (e.g. a Sonnet id) once access is confirmed.
    model:        'claude-haiku-4-5-20251001',
    systemPrompt: CARD_EDITOR_PROMPT,
    tools:        ['list_decks', 'search_cards', 'edit_card_text', 'create_card', 'split_translation', 'delete_card'],
    defaultDryRun: true,
  },
}

export function getAgent(id: string): AgentConfig | undefined {
  return AGENTS[id]
}
