'use strict';

/** VERTICAL=healthcare must serve ONLY healthcare — the whole point of the config design. */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-swap-'));
process.env.VERTICAL = 'healthcare';
process.env.VERTICAL_DB_PATH = path.join(tmpDir, 'healthcare.db');
process.env.MCP_RESOURCE_SERVER_RESOURCE_URI = 'mcp-resource-server.ping.demo';
process.env.SKIP_TOKEN_SIGNATURE_VALIDATION = 'true';
process.env.PORT = '0';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const mod = await import('../src/index');
  server = (mod as unknown as { httpServer: http.Server }).httpServer;
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (scope: string) => [b64({ alg: 'RS256', typ: 'JWT' }), b64({ sub: 'probe', aud: 'mcp-resource-server.ping.demo', scope, exp: Math.floor(Date.now() / 1000) + 600 }), 'unsigned'].join('.');

async function post(body: unknown, bearer: string): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

it('tools/list is the healthcare catalog and nothing else', async () => {
  const r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, token('healthcare:read'));
  expect(r.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(['get_record', 'list_appointments', 'list_prescriptions', 'view_records']);
});

it('scopes_supported is healthcare:read only', async () => {
  const meta: any = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  expect(meta.scopes_supported).toEqual(['healthcare:read']);
  expect(meta.resource_name).toBe('Healthcare MCP Server');
});

it('a banking tool name is unknown here', async () => {
  const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } }, token('healthcare:read'));
  expect(r.result.isError).toBe(true);
  expect(r.result.content[0].text).toMatch(/Unknown tool/);
});

it('healthcare data comes back', async () => {
  const r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_record', arguments: { record_id: 'REC-103' } } }, token('healthcare:read'));
  expect(JSON.parse(r.result.content[0].text).type).toBe('imaging');
});

it('service name follows the active vertical', async () => {
  const health: any = await (await fetch(`${base}/health`)).json();
  expect(health.service).toBe('healthcare-mcp-resource-server');
  expect(health.vertical).toBe('healthcare');
});
