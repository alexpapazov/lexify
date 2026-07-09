# Agent Platform — design & rollout plan

> **STATUS: Phases 1 & 2 BUILT (2026-07-09, need migrations `070` + `071`
> applied + `ANTHROPIC_API_KEY` set); Phases 3+ still PLANNED.** Phases 1–2 are
> specced in full below; Phases 3+ are summarized so a later session can expand
> them on request.
>
> **Phase 2 shipped:** `lib/agents/registry.ts` (AGENTS map — the card-editor
> agent; add an agent = one entry); `lib/agents/runner.ts` (generic, transport-
> agnostic tool-use loop, unit-tested with a fake model); `lib/agents/anthropic.ts`
> (Messages API tool-use typings); `lib/agents/runClient.ts` (browser
> orchestration: `runAgentAndSave` + `applyProposal`); `app/api/agents/claude`
> (auth-light proxy that injects the registry's system prompt + tools server-side,
> keeps the key off the client — model call runs in the browser loop via this
> proxy); change-set persistence (`domain` `ChangeSet`/`ChangeSetItem`,
> `lib/data/changeSets.ts`, migration `071_change_sets`); UI: `app/agents`
> (launcher: pick scope + task, dry-run) and `app/agents/review/[changeSetId]`
> (diff + approve/reject + Apply approved → applies each via the gateway). Runner
> tests: 3. **Architecture note:** the agent loop runs CLIENT-side (reuses the
> RLS-scoped browser repos + gateway, so no server repo duplication); only the
> Claude turn is proxied. **Not live-verified:** the end-to-end Anthropic tool-use
> loop (needs the API key + a real run); the proxy is currently gated only by
> `agentId` validity — add real auth (verify the caller) before trusting it.
>
> **Phase 1 shipped:** `domain` types (`Grant`/`GatewayContext`/`ChangeProposal`/
> `AgentAction`/`AgentOperation`); `lib/agents/gateway.ts` (scope + audit +
> apply-or-propose: `searchCards`/`editCardText`/`createCard`/`deleteCard`/
> `splitTranslation`, DI-based); `lib/agents/deps.ts` (Supabase wiring);
> `lib/agents/tools.ts` (SDK-agnostic manifest); `lib/agents/mcp/` (standalone MCP
> server scaffold — needs `npm i @modelcontextprotocol/sdk`, excluded from app
> tsconfig); `lib/data/agentActions.ts` + interface; migration `070_agent_actions`;
> 12 gateway unit tests. **Not yet done in P1:** `mergeCards`, `triggerSync`,
> `regenerateDistractors` ops (documented as TODO), and refactoring the existing
> sync/distractor routes to route their writes through the gateway.

## Locked decisions (2026-07-09)
- **Gateway is an MCP server from the start.** Core op logic lives in
  `lib/agents/gateway.ts` (pure, importable by the in-app runner); an MCP server
  wrapper (`lib/agents/mcp/`) exposes the same ops as MCP tools so they're
  callable from Claude Code/Desktop too. Both paths share the core module — no
  duplicated logic. (This pulls the old "Phase 5 MCP" work forward into Phase 1.)
- **Card edits are always dry-run + approve.** The card-editor agent may only
  ever PROPOSE a change set; nothing is written until the user approves a diff.
  There is no auto-apply path. `Grant.dryRunOnly` defaults true for edit agents.

## The core idea (read first)

Lexify's AI features (sync, distractor/card generation, calibration) are
today **disconnected API routes**, each with its own hand-rolled Supabase
access. That's why card edits are painful and the "agents" can't cooperate.

The fix is **one shared toolbelt over the data, and "agents" are just
(system prompt + allowed tools + scope) configs that share it.** An agent
"calling" another agent is the orchestrator running a sub-task with a subset
of tools/scope — not a separate service.

Three invariants every mutation must pass through (the **gateway**):
1. **Scope check** — reject anything outside the active `Grant`.
2. **Audit log** — record who/what/before/after.
3. **Apply vs. propose** — mutate directly, or emit a reviewable change set.

---

## Phase 1 — Tool gateway + audit log + scope primitives (NO AI)

Goal: every card/deck/folder mutation flows through one audited, scope-checked
module. This alone de-tangles the codebase; no model calls involved yet.

### New domain types (`domain/index.ts`)
```ts
// What an operation is allowed to touch.
interface Grant {
  operations: AgentOperation[]         // 'edit' | 'create' | 'delete' | 'merge' | 'sync' | 'regen'
  languages: string[]                  // ['fr|en', ...] — reuse `${src}|${tgt}` convention; [] = all
  folderIds: string[]                  // scoped folders (+ descendants); [] = all
  deckIds:   string[]                  // scoped decks; [] = all
  dryRunOnly: boolean                  // true → operations may only PROPOSE, never apply
  expiresAt?: string | null
}

// Passed into every gateway call.
interface GatewayContext { userId: UserId; grant: Grant; actor: string /* agentId or 'user' */ }

// One proposed change (a change set is ChangeProposal[]).
interface ChangeProposal {
  cardId: CardId
  field: 'front' | 'back' | 'synonyms' | 'split' | 'merge' | 'delete'
  before: unknown
  after: unknown
  reason: string
}
```

### New module: `lib/agents/gateway.ts` (+ MCP wrapper `lib/agents/mcp/`)
Core op logic wraps the existing `lib/data` repos; the MCP wrapper re-exports
each op as an MCP tool (shared logic, two entry points: in-app runner + Claude
Code/Desktop). Each operation is a function taking `(ctx: GatewayContext, args)`:
- **reads:** `searchCards`, `getCard` (still scope-filtered so an agent can't
  read outside its grant).
- **mutations:** `editCardText`, `splitTranslation`, `mergeCards`, `addSynonym`,
  `createCard`, `deleteCard`, `triggerSync`, `regenerateDistractors`.

Every mutation:
1. asserts the op is in `grant.operations` and the card's deck/folder/pair is in scope (use `folderStats.descendantDeckIds` + the `${src}|${tgt}` key);
2. if `grant.dryRunOnly` → returns a `ChangeProposal` instead of writing;
3. else applies via the repo **and** writes an `agent_actions` row (before/after).

Scope helper: `isInScope(ctx.grant, deck)` — the single chokepoint.

### Migration `070_agent_actions.sql`
`agent_actions` audit table: `id, user_id, actor, operation, card_id (nullable),
deck_id, before jsonb, after jsonb, created_at`. Owner-RLS. (No grants table
yet — the `Grant` is passed in memory in Phases 1–2; it becomes persistent in
Phase 3.)

### Refactor
Point the mutation paths of the existing sync / distractor routes at the
gateway (start with card writes). Existing behavior unchanged; now audited.

### Tests
`lib/agents/__tests__/gateway.test.ts` — scope enforcement (in/out of grant),
dry-run produces proposals + writes nothing, audit row shape. Pure-ish: mock
the repos.

**Phase 1 decides NOTHING about which agents exist.** But naming the gateway
operations implicitly bounds what any future agent can do — so the op list is
the one thing to get roughly right here.

---

## Phase 2 — First agent (card-editor) + change-set review UI

Goal: ship the `salut = hi/hello` use case end-to-end, on top of Phase 1.

### Agent registry (THE extensibility point) — `lib/agents/registry.ts`
```ts
interface AgentConfig {
  id: string                 // 'card-editor'
  label: string
  model: string              // 'claude-opus-4-8' | 'claude-sonnet-5'
  systemPrompt: string
  tools: ToolName[]          // subset of gateway ops this agent may call
  defaultDryRun?: boolean
}
export const AGENTS: Record<string, AgentConfig> = { 'card-editor': {...} }
```
**Adding an agent later = adding one entry here** + a prompt + choosing a tool
subset. The runner is generic and never changes.

### Generic runner — `lib/agents/runner.ts`
A Claude tool-use loop: `run(config, ctx, task) → { proposals, summary, log }`.
It exposes `config.tools` as Claude tool definitions (JSON schema per op, from a
`TOOLS: Record<ToolName, {schema, fn}>` map), loops on tool calls against the
gateway with `ctx`, and collects proposals. Server-side only (API key).

### Change sets persisted — migration `071_change_sets.sql`
`change_sets (id, user_id, agent, status, summary, created_at)` +
`change_set_items (id, change_set_id, proposal jsonb, status)`. A dry-run agent
run writes a change set of `pending` items.

### API route — `app/api/agents/run/route.ts`
POST `{ agentId, grant, task }` → runs the agent, returns the change-set id.

### Review UI — `app/agents/review/[changeSetId]/page.tsx` (or a library modal)
Diff view of proposals (before → after, reason), approve/reject per item or all,
then "Apply approved" → gateway applies each approved proposal (this time for
real) and auto-enqueues `regenerateDistractors` for touched cards.

### The card-editor agent
Always dry-run — it only proposes a change set; nothing writes until you approve.
System prompt: find & fix multi-gloss / inconsistent cards. It leans on the
existing `detectSynonymSplit(front)` to spot `salut = hi/hello`-style cards, and
proposes split / pick-primary / make-synonym with reasons. Tools: `searchCards`,
`getCard`, `editCardText`, `splitTranslation`, `addSynonym`, `mergeCards`.

**Phase 2 START is where you decide the FIRST agent only** — its prompt + tool
subset (card-editor). You do NOT need the full roster yet.

---

## Phases 3+ (summarized — ask me to expand any of these)

- **Phase 3 — Persistent grants + permission UI.** `agent_grants` table; a
  checklist UI (languages / folders / decks / operations + dryRun + expiry),
  reusing the library tree. The in-memory `Grant` from Phases 1–2 becomes a
  saved, reusable object. *No new agent decisions here.*
- **Phase 4 — Job queue + inter-agent dispatch.** `edit_jobs` table + a
  `dispatch(agentId, task, scopeSubset)` gateway tool + a worker to drain the
  queue; `parent_job_id` traces chains (sync → card-gen → editor). **This is
  where you decide the preliminary ROSTER and the interaction graph** (which
  agent hands off to which), because chaining only exists here.
- **Phase 5 (optional) — Triggers.** Scheduled or event-triggered runs (e.g.
  auto-run the editor after a sync). *(The MCP-server part of the old Phase 5 was
  pulled forward into Phase 1 per the locked decisions above.)*

## When you decide on agents (answer to your question)
- **Phase 1:** nothing — pure infra. (Just sanity-check the gateway op list.)
- **Phase 2 start:** the **first** agent (card-editor): its prompt + tool subset.
- **Phase 4:** the **full preliminary roster** + how they hand off to each other.

## Extensibility guarantee
New agent = (1) one `AGENTS` registry entry, (2) a system prompt, (3) pick a
subset of already-built tools. The runner, gateway, audit, review UI, grants,
and job queue are all agent-agnostic and never change to add an agent.
