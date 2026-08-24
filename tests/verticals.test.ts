'use strict';

/**
 * Every folder under verticals/ must load, seed, and answer EVERY tool with
 * a non-empty result when called with arguments taken from its own seed data.
 * Adding a broken tool to a config fails here, not in a demo.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadVertical, paramNames } from '../src/vertical/load';
import { runSelect, seedDatabase } from '../src/vertical/db';

const ROOT = path.join(__dirname, '..', 'verticals');
const folders = fs.readdirSync(ROOT).filter((f) => fs.statSync(path.join(ROOT, f)).isDirectory());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verticals-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Example value for a :param — the first seed row of the table whose column
// matches the param name (account_id -> accounts.id, record_id -> records.id,
// period -> statements.period, query/city/zip -> a literal from the seed).
function exampleArg(seed: Record<string, Array<Record<string, unknown>>>, param: string): unknown {
  const m = /^(.+)_id$/.exec(param);
  if (m) {
    const table = Object.keys(seed).find((t) => t === `${m[1]}s` || t === m[1]);
    if (table && seed[table][0]) return seed[table][0].id;
  }
  for (const rows of Object.values(seed)) {
    if (rows[0] && rows[0][param] !== undefined) return rows[0][param];
  }
  if (param === 'query') return 'a';
  if (param === 'limit') return 5;
  return undefined;
}

describe.each(folders)('verticals/%s', (folder) => {
  const v = loadVertical(path.join(ROOT, folder));
  const dbPath = path.join(tmp, `${folder}.db`);
  seedDatabase(dbPath, v.schemaSql, v.seed);

  it('has a name matching its folder and at least one tool', () => {
    expect(v.name).toBe(folder);
    expect(v.tools.length).toBeGreaterThan(0);
  });

  it.each(v.tools.map((t) => [t.name, t] as const))('%s returns data for seed-derived arguments', (_name, tool) => {
    const args: Record<string, unknown> = {};
    for (const p of paramNames(tool.sql)) {
      const val = exampleArg(v.seed, p);
      if (val !== undefined) args[p] = val;
    }
    const rows = runSelect(dbPath, tool.sql, args);
    expect(rows.length).toBeGreaterThan(0);
    // Every required argument had an example — otherwise the test proves nothing.
    for (const req of ((tool.inputSchema as { required?: string[] }).required ?? [])) {
      expect(args).toHaveProperty(req);
    }
  });
});
