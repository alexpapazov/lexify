# Lexify Agents — MCP server

Exposes the scoped, audited **agent gateway** (`lib/agents/gateway.ts`) as MCP
tools so Claude Code / Claude Desktop can run the same card operations the in-app
agents use. This directory is **excluded from the Next app's tsconfig** — it's a
standalone Node process and depends on the MCP SDK, which the app itself doesn't
need.

## Install & run

```bash
npm i @modelcontextprotocol/sdk
npm i -D tsx   # if not already present

LEXIFY_USER_ID=<your-user-uuid> \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
NEXT_PUBLIC_SUPABASE_URL=<url> \
  npx tsx lib/agents/mcp/server.ts
```

Then register it with Claude Code/Desktop as a stdio MCP server pointing at that
command.

## How it works

- Registers every tool in `lib/agents/tools.ts` (`search_cards`, `edit_card_text`,
  `create_card`, `delete_card`, `split_translation`) plus a `set_grant` tool.
- **Safety:** the session starts with an empty, `dryRunOnly` grant — nothing can
  be written until you call `set_grant` with explicit scope. Even then, the
  gateway enforces the `Grant` on every call.

## Open decisions (Phase 1 → later)

- **Auth:** a local server can't use the browser Supabase session. Current
  scaffold uses a service-role key + explicit `LEXIFY_USER_ID`. Revisit if you
  want per-user tokens.
- The SDK wiring in `server.ts` is illustrative (`@ts-nocheck`) — confirm the
  exact entry points against the installed SDK version. The gateway/tools it
  calls are real and typechecked by the app build.
