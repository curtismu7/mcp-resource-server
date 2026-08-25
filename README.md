# mcp-resource-server

A **banking MCP server** whose tools, data, resources and prompts are
defined by config files, not code. Switch it to another vertical by
changing one setting. Every answer comes from the server's own bundled
SQLite database — no backend service is involved. Bring your own PingOne
environment for tokens.

## Quick start

    cp .env.example .env

Edit `.env`: set `MCP_RESOURCE_SERVER_RESOURCE_URI`, `PINGONE_ENVIRONMENT_ID`
and `PINGONE_REGION` for your own PingOne environment. Leave `PINGONE_ISSUER`
commented out until you have real tokens (see "Auth modes").

    docker compose up --build

The server listens on `http://localhost:8081`, serving the `banking`
vertical. Its database is `./data/banking.db`, created and seeded at
startup from `verticals/banking/`; a restart never re-seeds a non-empty
table, so edits you make to the database stick.

## Switching vertical

    VERTICAL=healthcare docker compose up --build

Now `tools/list` shows the healthcare tools, `scopes_supported` is
`healthcare:read`, and the data comes from `./data/healthcare.db`. Nothing
else changes — same auth, same port, same endpoints. `VERTICAL` names a
folder under `verticals/`.

## What's in a vertical

    verticals/banking/
      vertical.json   # tools, resources, prompts
      schema.sql      # CREATE TABLE IF NOT EXISTS ...
      seed.json       # { "<table>": [ rows ] } — applied only to empty tables

A tool is an MCP tool definition plus the SQL that answers it:

    {
      "name": "get_account_balance",
      "description": "Current and available balance for one account.",
      "inputSchema": {
        "type": "object",
        "properties": { "account_id": { "type": "string", "description": "Account id, e.g. ACC-001" } },
        "required": ["account_id"]
      },
      "requiredScopes": ["banking:read"],
      "intentHints": ["what's my balance"],
      "sql": "SELECT id AS account_id, nickname, balance, available, currency FROM accounts WHERE id = :account_id",
      "result": "one"
    }

- `sql` — one `SELECT`. `:name` parameters are bound from the tool's
  arguments by name; a parameter with no argument binds `NULL`, so
  `LIMIT COALESCE(:limit, 20)` and `WHERE (:city IS NULL OR city = :city)`
  are the idioms for optional arguments. `limit` is clamped to 1–100.
- `result` — `"one"` returns the row (error if none); `"many"` returns
  `{ "items": [...], "count": n }`.
- `requiredScopes` — the bearer token must carry every scope listed.
  `scopes_supported` in `/.well-known/oauth-protected-resource` is derived
  from the catalog, so it always matches.
- `resources[]` expose a list tool as an MCP resource; `prompts[]` are
  user-message templates with `{{argument}}` placeholders.

The server validates the folder at startup and refuses to start on a bad
one, naming the file and tool: SQL that isn't a `SELECT`, SQL that doesn't
prepare against `schema.sql`, a required argument with no `:param`, a
duplicate name, a seed table the schema doesn't create.

## Adding a vertical

1. Copy `verticals/healthcare/` to `verticals/<name>/`.
2. Write `schema.sql` and `seed.json` for your data.
3. Write the tools in `vertical.json` — one `SELECT` each.
4. `VERTICAL=<name> docker compose up --build`.

`npm test` runs every tool of every folder under `verticals/` against its
own seed and fails on one that returns nothing.

## Kubernetes (Helm)

A chart lives in `helm/mcp-resource-server/`. The image is published by
GitHub Actions to `ghcr.io/curtismu7/mcp-resource-server` on every push to
`main` (`latest`, `sha-<short>`) and on `v*` tags.

    helm install mcp helm/mcp-resource-server \
      --set ingress.enabled=true --set ingress.host=mcp.example.com \
      --set pingone.environmentId=<env-id> --set pingone.region=com

`resourceUri` (the audience inbound tokens must carry) defaults to
`https://<ingress.host>`; set it explicitly when you run without an ingress.
Set `pingone.issuer` (`https://auth.pingone.<region>/<env-id>/as`) to verify
token signatures; until then `strictAuth` decides whether unverifiable
tokens are accepted (see "Auth modes"). No Secrets are needed: the server
only verifies tokens. Ingress defaults are for an nginx controller
(`className: nginx-public`, buffering off, long read timeout — MCP streams
hold responses open).

Switch vertical without a new image:

    helm upgrade mcp helm/mcp-resource-server --reuse-values --set vertical=healthcare

Add a vertical without a new image — the three files go in values and are
mounted next to the built-in ones:

    verticals:
      retail:
        vertical.json: |
          { "name": "retail", "resourceName": "Retail MCP Server", "tools": [ ... ] }
        schema.sql: |
          CREATE TABLE IF NOT EXISTS orders ( ... );
        seed.json: |
          { "orders": [ ... ] }

    helm upgrade mcp helm/mcp-resource-server --reuse-values -f retail-values.yaml --set vertical=retail

The database is an `emptyDir` seeded at startup; set `persistence.enabled=true`
for a PVC if edits made to the database must survive a restart. While the
GHCR package is private, create a pull secret and set `imagePullSecrets`.
`npm test` renders the chart with `helm template` and checks the manifests
when helm is installed.

## Banking tools (default)

| Tool | Arguments |
|---|---|
| `list_accounts` | — |
| `get_account` | `account_id` |
| `get_account_balance` | `account_id` |
| `list_transactions` | `account_id`, `limit?` |
| `search_transactions` | `query`, `limit?` |
| `list_cards` | — |
| `get_statement` | `account_id`, `period` (`YYYY-MM`) |
| `find_branches` | `city?`, `zip?` |

Seeded accounts: `ACC-001` checking, `ACC-002` savings, `ACC-003` money
market, `ACC-004` credit card; statements for `2026-06` and `2026-07`.

## Verify it's running

    curl -s http://localhost:8081/health
    curl -s http://localhost:8081/.well-known/oauth-protected-resource

## Auth modes

Whether a token's signature is verified is decided by whether a JWKS source
is configured — not by `STRICT_AUTH`:

- **JWKS source set** (`PINGONE_ISSUER`, `PINGONE_JWKS_URI`, or
  `PINGONE_BASE_URL`) — every token is verified against your PingOne
  environment's keys and rejected on failure. `STRICT_AUTH` has no effect.
  Run this way once real tokens are flowing.
- **No JWKS source** — `STRICT_AUTH=false` (the shipped default) accepts a
  well-formed token with a console warning, so you can exercise every tool
  with a hand-made token before PingOne is wired up; `STRICT_AUTH=true`
  rejects every token instead. Do not leave the default reachable by more
  than you.

`.env.example` ships with all three JWKS variables commented out for that
reason — uncomment one when you have real tokens.

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
const payload = b64({sub:'test-user',scope:'banking:read',aud:'your-resource-uri',exp:Math.floor(Date.now()/1000)+3600});
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
  -d "scope=<space-separated scopes, e.g. banking:read>" \
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
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_accounts","arguments":{}}}'
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
