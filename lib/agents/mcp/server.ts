/**
 * lib/agents/mcp/server.ts — MCP server exposing the Lexify agent toolbelt.
 *
 * This is a STANDALONE Node process (stdio transport) so Claude Code / Claude
 * Desktop can call the same scoped, audited gateway tools that the in-app runner
 * uses. It is intentionally EXCLUDED from the Next app's tsconfig (see the
 * `exclude` entry) because it depends on `@modelcontextprotocol/sdk`, which is a
 * separate install and only needed to run the server — not the app.
 *
 * ── Setup ────────────────────────────────────────────────────────────────────
 *   npm i @modelcontextprotocol/sdk
 *   # then run with a service-role key + the user id to act as:
 *   LEXIFY_USER_ID=<uuid> SUPABASE_SERVICE_ROLE_KEY=<key> \
 *     npx tsx lib/agents/mcp/server.ts
 *
 * ── Auth model (decide before shipping) ──────────────────────────────────────
 * A local MCP server can't use the browser Supabase session. Options:
 *   (a) service-role key + an explicit LEXIFY_USER_ID env → the server acts as
 *       that one user, bypassing RLS. Simple; keep the key local only.
 *   (b) a per-user personal access token exchanged for a scoped client.
 * The tools still enforce the app-level `Grant` regardless of DB auth, so scope
 * is honored even under a service key.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * Registers every entry in `TOOLS` (lib/agents/tools.ts) as an MCP tool, plus a
 * `set_grant` tool to establish the active scope for the session. Handlers call
 * the gateway with a `GatewayContext` built from the current grant.
 *
 * NOTE: the `@modelcontextprotocol/sdk` import below is illustrative pseudo-wiring
 * — confirm the exact SDK entry points against the installed version. The gateway
 * layer it calls (`TOOLS`, `createSupabaseGatewayDeps`) is real and typechecked
 * by the app build.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck  (excluded from app tsconfig; typecheck against the SDK at run time)

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { TOOLS } from '../tools'
import { createSupabaseGatewayDeps } from '../deps'
import type { Grant, GatewayContext } from '@/domain'

const userId = process.env.LEXIFY_USER_ID
if (!userId) throw new Error('Set LEXIFY_USER_ID to the user the server acts as.')

const deps = createSupabaseGatewayDeps()

// The active scope. Defaults to dry-run-everything until `set_grant` is called —
// safety first: nothing can be written before the user sets an explicit grant.
let grant: Grant = { operations: [], languages: [], folderIds: [], deckIds: [], dryRunOnly: true }
const ctx = (): GatewayContext => ({ userId, grant, actor: 'mcp' })

const server = new Server({ name: 'lexify-agents', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'set_grant',
      description: 'Set the active permission scope (operations, languages, folders, decks, dryRunOnly) for this session.',
      inputSchema: {
        type: 'object',
        properties: {
          operations: { type: 'array', items: { type: 'string' } },
          languages:  { type: 'array', items: { type: 'string' } },
          folderIds:  { type: 'array', items: { type: 'string' } },
          deckIds:    { type: 'array', items: { type: 'string' } },
          dryRunOnly: { type: 'boolean' },
        },
      },
    },
    ...Object.values(TOOLS).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
  const { name, arguments: args } = req.params
  if (name === 'set_grant') {
    grant = {
      operations: args.operations ?? [], languages: args.languages ?? [],
      folderIds: args.folderIds ?? [], deckIds: args.deckIds ?? [],
      dryRunOnly: args.dryRunOnly ?? true,
    }
    return { content: [{ type: 'text', text: `Grant set: ${JSON.stringify(grant)}` }] }
  }
  const tool = TOOLS[name]
  if (!tool) throw new Error(`unknown tool: ${name}`)
  const result = await tool.run(ctx(), deps, args ?? {})
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})

await server.connect(new StdioServerTransport())
