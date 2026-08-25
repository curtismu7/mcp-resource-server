'use strict';

/**
 * Renders the Helm chart with `helm template` and pins what the manifests
 * must say. Skipped when helm is not installed (CI installs it).
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CHART = path.join(__dirname, '..', 'helm', 'mcp-resource-server');

const hasHelm = (() => {
  try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const d = hasHelm ? describe : describe.skip;

function template(args: string[]): string {
  return execFileSync('helm', ['template', 'rs', CHART, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function valuesFile(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

d('helm chart', () => {
  it('lints clean', () => {
    execFileSync('helm', ['lint', CHART, '--set', 'resourceUri=urn:test'], { stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('refuses to render without an audience when no ingress supplies one', () => {
    expect(() => template([])).toThrow(/resourceUri/);
  });

  it('derives the audience from the ingress host and renders env, ingress, probes', () => {
    const out = template([
      '--set', 'ingress.enabled=true', '--set', 'ingress.host=mcp.example.com',
      '--set', 'vertical=healthcare',
      '--set', 'pingone.environmentId=env-1', '--set', 'pingone.issuer=https://auth.pingone.com/env-1/as',
    ]);
    expect(out).toContain('MCP_RESOURCE_SERVER_RESOURCE_URI: "https://mcp.example.com"');
    expect(out).toContain('VERTICAL: "healthcare"');
    expect(out).toContain('VERTICALS_DIR: /config/verticals');
    expect(out).toContain('PINGONE_ENVIRONMENT_ID: "env-1"');
    expect(out).toContain('PINGONE_ISSUER: "https://auth.pingone.com/env-1/as"');
    expect(out).toContain('STRICT_AUTH: "false"');
    expect(out).toContain('ingressClassName: nginx-public');
    expect(out).toContain('host: mcp.example.com');
    expect(out).toContain('nginx.ingress.kubernetes.io/proxy-buffering: "off"');
    expect(out).toContain('image: "ghcr.io/curtismu7/mcp-resource-server:1.0.0"');
    expect(out).toContain('path: /health');
    expect(out).toContain('cp -R /app/verticals/. /config/verticals/');
    expect(out).not.toContain('kind: PersistentVolumeClaim');
  });

  it('mounts a vertical supplied from values as a ConfigMap under VERTICALS_DIR', () => {
    const f = valuesFile('retail.yaml', [
      'verticals:',
      '  retail:',
      '    vertical.json: |',
      '      { "name": "retail", "resourceName": "Retail", "tools": [] }',
      '    schema.sql: |',
      '      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY);',
      '    seed.json: |',
      '      { "orders": [] }',
      '',
    ].join('\n'));
    const out = template(['-f', f, '--set', 'resourceUri=urn:test', '--set', 'vertical=retail']);
    expect(out).toContain('name: rs-mcp-resource-server-vertical-retail');
    expect(out).toContain('mountPath: /config/verticals/retail');
    expect(out).toContain('vertical.json: |');
    expect(out).toContain('"name": "retail"');
    expect(out).toContain('VERTICAL: "retail"');
  });

  it('rejects a values vertical that is missing one of its three files', () => {
    const f = valuesFile('broken.yaml', 'verticals:\n  retail:\n    vertical.json: "{}"\n');
    expect(() => template(['-f', f, '--set', 'resourceUri=urn:test'])).toThrow(/schema.sql|seed.json|required/);
  });

  it('renders a PVC when persistence is enabled', () => {
    const out = template(['--set', 'resourceUri=urn:test', '--set', 'persistence.enabled=true']);
    expect(out).toContain('kind: PersistentVolumeClaim');
    expect(out).toContain('claimName: rs-mcp-resource-server-data');
  });
});
