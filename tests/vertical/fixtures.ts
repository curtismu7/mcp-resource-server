'use strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const GOOD_SCHEMA = `
CREATE TABLE IF NOT EXISTS things (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  size  INTEGER NOT NULL
);
`;

export const GOOD_SEED = {
  things: [
    { id: 'T-1', label: 'first', size: 10 },
    { id: 'T-2', label: 'second', size: 20 },
  ],
};

export const GOOD_CONFIG = {
  name: 'demo',
  resourceName: 'Demo MCP Server',
  tools: [
    {
      name: 'list_things',
      description: 'List every thing.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: [] },
      requiredScopes: ['demo:read'],
      intentHints: ['list things'],
      sql: 'SELECT id, label, size FROM things ORDER BY id LIMIT COALESCE(:limit, 20)',
      result: 'many',
    },
    {
      name: 'get_thing',
      description: 'One thing by id.',
      inputSchema: { type: 'object', properties: { thing_id: { type: 'string' } }, required: ['thing_id'] },
      requiredScopes: ['demo:read'],
      intentHints: ['show thing'],
      sql: 'SELECT id, label, size FROM things WHERE id = :thing_id',
      result: 'one',
    },
  ],
  resources: [
    {
      uri: 'demo://things', name: 'Things', description: 'All things', mimeType: 'application/json',
      requiredScope: 'demo:read', uriTemplate: 'demo://things/{thing_id}', templateName: 'Thing', listTool: 'list_things',
    },
  ],
  prompts: [
    {
      name: 'describe_thing',
      description: 'Describe a thing.',
      arguments: [{ name: 'thing_id', description: 'Thing id', required: true }],
      template: 'Call get_thing for {{thing_id}} and describe it.',
    },
  ],
};

const created: string[] = [];

/** Remove every folder writeVertical created — call from afterAll. */
export function cleanupVerticals(): void {
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** Write a vertical folder into a fresh temp dir and return its path. Pass overrides to break it. */
export function writeVertical(overrides: {
  config?: unknown; schema?: string; seed?: unknown; omit?: Array<'vertical.json' | 'schema.sql' | 'seed.json'>;
} = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertical-'));
  created.push(dir);
  const omit = new Set(overrides.omit ?? []);
  if (!omit.has('vertical.json')) fs.writeFileSync(path.join(dir, 'vertical.json'), JSON.stringify(overrides.config ?? GOOD_CONFIG, null, 2));
  if (!omit.has('schema.sql')) fs.writeFileSync(path.join(dir, 'schema.sql'), overrides.schema ?? GOOD_SCHEMA);
  if (!omit.has('seed.json')) fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(overrides.seed ?? GOOD_SEED, null, 2));
  return dir;
}

/** Deep-clone GOOD_CONFIG so a test can mutate one field. */
export function config(mutate: (c: typeof GOOD_CONFIG) => void): typeof GOOD_CONFIG {
  const c = JSON.parse(JSON.stringify(GOOD_CONFIG));
  mutate(c);
  return c;
}
