/**
 * POST /api/agents/claude
 *
 * Thin, auth-gated proxy for one Anthropic tool-use turn. The client runs the
 * agent loop (executing tools against its own RLS-scoped Supabase session), but
 * the Anthropic API key must stay server-side — so each turn is proxied here.
 *
 * The client sends `{ agentId, messages }`. The SERVER injects the system prompt
 * and tool set from the registry, so a client can only drive registered agents
 * with their approved tools (it can't smuggle in an arbitrary prompt/tools).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAgent } from '@/lib/agents/registry'
import { toolsForNames } from '@/lib/agents/tools'

export const runtime = 'nodejs'

interface Body {
  agentId:  string
  messages: unknown[]
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  let body: Body
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 }) }

  const agent = getAgent(body.agentId)
  if (!agent) return NextResponse.json({ ok: false, error: `unknown agent '${body.agentId}'` }, { status: 400 })
  if (!Array.isArray(body.messages)) return NextResponse.json({ ok: false, error: 'messages must be an array' }, { status: 400 })

  const tools = toolsForNames(agent.tools).map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 2048,
      system: agent.systemPrompt,
      tools,
      messages: body.messages,
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return NextResponse.json({ ok: false, error: `anthropic ${res.status}`, detail }, { status: 502 })
  }
  const data = await res.json()
  return NextResponse.json({ ok: true, content: data.content ?? [], stop_reason: data.stop_reason ?? null })
}
