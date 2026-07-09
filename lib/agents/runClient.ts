/**
 * lib/agents/runClient.ts — browser-side orchestration for an agent run.
 *
 * The agent loop runs in the browser so tool calls hit the user's own
 * RLS-scoped Supabase session (via the existing repos); only the Anthropic call
 * is proxied server-side (`/api/agents/claude`). A dry-run run produces a
 * persisted change set the user then reviews; `applyProposal` applies one
 * approved item through the real gateway (non-dry-run).
 */

import type { CallModel } from './anthropic'
import type { Grant, GatewayContext, ChangeSetItem, UserId } from '@/domain'
import { createSupabaseGatewayDeps } from './deps'
import { runAgent } from './runner'
import { getAgent } from './registry'
import { SupabaseChangeSetRepository } from '@/lib/data/changeSets'
import * as gw from './gateway'

function proxyCallModel(agentId: string): CallModel {
  return async messages => {
    const res = await fetch('/api/agents/claude', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, messages }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'model call failed')
    return { content: data.content, stop_reason: data.stop_reason }
  }
}

/** Runs the agent (dry-run) and persists the resulting change set. Returns its id. */
export async function runAgentAndSave(opts: { agentId: string; userId: UserId; grant: Grant; task: string }): Promise<string> {
  const agent = getAgent(opts.agentId)
  if (!agent) throw new Error(`unknown agent '${opts.agentId}'`)
  const grant: Grant = { ...opts.grant, dryRunOnly: agent.defaultDryRun ? true : opts.grant.dryRunOnly }
  const ctx: GatewayContext = { userId: opts.userId, grant, actor: agent.id }
  const deps = createSupabaseGatewayDeps()
  const { proposals, summary } = await runAgent({
    ctx, deps, task: opts.task, callModel: proxyCallModel(agent.id), allowedTools: agent.tools,
  })
  const set = await new SupabaseChangeSetRepository().create(opts.userId, agent.id, opts.task, summary, proposals)
  return set.id
}

/** Applies a single approved proposal through the gateway (non-dry-run, audited). */
export async function applyProposal(userId: UserId, item: ChangeSetItem): Promise<void> {
  const p = item.proposal
  const operation = p.field === 'create' ? 'create' : p.field === 'delete' ? 'delete' : 'edit'
  const grant: Grant = { operations: [operation], languages: [], folderIds: [], deckIds: [p.deckId], dryRunOnly: false }
  const ctx: GatewayContext = { userId, grant, actor: 'user' }
  const deps = createSupabaseGatewayDeps()

  if (p.field === 'create') {
    const a = p.after as { front: string; back: string }
    await gw.createCard(ctx, deps, { deckId: p.deckId, front: a.front, back: a.back, reason: p.reason })
  } else if (p.field === 'delete') {
    await gw.deleteCard(ctx, deps, { deckId: p.deckId, cardId: p.cardId!, reason: p.reason })
  } else if (p.field === 'front' || p.field === 'back') {
    const patch = p.field === 'front' ? { front: String(p.after) } : { back: String(p.after) }
    await gw.editCardText(ctx, deps, { deckId: p.deckId, cardId: p.cardId!, ...patch, reason: p.reason })
  } else {
    throw new Error(`cannot apply proposal of field '${p.field}'`)
  }
}
