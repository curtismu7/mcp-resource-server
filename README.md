# mcp-resource-server

An MCP server exposing read-mostly tools across ten mock verticals (banking,
healthcare, government, manufacturing, retail, sporting-goods, university,
workforce, Abercrombie & Fitch, airlines) plus a set of investment tools.
Every vertical reads its own bundled SQLite database — no other service is
required to run it. Investment tools can optionally proxy to a banking API
you supply instead (see below).

## Prerequisites

- Docker + Docker Compose
- A PingOne environment to mint and verify bearer tokens (or any OAuth AS
  that can issue a JWT with the right `aud`/`scope` claims and publish a JWKS
  endpoint — this server only relies on standard OIDC discovery, not
  anything PingOne-specific)

## Quick start

```bash
cp .env.example .env
```

Edit `.env`: set `MCP_RESOURCE_SERVER_RESOURCE_URI`, `PINGONE_ENVIRONMENT_ID`,
`PINGONE_REGION`, and `PINGONE_ISSUER` for your own PingOne environment.

```bash
docker compose up --build
```

The server listens on `http://localhost:8081`. SQLite databases persist in
`./data` (seeded on first boot from `seed/`; a restart never re-seeds a
non-empty database).

## Verify it's running

```bash
curl http://localhost:8081/health
curl http://localhost:8081/.well-known/oauth-protected-resource
```

The second call returns the resource's advertised scopes and, if
`PINGONE_ENVIRONMENT_ID`/`PINGONE_REGION` are set, its authorization server —
this is the RFC 9728 metadata an MCP client uses for OAuth discovery.

## Auth modes

- **`STRICT_AUTH=false`** (default) — a token whose signature can't be
  verified is accepted anyway, with a console warning. Lets you exercise
  every tool before PingOne is fully wired up. Do not leave this on for
  anything reachable by more than you.
- **`STRICT_AUTH=true`** — tokens are rejected outright unless their
  signature verifies against your PingOne environment's JWKS
  (`PINGONE_ISSUER`, `PINGONE_JWKS_URI`, or `PINGONE_BASE_URL` — set one).

## Getting a bearer token

Every tool call needs a bearer token whose `aud` claim matches
`MCP_RESOURCE_SERVER_RESOURCE_URI` and whose `scope` claim covers the tool
you're calling (see `tools/list` for the authoritative, current list — it's
generated from this server's own registry).

**Local testing (`STRICT_AUTH=false`)** — any well-formed JWT with the right
claims works; the signature isn't checked.

```bash
node -e "
const b64 = s => Buffer.from(JSON.stringify(s)).toString('base64url');
const header = b64({alg:'none',typ:'JWT'});
const payload = b64({sub:'test-user',scope:'airlines:read',aud:'your-resource-uri',exp:Math.floor(Date.now()/1000)+3600});
console.log(header+'.'+payload+'.');
"
```

(swap `aud` for your own `MCP_RESOURCE_SERVER_RESOURCE_URI` value, and
`scope` for whatever tool(s) you're testing)

**Real tokens (`STRICT_AUTH=true`)** — mint one from your PingOne
environment. A client-credentials grant against your PingOne token endpoint,
requesting this server's audience as the resource:

```bash
curl -s -X POST "https://auth.pingone.<region>/<env-id>/as/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=<your PingOne worker app client id>" \
  -d "client_secret=<your PingOne worker app client secret>" \
  -d "scope=<space-separated scopes, e.g. banking:read airlines:read>" \
  -d "resource=<MCP_RESOURCE_SERVER_RESOURCE_URI value>"
```

This requires that client's app to be authorized for this resource and
those scopes in PingOne (Applications → your app → Resources) — a
PingOne-side setup step this server doesn't do for you.

## Calling a tool directly (sanity check)

```bash
TOKEN="<paste a token from above>"
curl -s -X POST http://localhost:8081/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_airline_bookings","arguments":{}}}'
```

## Connecting an MCP client

The server speaks MCP over both WebSocket and HTTP (streamable, `POST /mcp`)
on the same port — `ws://localhost:8081` or `http://localhost:8081/mcp`.

**MCP Inspector** (the official dev tool — works with any server and lets
you set a manual header, so it's the most reliable way to test this one):

```bash
npx @modelcontextprotocol/inspector
```

Set Transport to "Streamable HTTP", URL to `http://localhost:8081/mcp`, and
add an `Authorization: Bearer <token>` header in the Inspector's connection
settings before connecting.

**Claude Desktop / Cursor / Windsurf** (static config, HTTP transport):

```json
{
  "mcpServers": {
    "mcp-resource-server": {
      "url": "http://localhost:8081/mcp",
      "transport": "http"
    }
  }
}
```

- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Cursor: `.cursor/mcp.json` in your project root
- Windsurf: `~/.codeium/windsurf/mcp_config.json`

These configs have no field for a static bearer token — when the client
calls a protected tool it reads `/.well-known/oauth-protected-resource`,
finds your PingOne environment as the authorization server, and prompts you
to sign in. That only works once your PingOne environment has an OAuth
client registered for that specific MCP client app, using the redirect URI
that client's own docs specify — a PingOne-side setup step outside this
server. Restart the client after editing its config.

## Investment tools

`get_investment_accounts`, `get_investment_balance`, `get_portfolio_summary`,
and `get_investment_transactions` work out of the box from a bundled SQLite
database (`data/invest.db`, seeded from `seed/invest.seed.json` on first
boot), exactly like every other vertical.

Set `BANKING_API_BASE_URL` only if you run a banking API of your own and want
these four tools to forward the caller's bearer token to it and return
whatever it returns. With it set, the bundled invest database is not used.

## Adding a tool

Tools are code, not config. The catalog (`tools/list`), the per-tool scope
gate, and the `scopes_supported` advertised in
`/.well-known/oauth-protected-resource` are all derived from `ALL_TOOLS` in
`src/tools/registry.ts`, so a tool you add to a vertical's list is live
everywhere once you rebuild the image (the `--build` command in Quick start).

### 1. Add a tool to an existing vertical

Two edits, no registry change:

1. Append a tool definition to that vertical's `src/tools/<vertical>Tools.ts`
   array, e.g. in `sportingGoodsTools.ts`:

   ```ts
   {
     name: 'gear_return_status',
     description: 'Show the status of a sporting-goods return.',
     inputSchema: {
       type: 'object',
       properties: { orderId: { type: 'string', description: 'Order ID' } },
       required: ['orderId'],
     },
     requiredScopes: ['read'],   // the bearer token must carry every scope listed
     readOnly: true,
     intentHints: ['check my gear return'],   // required — tests/registry.test.ts asserts it
   },
   ```

2. Add a matching `case 'gear_return_status':` to the `switch` in
   `src/tools/<vertical>ToolHandler.ts`. The handler just returns JSON —
   read from that vertical's `src/db/<vertical>Db.ts`, or anything else.

### 2. Add a new vertical

Same two files as above (`src/tools/<vertical>Tools.ts` exporting a
`<VERTICAL>_TOOLS: McpToolDef[]`, and `src/tools/<vertical>ToolHandler.ts`
exporting `dispatch<Vertical>Tool`), plus:

- **Data** (optional): `src/db/<vertical>Db.ts` + `seed/<vertical>.seed.json`.
  Copy `sportingGoodsDb.ts` — it opens `data/<vertical>.db`, creates the
  schema, and applies the seed only when the tables are empty. `Dockerfile`
  already copies `seed/`, and the compose file already mounts `data/`.
- **Register** in `src/tools/registry.ts`: import the two exports, spread
  `<VERTICAL>_TOOLS` into `ALL_TOOLS`, add a
  `const <VERTICAL>_TOOL_NAMES = new Set(<VERTICAL>_TOOLS.map((t) => t.name))`,
  and one line in `dispatch()`:
  `if (<VERTICAL>_TOOL_NAMES.has(toolName)) return dispatch<Vertical>Tool(toolName, args);`

### Things that bite

- `requiredScopes` must be scopes your PingOne resource actually grants.
  A token missing any of them gets 403 on `tools/call`, and `tools/list`
  hides the tool from that token entirely.
- Tool names are global. `dispatch()` routes by the first name set that
  matches, so a name reused across two verticals silently goes to whichever
  is checked first.
- Use a data-backed vertical (e.g. sporting-goods) as the template, not
  invest — invest is the `dispatch()` fallthrough and carries a
  proxy-vs-SQLite switch you don't need.
