'use strict';

/**
 * HTTP MCP transport.
 *
 * PingGateway has no WebSocket listener, so without this endpoint an IG-fronted
 * deployment cannot reach these tools at all — its /mcp/invest route proxied to
 * an endpoint that 404'd.
 *
 * These assertions exist to stop the HTTP path drifting from the WebSocket one:
 * both run the same handleMessage, so a missing audience check or a missing
 * per-tool scope gate on the new transport would be a silent auth bypass.
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { __setFetchForTests } from '../src/transactionHop';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-http-'));
process.env.VERTICAL_DB_PATH = path.join(tmpDir, 'banking.db');
process.env.MCP_RESOURCE_SERVER_RESOURCE_URI = 'mcp-resource-server.ping.demo';
process.env.SKIP_TOKEN_SIGNATURE_VALIDATION = 'true';
process.env.PORT = '0';

let server: http.Server;
let base: string;

beforeAll(async () => {
  // index.ts starts listening on import; PORT=0 gives an ephemeral port.
  const mod = await import('../src/index');
  server = (mod as unknown as { httpServer: http.Server }).httpServer;
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(scope: string, aud = 'mcp-resource-server.ping.demo'): string {
  return [
    b64({ alg: 'RS256', typ: 'JWT' }),
    b64({ sub: 'probe', aud, scope, exp: Math.floor(Date.now() / 1000) + 600 }),
    'unsigned',
  ].join('.');
}

async function post(body: unknown, bearer?: string) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, wwwAuth: res.headers.get('www-authenticate'), json: text ? JSON.parse(text) : null };
}

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

describe('POST /mcp', () => {
  it('401s without a bearer with RFC 6750 §3.1 WWW-Authenticate', async () => {
    const r = await post(callTool('list_accounts'));
    expect(r.status).toBe(401);
    expect(r.wwwAuth).toMatch(/realm="/);
    expect(r.wwwAuth).toMatch(/error="invalid_token"/);
    expect(r.wwwAuth).toContain('resource_metadata=');
  });

  // RFC 6750 §3.1: an invalid/wrong-audience token MUST be 401, same as the
  // missing-bearer case above — not 200 with the failure buried in the
  // JSON-RPC body (the -32001 check alone doesn't prove that; an HTTP-level
  // consumer like demo_mcp_proxy only sees the status code).
  it('rejects a token minted for another audience', async () => {
    const r = await post(callTool('list_accounts'), token('banking:read', 'someone-else.ping.demo'));
    expect(r.status).toBe(401);
    expect(r.wwwAuth).toMatch(/error="invalid_token"/);
    expect(r.json.error.code).toBe(-32001);
    expect(r.json.error.message).toMatch(/Audience mismatch/);
  });

  // The gate that matters: the new transport must not become a way around the
  // per-tool scope check the WebSocket path enforces.
  // RFC 6750 §3.1: scope violations on HTTP MUST be 403, not 200.
  it('enforces the per-tool scope gate with HTTP 403', async () => {
    const r = await post(callTool('list_accounts'), token('invest:read'));
    expect(r.status).toBe(403);
    expect(r.wwwAuth).toMatch(/error="insufficient_scope"/);
    expect(r.wwwAuth).toMatch(/scope="banking:read"/);
    expect(r.wwwAuth).toContain('resource_metadata=');
    expect(r.json.error.code).toBe(-32005);
    expect(r.json.error.data.requiredScopes).toEqual(['banking:read']);
  });

  it('returns banking rows from SQLite for a properly scoped token', async () => {
    const r = await post(callTool('list_accounts'), token('banking:read'));
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.json.result.content[0].text);
    expect(parsed.items).toHaveLength(4);
  });

  it('emits a transaction-trace hop when the caller forwards a correlationId', async () => {
    const hopCalls: Array<{ url: string; body: any }> = [];
    process.env.BFF_TRANSACTION_HOP_URL = 'http://bff/internal/transaction-hop';
    process.env.BFF_INTERNAL_SECRET = 'sekrit';
    __setFetchForTests(async (url: string, init: any) => {
      hopCalls.push({ url, body: JSON.parse(init.body) });
      return { ok: true } as any;
    });
    try {
      const r = await post(
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_accounts', arguments: {}, correlationId: 'c-http-1' } },
        token('banking:read'),
      );
      expect(r.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(hopCalls).toHaveLength(1);
      expect(hopCalls[0].body).toMatchObject({
        correlationId: 'c-http-1',
        service: 'mcp-resource-server',
        phase: 'mcp.tool',
        op: 'list_accounts',
        status: 'ok',
      });
    } finally {
      __setFetchForTests(undefined);
      delete process.env.BFF_TRANSACTION_HOP_URL;
      delete process.env.BFF_INTERNAL_SECRET;
    }
  });

  it('filters tools/list by scope, same as the WebSocket path', async () => {
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token('banking:read'));
    const names = r.json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['list_accounts', 'get_account', 'get_account_balance', 'list_transactions', 'search_transactions', 'list_cards', 'get_statement', 'find_branches']);
  });

  it('handles initialize without a token check, matching the WS handshake', async () => {
    const r = await post({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }, token('banking:read'));
    expect(r.json.result.protocolVersion).toBe('2025-11-25');
  });

  it('202s a notification, which produces no JSON-RPC response', async () => {
    const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token('banking:read'));
    expect(r.status).toBe(202);
  });

  it('returns a parse error for malformed JSON rather than crashing', async () => {
    const r = await post('{not json', token('banking:read'));
    expect(r.json.error.code).toBe(-32700);
  });

  // MCP Streamable HTTP transport: the server MAY assign a session id on
  // initialize; the gateway's own HTTP transport already does this
  // (GatewayServer.ts). This server had no Mcp-Session-Id handling at all —
  // flagged as a gap in the MCP spec-compliance audit.
  it('assigns an Mcp-Session-Id header on the initialize response', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token('banking:read')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('does not assign a session id on an ordinary tools/call response', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token('banking:read')}` },
      body: JSON.stringify(callTool('list_accounts')),
    });
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });
});

// MCP Prompts capability — real, usable templates referencing this server's
// own tools, not a stub. No live consumer exists in the banking demo (the
// chat UI has no prompt picker), built anyway per explicit request to close
// every gap the spec-compliance audit found.
describe('Prompts capability', () => {
  it('lists explain_account with its argument schema', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'prompts/list', params: {} }, token('banking:read'));
    const prompt = r.json.result.prompts.find((p: { name: string }) => p.name === 'explain_account');
    expect(prompt).toBeDefined();
    expect(prompt.arguments).toEqual([
      { name: 'account_id', description: expect.any(String), required: true },
    ]);
  });

  it('prompts/get fills the account id into a real instruction referencing this server\'s own tools', async () => {
    const r = await post(
      { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'explain_account', arguments: { account_id: 'ACC-001' } } },
      token('banking:read'),
    );
    expect(r.json.result.messages).toHaveLength(1);
    const text = r.json.result.messages[0].content.text;
    expect(text).toContain('ACC-001');
    expect(text).toContain('get_account_balance');
  });

  it('prompts/get on an unknown prompt name is -32602, not a crash', async () => {
    const r = await post(
      { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'not_a_real_prompt', arguments: {} } },
      token('banking:read'),
    );
    expect(r.json.error.code).toBe(-32602);
  });

  it('declares the prompts capability on initialize', async () => {
    const r = await post({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }, token('banking:read'));
    expect(r.json.result.capabilities.prompts).toBeDefined();
  });
});

describe('completion/complete', () => {
  it('returns an empty completion for any ref (nothing to suggest is not an error)', async () => {
    const r = await post({
      jsonrpc: '2.0', id: 1, method: 'completion/complete',
      params: { ref: { type: 'ref/prompt', name: 'explain_account' }, argument: { name: 'account_id', value: 'A' } },
    }, token('banking:read'));
    expect(r.status).toBe(200);
    expect(r.json.result.completion).toEqual({ values: [], total: 0, hasMore: false });
  });
});

// MCP spec 2026-07-28: server/discover — servers MUST implement it. This
// server is still Legacy-era (2025-11-25 handshake) end-to-end, so
// supportedVersions stays honestly scoped to that — claiming 2026-07-28
// before the rest of Modern (stateless _meta negotiation, MRTR, list
// caching) lands would make this RPC lie to a caller relying on it.
describe('server/discover', () => {
  it('answers with resultType complete, supportedVersions, capabilities, and serverInfo', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }, token('banking:read'));
    expect(r.json.result.resultType).toBe('complete');
    expect(r.json.result.supportedVersions).toEqual(['2025-11-25']);
    expect(r.json.result.capabilities).toMatchObject({ tools: {} });
    expect(r.json.result._meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'banking-mcp-resource-server' });
  });

  it('still answers when the discover call itself carries Modern _meta — discovery must work regardless of what the caller claims', async () => {
    const r = await post({
      jsonrpc: '2.0', id: 2, method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    }, token('banking:read'));
    expect(r.json.result.resultType).toBe('complete');
  });
});

// MCP spec 2026-07-28: per-request version negotiation. This server doesn't
// implement any Modern-era behavior yet — a Modern-shaped request (carrying
// params._meta.protocolVersion) should be rejected cleanly with
// UnsupportedProtocolVersionError rather than silently run under Legacy
// semantics it never declared support for.
describe('Modern per-request version negotiation (_meta)', () => {
  it('rejects a request carrying an unsupported Modern _meta.protocolVersion with -32022 and HTTP 400', async () => {
    const r = await post({
      jsonrpc: '2.0', id: 9, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    }, token('banking:read'));
    // MCP spec 2026-07-28 Streamable HTTP §Protocol Version Header: this
    // case MUST be 400 Bad Request, not 200 with a JSON-RPC-level error.
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({
      code: -32022,
      message: 'Unsupported protocol version',
      data: { supported: ['2025-11-25'], requested: '2026-07-28' },
    });
  });

  it('does not touch an ordinary Legacy request with no _meta.protocolVersion', async () => {
    const r = await post({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }, token('banking:read'));
    expect(r.json.result.tools).toBeDefined();
  });
});
