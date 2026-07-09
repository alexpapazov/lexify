/**
 * lib/agents/runner.ts — the generic agent tool-use loop. Agent-agnostic:
 * it drives a Claude conversation, executes tool calls against the scoped
 * gateway, and collects the resulting `ChangeProposal`s. Transport-agnostic
 * too — the Anthropic call is injected as `CallModel`, so this is unit-testable
 * with a fake model and fake gateway deps.
 *
 * Under a dry-run grant (the card-editor default) the gateway ops only PROPOSE,
 * so `runAgent` returns proposals for the review UI without writing anything.
 */

import type { GatewayContext, ChangeProposal } from '@/domain'
import type { GatewayDeps } from './gateway'
import type { CallModel, Message, ToolResultBlock } from './anthropic'
import { TOOLS } from './tools'

const MAX_TURNS = 12

export interface AgentRunResult {
  proposals: ChangeProposal[]
  summary:   string
  turns:     number
}

/** Extracts `proposals` from a gateway tool result, if present. */
function proposalsOf(result: unknown): ChangeProposal[] {
  if (result && typeof result === 'object' && Array.isArray((result as { proposals?: unknown }).proposals)) {
    return (result as { proposals: ChangeProposal[] }).proposals
  }
  return []
}

export async function runAgent(opts: {
  ctx: GatewayContext
  deps: GatewayDeps
  task: string
  callModel: CallModel
  allowedTools: string[]
}): Promise<AgentRunResult> {
  const { ctx, deps, task, callModel, allowedTools } = opts
  const allowed = new Set(allowedTools)
  const messages: Message[] = [{ role: 'user', content: task }]
  const proposals: ChangeProposal[] = []
  let summary = ''
  let turns = 0

  while (turns < MAX_TURNS) {
    turns++
    const resp = await callModel(messages)
    messages.push({ role: 'assistant', content: resp.content })

    const text = resp.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim()
    if (text) summary = text

    const toolUses = resp.content.filter(b => b.type === 'tool_use') as Array<{ id: string; name: string; input: Record<string, unknown> }>
    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) break

    const results: ToolResultBlock[] = []
    for (const tu of toolUses) {
      const tool = allowed.has(tu.name) ? TOOLS[tu.name] : undefined
      if (!tool) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: `error: tool '${tu.name}' is not available to this agent`, is_error: true })
        continue
      }
      try {
        const result = await tool.run(ctx, deps, tu.input)
        proposals.push(...proposalsOf(result))
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) })
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: `error: ${e instanceof Error ? e.message : String(e)}`, is_error: true })
      }
    }
    messages.push({ role: 'user', content: results })
  }

  return { proposals, summary, turns }
}
