# Config-driven vertical MCP server — design

**Date:** 2026-08-24 · **Repo:** curtismu7/mcp-resource-server · **Status:** approved design, pre-implementation

## Goal

Make this a **banking MCP server** whose tools and data are defined by
**config files, not code**, so an operator can switch the server to
represent another vertical (healthcare is the shipped example) by changing
one setting. All data is served by the MCP server itself from bundled
SQLite; no backend/BFF is involved.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| What does config own? | Everything per vertical: tool catalog, schemas, scopes, SQL, seed data. No code per vertical. |
| Where does it live? | This repo only. AI-DEMO2's `demo_mcp_resource_server` is unchanged. |
| How does a tool map to data? | A parameterised SQL `SELECT` per tool, named params bound from tool args. |
| Writes? | No. Read-only server; enforced by a read-only SQLite connection. |
| What ships? | `banking` (full, default) and `healthcare` (worked example). The other verticals are removed from this repo. |
| Approach | Thin engine inside the existing server; `src/index.ts` (auth, transport, metadata, resources) is kept. |
| Active verticals | Exactly one at a time, chosen by `VERTICAL`. |

## Layout

```
verticals/
  banking/
    vertical.json     # name, resourceName, tools[], resources[]
    schema.sql        # CREATE TABLE IF NOT EXISTS ...
    seed.json         # { "<table>": [ {row}, ... ] } — one array per table
  healthcare/
    vertical.json
    schema.sql
    seed.json
```

Selected by `VERTICAL` (env; default `banking`). `docker-compose.yml` passes
it through. The database lives at `data/<VERTICAL>.db`.

### `vertical.json`

```json
{
  "name": "banking",
  "resourceName": "Banking MCP Server",
  "tools": [
    {
      "name": "get_account_balance",
      "description": "Current balance and available funds for one account.",
      "inputSchema": {
        "type": "object",
        "properties": { "account_id": { "type": "string", "description": "Account id, e.g. ACC-001" } },
        "required": ["account_id"]
      },
      "requiredScopes": ["banking:read"],
      "intentHints": ["what's my balance", "how much is in checking"],
      "sql": "SELECT id, nickname, balance, available, currency FROM accounts WHERE id = :account_id",
      "result": "one"
    }
  ],
  "resources": [
    {
      "uri": "banking://accounts",
      "name": "Bank Accounts",
      "description": "All accounts for the customer",
      "mimeType": "application/json",
      "requiredScope": "banking:read",
      "uriTemplate": "banking://accounts/{account_id}",
      "templateName": "Bank Account",
      "listTool": "list_accounts"
    }
  ]
}
```

Tool fields are today's `McpToolDef` (`name`, `description`, `inputSchema`,
`requiredScopes`, `readOnly` implied `true`, `intentHints`) plus:

- `sql` — one SQLite `SELECT`. Named parameters (`:account_id`) are bound
  from the tool's arguments by name; an argument not named in the SQL is
  ignored; a parameter with no argument binds `NULL`.
- `result` — `"one"` returns the single row as the tool result (error if no
  row); `"many"` returns `{ "items": rows, "count": n }`.

Resource entries use the same shape as the current hand-maintained
`RESOURCE_CATALOG` in `src/index.ts`. `resources/read` serves the exact
`uri` (via `listTool`); `uriTemplate` entries are advertised by
`resources/templates/list` but are not readable — the same as the server
before this change.

`limit`: a tool that accepts `limit` declares it in `inputSchema` and uses
`LIMIT COALESCE(:limit, 20)`; the engine clamps a supplied value to 1–100
before binding (same rule the invest tools had).

## Engine

Three modules replace `src/tools/registry.ts`, the 22 `src/tools/*Tools.ts`
/ `*ToolHandler.ts` files and the 11 `src/db/*Db.ts` files.

### `src/vertical/load.ts`

`loadVertical(name): Vertical` reads `verticals/<name>/` and validates it.
Any failure exits the process at startup with the file and tool named:

- folder or any of the three files missing
- tool without `sql` or `result`, or `result` not `one|many`
- duplicate tool name; duplicate resource uri; `listTool` naming no tool
- `inputSchema.required` entry with no matching `:param` in `sql`
- `sql` that fails to `prepare()` against `schema.sql` (opened on an
  in-memory database at validation time)
- `sql` whose first keyword is not `SELECT` (belt; the read-only
  connection is the braces)

### `src/vertical/db.ts`

- `openForSeed(path)` — read-write; applies `schema.sql`; for each table in
  `seed.json`, inserts rows **only when the table is empty**. Runs once at
  startup (so "seeded on first boot" is true, and an out-of-band edit is
  never clobbered).
- `run(sql, params)` — opens `data/<vertical>.db` with `readOnly: true`,
  prepares, binds, returns rows, closes. Per-call open, as today, so
  external edits are visible immediately.

### `src/tools/registry.ts`

Same exports `src/index.ts` already consumes, backed by the loaded vertical:

- `ALL_TOOLS: McpToolDef[]`, `SUPPORTED_SCOPES: string[]`, `findTool(name)`
- `RESOURCE_CATALOG: ResourceDef[]` (new export; `index.ts` stops
  hard-coding it)
- `RESOURCE_NAME_DEFAULT` (from `resourceName`; `MCP_SERVER_RESOURCE_NAME`
  still overrides)
- `dispatch(toolName, args, token, subject)` — check every `required`
  argument is present, clamp `limit`, bind, `run`, shape per `result`.

### `src/index.ts` changes

- `RESOURCE_CATALOG` and the resource-name default come from the registry.
- Remove: the airlines completion hook (`resolvePassenger`/`listBookings`),
  the `/invest` API-key route and its `apiKeyMatches` helper, the
  `MCP_RESOURCE_SERVER_API_KEY` warning, `api_key` from `/health.authMethods`.
- Everything else — bearer validation, JWKS/`STRICT_AUTH`, accepted
  audiences, RFC 9728 metadata and challenge, WebSocket + streamable HTTP,
  logging, hop tracing — is untouched.

## Shipped verticals

### banking (default)

Tables: `accounts` (4: checking, savings, money market, credit card),
`transactions` (~60 across accounts, Jun–Aug 2026, with running balance),
`cards` (2), `statements` (8 = 2 periods × 4 accounts), `branches` (6).

| Tool | Args | Result |
|---|---|---|
| `list_accounts` | — | many |
| `get_account` | `account_id` | one |
| `get_account_balance` | `account_id` | one |
| `list_transactions` | `account_id`, `limit?` | many |
| `search_transactions` | `query` (merchant or category, `LIKE`), `limit?` | many |
| `list_cards` | — | many |
| `get_statement` | `account_id`, `period` (`YYYY-MM`) | one |
| `find_branches` | `city?`, `zip?` | many |

All `banking:read`. Resources: `banking://accounts` (+ `{account_id}`),
`banking://cards`.

### healthcare (worked example)

Tables: `patients` (1), `records` (5), `appointments` (4), `prescriptions` (3).
Tools: `view_records` (many), `get_record` (`record_id`, one),
`list_appointments` (many), `list_prescriptions` (many). All
`healthcare:read`. Resource: `healthcare://records` (+ `{record_id}`).

Seed dates are fixed (Jun–Aug 2026); nothing is computed from "now".

## Auth

Unchanged. `scopes_supported` is derived from the loaded vertical's tools.

## Errors

| Condition | Behaviour |
|---|---|
| Invalid config | `process.exit(1)` at startup, message names `verticals/<v>/vertical.json` and the tool |
| Missing required argument | thrown → MCP `isError:true`, text `missing required argument: <name>` |
| `result: "one"`, no row | thrown → `isError:true`, text `not found: <param>=<value>` |
| Unknown tool, insufficient scope, bad token | existing JSON-RPC / HTTP paths, unchanged |

## Testing

- `tests/vertical/load.test.ts` — one case per validation failure above,
  plus a good load.
- `tests/vertical/db.test.ts` — seed-once (edit survives reopen), read-only
  connection refuses a write, per-call visibility of external edits.
- `tests/vertical/dispatch.test.ts` — `one`/`many` shaping, named binding,
  `limit` clamp, missing arg, not-found.
- `tests/verticals.test.ts` — for **each** folder under `verticals/`: load
  it, and call every tool with example arguments taken from its own seed
  (first row of the table the required param names), asserting a non-empty
  result. Adding a broken tool to a config fails CI.
- `tests/swap.test.ts` — boot with `VERTICAL=healthcare`: `tools/list` is
  the healthcare set and `scopes_supported` is `["healthcare:read"]`.
- Existing `httpMcp`, `resources`, `acceptedAudiences`, `resourceUriEnv`,
  `mcpLogging`, `transactionHop`, `modernNegotiation` suites kept, tool
  names re-pointed at banking.
- Live: `docker build`, run per README, call every banking tool with the
  README's hand-made token; repeat with `VERTICAL=healthcare`.

## Removed from this repo

- `src/tools/*Tools.ts`, `src/tools/*ToolHandler.ts` (22 files); `src/tools/toolTypes.ts` moves to `src/vertical/types.ts`
- `src/db/*Db.ts` (11 files)
- `seed/*.seed.json`, `seed/parity-cases.json`, `seed/abercrombie-fitch.mock.json`, `scripts/gen-seeds-from-bff.mjs`, `tests/seedParity.test.ts`, `tests/*Db.test.ts`, `tests/*Tools*.test.ts`, `tests/investToolHandler.test.ts`, `tests/investSqlite.test.ts`, `tests/insertIdSqlMax.test.ts`, `tests/mockData.test.ts`
- `data/airlines.db` (tracked binary); `data/` becomes gitignored
- `openapi/` (describes the invest proxy only) and its `COPY` in the Dockerfile
- `axios` dependency (invest proxy only)
- README rewritten: one vertical, chosen by config; how to write a vertical folder

## Out of scope

Writes; several verticals live at once; any OAuth/PingOne change; the
AI-DEMO2 copy of this server; porting the other nine verticals (they can be
written as folders later using the healthcare one as the template).

## Amendments

- 2026-08-24 (plan): `prompts[]` is part of `vertical.json` — `{ name, description, arguments[], template }`, where `template` is the user message and `{{arg}}` placeholders are filled from `prompts/get` arguments. `completion/complete` always returns an empty list. This replaces the airlines-specific prompt and completion hook that were in `src/index.ts`.
- 2026-08-24 (final review): `resources/read` serves exact resource URIs only; template URIs are advertised, not readable (matches the pre-existing server behaviour).
