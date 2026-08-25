'use strict';

/**
 * banking-mcp-resource-server — entry point
 *
 * MCP server for ten mock verticals plus investment tools. Runs over WebSocket
 * (same protocol as banking_mcp_server) and HTTP. Validates inbound token aud
 * against MCP_RESOURCE_SERVER_RESOURCE_URI — a comma-separated ACCEPTED list
 * whose first entry is this server's canonical resource URI (in the AI-DEMO2
 * stack: mcp-invest.ping.demo, the PingOne "Demo MCP Invest" resource).
 *
 * Every vertical is served from this server's own SQLite database (src/db/).
 * Which vertical is served is chosen by VERTICAL (src/tools/registry.ts).
 *
 * HTTP surfaces (same port):
 *   GET  /.well-known/oauth-protected-resource  — RFC 9728 metadata
 *   GET  /health
 *   POST /mcp                                   — MCP JSON-RPC (for PingGateway,
 *                                                 which has no WS listener)
 *
 * Start: MCP_RESOURCE_SERVER_RESOURCE_URI=mcp-invest.ping.demo node dist/index.js
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  LEGACY_RESOURCE_URI_ENV,
  RESOURCE_URI_ENV,
  resolveAcceptedAudiences,
  resolveResourceUriEnv,
} from './server/acceptedAudiences';

import { createServer, IncomingMessage, ServerResponse } from 'http';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { filterByScopes } from './vertical/types';
import {
  ALL_TOOLS, PROMPTS, RESOURCE_CATALOG, RESOURCE_NAME_DEFAULT, SUPPORTED_SCOPES, VERTICAL, dispatch, findTool,
} from './tools/registry';
import { decodeAndValidate, extractScopes, TokenError } from './server/tokenValidator';
import { isValidLogLevel, emitLogMessage, LoggingState } from './mcpLogging';
import { buildDiscoverResult, SUPPORTED_PROTOCOL_VERSIONS } from './serverDiscover';
import { extractRequestedProtocolVersion, buildUnsupportedProtocolVersionError } from './modernNegotiation';
import { emitHop } from './transactionHop';

// MCP Prompts capability — templates come from the active vertical's
// vertical.json (prompts[]); {{arg}} placeholders are filled from
// prompts/get arguments.
// ---------------------------------------------------------------------------

// Security guard: SKIP_TOKEN_SIGNATURE_VALIDATION downgrades JWT signature
// verification to a warning (tokenValidator.ts) and must never run in production.
// Fail fast at startup so a misconfigured deploy can't silently accept forged
// tokens — matches demo_api_server/server.js and demo_mcp_server.
if (process.env.SKIP_TOKEN_SIGNATURE_VALIDATION === 'true' && process.env.NODE_ENV === 'production') {
  console.error('[invest][FATAL] SKIP_TOKEN_SIGNATURE_VALIDATION=true is not allowed in production. Remove this env var before deploying.');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '8081', 10);
const HOST = process.env.HOST || '0.0.0.0';
// The accepted-audience list may be comma-separated (RFC 8693 rollout). The
// FIRST entry is this server's canonical resource URI (RFC 9728 metadata,
// health, logs); the full list feeds aud validation.
const RESOURCE_URI_ENV_VALUE = resolveResourceUriEnv();
const RESOURCE_URI_LIST = resolveAcceptedAudiences(RESOURCE_URI_ENV_VALUE.value, RESOURCE_URI_ENV_VALUE.source);
const RESOURCE_URI = RESOURCE_URI_LIST[0];
// Reading the shared banking name still works, but say so — that is the
// deployment shape T4 exists to retire (shared k8s configmap fanned into this
// server via envFrom).
if (RESOURCE_URI_ENV_VALUE.source === LEGACY_RESOURCE_URI_ENV) {
  console.warn(
    `[demo-mcp-resource-server] WARNING: falling back to '${LEGACY_RESOURCE_URI_ENV}', which is the ` +
    `BANKING MCP server's audience list elsewhere. Set '${RESOURCE_URI_ENV}' for this server instead.`
  );
}
const ACCEPTED_AUDIENCES = RESOURCE_URI_LIST.join(',');
const RESOURCE_NAME = process.env.MCP_SERVER_RESOURCE_NAME || RESOURCE_NAME_DEFAULT;
console.log(`[mcp-resource-server] vertical "${VERTICAL.name}" — ${ALL_TOOLS.length} tools, ${RESOURCE_CATALOG.length} resources, ${PROMPTS.length} prompts`);

// Startup env validation
if (!RESOURCE_URI_ENV_VALUE.value) {
  console.warn(
    `[demo-mcp-resource-server] WARNING: ${RESOURCE_URI_ENV} is not set — ` +
    `using default '${RESOURCE_URI}'. Token audience validation may fail. ` +
    `Set ${RESOURCE_URI_ENV} in this server's .env`
  );
}

const PINGONE_ENV_ID = process.env.PINGONE_ENVIRONMENT_ID || '';
const PINGONE_REGION = process.env.PINGONE_REGION || 'com';

// SUPPORTED_SCOPES is derived from the active vertical's tool catalog
// (tools/registry.ts), so a client reading this RFC 9728 metadata only ever
// sees a scope that actually unlocks a tool.

/** Cap on a single HTTP MCP request body — a tool call is a few hundred bytes. */
const MAX_MCP_BODY_BYTES = 256 * 1024;

/**
 * Extract a bearer token from an Authorization header. Shared by both
 * transports so the HTTP path can never diverge from the WebSocket one on
 * something as easy to get subtly wrong as header parsing.
 */
function bearerFrom(header: string | string[] | undefined): string {
  const parts = String(header || '').split(' ');
  return parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : '';
}

// ---------------------------------------------------------------------------
// HTTP: RFC 9728 metadata + health + MCP (JSON-RPC over POST)
// ---------------------------------------------------------------------------

// RFC 9728 §5.1: resource_metadata must be a URL the client can fetch, so it is
// built from the request's own host — RESOURCE_URI is the token audience and
// need not be a URL at all.
function resourceMetadataUrl(req: IncomingMessage): string {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}/.well-known/oauth-protected-resource`;
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url || '/';

  if (url === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
    const asList = PINGONE_ENV_ID
      ? [`https://auth.pingone.${PINGONE_REGION}/${PINGONE_ENV_ID}/as`]
      : [];
    const metadata: Record<string, unknown> = {
      resource: RESOURCE_URI,
      bearer_methods_supported: ['header'],
      scopes_supported: SUPPORTED_SCOPES,
      resource_name: RESOURCE_NAME,
      resource_documentation: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization',
    };
    if (asList.length) metadata.authorization_servers = asList;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify(metadata, null, 2));
    return;
  }

  if (url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'banking-mcp-resource-server',
      uptime: process.uptime(),
      resourceUri: RESOURCE_URI,
      vertical: VERTICAL.name,
      authMethods: ['bearer_token'],
    }));
    return;
  }

  // HTTP MCP — JSON-RPC over POST.
  //
  // The WebSocket transport below is the original one, but PingGateway/IG has no
  // WebSocket listener, so an IG-fronted deployment could not reach these tools
  // at all (its /mcp/invest route proxied to an endpoint that 404'd). This runs
  // the SAME handleMessage as the WS path, so audience validation and the
  // per-tool scope gate are identical by construction, not by duplication.
  if (url === '/mcp' && req.method === 'POST') {
    const token = bearerFrom(req.headers['authorization']);
    if (!token) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="banking-mcp-resource-server", error="invalid_token", error_description="Bearer token required", resource_metadata="${resourceMetadataUrl(req)}"`,
      });
      res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Bearer token required' }));
      return;
    }

    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_MCP_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      // MCP Streamable HTTP transport: the server MAY assign a session id on
      // initialize. Read once `body` is fully accumulated (not `s`, the
      // outbound body) so it's known before the response is written.
      let sessionIdForInitialize: string | undefined;
      try {
        if (JSON.parse(body).method === 'initialize') sessionIdForInitialize = crypto.randomUUID();
      } catch { /* malformed body — handleMessage below reports the parse error */ }

      let replied = false;
      const send = (s: string): void => {
        if (replied) return;
        replied = true;
        // RFC 6750 §3.1: scope violations on HTTP MUST return 403, not 200.
        // WebSocket callers get the JSON-RPC error body unchanged (no HTTP status after handshake).
        let isInsufficientScope = false;
        let scopeHint = '';
        try {
          const parsed = JSON.parse(s);
          if (parsed?.error?.code === -32005) {
            isInsufficientScope = true;
            const d = parsed.error.data;
            const scopes: string[] = d?.requiredScopes ?? (d?.requiredScope ? [d.requiredScope] : []);
            if (scopes.length) scopeHint = `, scope="${scopes.join(' ')}"`;
          }
        } catch { /* ok — malformed body goes through as 200 */ }
        // MCP spec 2026-07-28 Streamable HTTP §Protocol Version Header:
        // UnsupportedProtocolVersionError MUST ride HTTP 400, not 200.
        let isUnsupportedProtocolVersion = false;
        try {
          const parsed = JSON.parse(s);
          isUnsupportedProtocolVersion = parsed?.error?.code === -32022;
        } catch { /* ok — malformed body goes through as 200 */ }
        // RFC 6750 §3.1: an invalid/expired/malformed token MUST return 401,
        // same as the missing-bearer case above — not 200 with the failure
        // buried in the JSON-RPC body. TokenError (tokenValidator.ts) always
        // surfaces as -32001.
        let isInvalidToken = false;
        try {
          const parsed = JSON.parse(s);
          isInvalidToken = parsed?.error?.code === -32001;
        } catch { /* ok — malformed body goes through as 200 */ }
        const sessionHeader = sessionIdForInitialize ? { 'mcp-session-id': sessionIdForInitialize } : {};
        if (isInsufficientScope) {
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer realm="banking-mcp-resource-server", error="insufficient_scope"${scopeHint}, resource_metadata="${resourceMetadataUrl(req)}"`,
            ...sessionHeader,
          });
        } else if (isUnsupportedProtocolVersion) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...sessionHeader });
        } else if (isInvalidToken) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer realm="banking-mcp-resource-server", error="invalid_token", resource_metadata="${resourceMetadataUrl(req)}"`,
            ...sessionHeader,
          });
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', ...sessionHeader });
        }
        res.end(s);
      };
      handleMessage(body, token, send)
        .then(() => {
          // A notification (e.g. notifications/initialized) produces no response.
          if (!replied) { res.writeHead(202); res.end(); }
        })
        .catch((err) => {
          console.error('[mcp-resource-server] HTTP MCP handler error:', err);
          if (!replied) {
            replied = true;
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(rpcError(null, -32603, 'Internal error'));
          }
        });
    });
    return;
  }

  res.writeHead(404);
  res.end();
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function rpcError(id: unknown, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

// ---------------------------------------------------------------------------
// MCP message handler
// ---------------------------------------------------------------------------

async function handleMessage(
  rawMsg: string,
  token: string,
  send: (s: string) => void,
  // MCP spec: logging capability. On WS this is one box per connection; on
  // HTTP (stateless, one request per handleMessage call) a fresh empty box
  // is passed each time, so logging/setLevel has no effect beyond that
  // single call — an honest limitation of a one-shot transport, not a bug.
  loggingState: LoggingState = {},
): Promise<void> {
  let msg: any;
  try { msg = JSON.parse(rawMsg); } catch { send(rpcError(null, -32700, 'Parse error')); return; }

  const { method, id } = msg;

  if (method === 'initialize') {
    send(rpcResult(id, {
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: {},
        resources: { subscribe: false, listChanged: false },
        logging: {},
        prompts: { listChanged: false },
        completions: {},
      },
      serverInfo: { name: 'banking-mcp-resource-server', version: '1.0.0' },
    }));
    return;
  }

  if (method === 'notifications/initialized') return;

  // MCP spec 2026-07-28: per-request version negotiation. A Modern request
  // declares its version in params._meta instead of an initialize
  // handshake. This server doesn't implement Modern behavior yet — reject
  // cleanly rather than silently running Legacy semantics a Modern caller
  // never agreed to. server/discover is exempt — its whole purpose is
  // answering regardless of what version the caller claims.
  if (method !== 'server/discover') {
    const requestedVersion = extractRequestedProtocolVersion(msg.params);
    if (requestedVersion !== undefined && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requestedVersion)) {
      send(JSON.stringify(buildUnsupportedProtocolVersionError(id, requestedVersion, SUPPORTED_PROTOCOL_VERSIONS)));
      return;
    }
  }

  // MCP spec 2026-07-28: server/discover — servers MUST implement it. Same
  // identity/capabilities as the initialize handler above.
  if (method === 'server/discover') {
    send(rpcResult(id, buildDiscoverResult(
      {
        tools: {},
        resources: { subscribe: false, listChanged: false },
        logging: {},
        prompts: { listChanged: false },
        completions: {},
      },
      { name: 'banking-mcp-resource-server', version: '1.0.0' },
    )));
    return;
  }

  if (method === 'prompts/list') {
    send(rpcResult(id, {
      prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
    }));
    return;
  }

  if (method === 'prompts/get') {
    const name = msg.params?.name;
    const promptArgs: Record<string, unknown> = msg.params?.arguments || {};
    const prompt = PROMPTS.find((p) => p.name === name);
    if (!prompt) {
      send(rpcError(id, -32602, `Unknown prompt: ${name}`));
      return;
    }
    const text = prompt.template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_m, arg: string) => {
      const v = promptArgs[arg];
      return typeof v === 'string' && v ? v : `(unspecified ${arg})`;
    });
    send(rpcResult(id, {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    }));
    return;
  }

  // MCP Completion capability: this server has no argument autocompletion
  // sources, so every request gets an empty list — the spec treats "nothing
  // to suggest" as a normal result, not an error.
  if (method === 'completion/complete') {
    send(rpcResult(id, { completion: { values: [], total: 0, hasMore: false } }));
    return;
  }

  if (method === 'logging/setLevel') {
    const level = msg.params?.level;
    if (!isValidLogLevel(level)) {
      send(rpcError(id, -32602, 'Invalid params: level must be one of the RFC 5424 severities'));
      return;
    }
    loggingState.level = level;
    send(rpcResult(id, {}));
    return;
  }

  if (method === 'tools/list') {
    let decoded;
    try { decoded = await decodeAndValidate(token, ACCEPTED_AUDIENCES); } catch (e) {
      const te = e as TokenError;
      send(rpcError(id, -32001, te.message));
      return;
    }
    const scopes = extractScopes(decoded);
    const tools = filterByScopes(ALL_TOOLS, scopes).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      requiredScopes: t.requiredScopes,
      readOnly: t.readOnly,
      ...(t.intentHints ? { intentHints: t.intentHints } : {}),
    }));
    send(rpcResult(id, { tools }));
    return;
  }

  if (method === 'tools/call') {
    const toolName: string = msg.params?.name || '';
    const args: Record<string, unknown> = msg.params?.arguments || {};

    let decoded;
    try { decoded = await decodeAndValidate(token, ACCEPTED_AUDIENCES); } catch (e) {
      const te = e as TokenError;
      send(rpcError(id, -32001, te.message));
      return;
    }

    // Per-tool scope check
    const tool = findTool(toolName);
    if (!tool) {
      send(rpcResult(id, { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true }));
      return;
    }

    const scopes = extractScopes(decoded);
    const hasScopes = tool.requiredScopes.every(
      (s) => scopes.includes(s) || scopes.includes('*') || scopes.includes('*'),
    );
    if (!hasScopes) {
      send(rpcError(id, -32005, `Insufficient scope for tool '${toolName}'`, {
        requiredScopes: tool.requiredScopes,
        availableScopes: scopes,
      }));
      return;
    }

    // Transaction-trace hop — forwarded by the gateway in msg.params.correlationId
    // (same field it reads via extractCorrelationId). No-ops without one (e.g. a
    // caller that bypasses the gateway), matching emitHop's own fail-open contract.
    const correlationId = typeof msg.params?.correlationId === 'string' ? msg.params.correlationId : undefined;
    const _startedAt = Date.now();
    try {
      const result = await dispatch(toolName, args, token, decoded.sub);
      if (correlationId) {
        emitHop({ phase: 'mcp.tool', op: toolName, correlationId, durationMs: Date.now() - _startedAt, status: 'ok' });
      }
      send(rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: false,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (correlationId) {
        emitHop({ phase: 'mcp.tool', op: toolName, correlationId, durationMs: Date.now() - _startedAt, status: 'error' });
      }
      emitLogMessage(send, loggingState, 'error', { tool: toolName, message: errMsg }, 'resource-server.dispatch');
      send(rpcResult(id, { content: [{ type: 'text', text: errMsg }], isError: true }));
    }
    return;
  }

  if (method === 'resources/list') {
    let decoded;
    try { decoded = await decodeAndValidate(token, ACCEPTED_AUDIENCES); } catch (e) {
      const te = e as TokenError;
      send(rpcError(id, -32001, te.message));
      return;
    }
    const scopes = extractScopes(decoded);
    const has = (s: string) => scopes.includes(s) || scopes.includes('*');
    const resources = RESOURCE_CATALOG.filter((r) => has(r.requiredScope)).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
    send(rpcResult(id, { resources }));
    return;
  }

  if (method === 'resources/templates/list') {
    let decoded;
    try { decoded = await decodeAndValidate(token, ACCEPTED_AUDIENCES); } catch (e) {
      const te = e as TokenError;
      send(rpcError(id, -32001, te.message));
      return;
    }
    const scopes = extractScopes(decoded);
    const has = (s: string) => scopes.includes(s) || scopes.includes('*');
    const resourceTemplates = RESOURCE_CATALOG.filter((r) => has(r.requiredScope)).map((r) => ({
      uriTemplate: r.uriTemplate,
      name: r.templateName,
      description: r.description,
      mimeType: r.mimeType,
    }));
    send(rpcResult(id, { resourceTemplates }));
    return;
  }

  if (method === 'resources/read') {
    const uri: string = msg.params?.uri || '';
    let decoded: Awaited<ReturnType<typeof decodeAndValidate>>;
    try { decoded = await decodeAndValidate(token, ACCEPTED_AUDIENCES); } catch (e) {
      const te = e as TokenError;
      send(rpcError(id, -32001, te.message));
      return;
    }
    const resource = RESOURCE_CATALOG.find((r) => r.uri === uri);
    if (!resource) {
      send(rpcError(id, -32002, `Unknown resource URI: ${uri}`));
      return;
    }
    const scopes = extractScopes(decoded);
    const hasScope = scopes.includes(resource.requiredScope) || scopes.includes('*');
    if (!hasScope) {
      send(rpcError(id, -32005, `Insufficient scope for resource '${uri}'`, {
        requiredScope: resource.requiredScope,
        availableScopes: scopes,
      }));
      return;
    }
    try {
      const data = await dispatch(resource.listTool, {}, token, decoded.sub);
      send(rpcResult(id, {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      send(rpcError(id, -32603, `Resource read failed: ${errMsg}`));
    }
    return;
  }

  send(rpcError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// Start WebSocket + HTTP
// ---------------------------------------------------------------------------

const httpServer = createServer(handleHttp);
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const token = bearerFrom(req.headers['authorization']);

  if (!token) {
    ws.close(4001, 'Bearer token required');
    return;
  }

  // MCP spec: logging capability. One state box per WS connection.
  const loggingState: LoggingState = {};

  ws.on('message', (raw) => {
    handleMessage(raw.toString(), token, (s) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(s);
    }, loggingState).catch((err) => {
      console.error('[mcp-resource-server] Handler error:', err);
      if (ws.readyState === WebSocket.OPEN) ws.send(rpcError(null, -32603, 'Internal error'));
    });
  });

  ws.on('error', (err) => console.error('[mcp-resource-server] WS error:', err.message));
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[mcp-resource-server] Running on ${HOST}:${PORT}`);
  console.log(`[mcp-resource-server] Resource URI (aud): ${RESOURCE_URI}`);
  console.log(`[mcp-resource-server] RFC 9728: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
  console.log(`[mcp-resource-server] Tools: ${ALL_TOOLS.map((t) => t.name).join(', ')}`);
});

process.on('SIGINT', () => { httpServer.close(); process.exit(0); });
process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });

// Exported so the HTTP MCP transport can be exercised against a real socket
// (PORT=0 for an ephemeral port) instead of a hand-rolled request/response fake.
export { httpServer };
