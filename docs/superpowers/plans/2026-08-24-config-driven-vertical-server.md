# Config-driven Vertical Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this repo into a banking MCP server whose tools, data, resources and prompts come from one config folder per vertical, selected by `VERTICAL`, so switching to healthcare is a config change.

**Architecture:** `src/index.ts` (PingOne bearer validation, accepted audiences, RFC 9728 metadata, WebSocket + streamable-HTTP MCP) stays. A three-module engine — `src/vertical/load.ts` (read + validate a folder), `src/vertical/db.ts` (seed once at startup, read-only SELECT per call), `src/tools/registry.ts` (same exports `index.ts` consumes, backed by the loaded vertical) — replaces the 22 per-vertical TS files and 11 DB modules. Every tool is a parameterised SQL `SELECT` in `vertical.json`.

**Tech Stack:** Node 22, TypeScript 5 (CommonJS), `node:sqlite` (`--experimental-sqlite`), jest + ts-jest, Docker.

**Spec:** `docs/superpowers/specs/2026-08-24-config-driven-vertical-server-design.md` — read it first. One amendment made in this plan: **prompts** are also config-driven (`vertical.json.prompts[]`, a text template with `{{arg}}` placeholders) and `completion/complete` always returns an empty list; the airlines-specific prompt and completion hook go away with the airlines code.

## Global Constraints

- Node `>= 22`; SQLite via `node:sqlite` only (no npm sqlite dependency). All `node` invocations carry `--experimental-sqlite` (already in `package.json` scripts and the Dockerfile `CMD`).
- Exactly one vertical is active, selected by `VERTICAL` (default `banking`). Folder root is `VERTICALS_DIR` (default `<package>/verticals`). Database path is `VERTICAL_DB_PATH` (default `<cwd>/data/<VERTICAL>.db`).
- Config SQL is `SELECT` only; enforced twice — validation rejects any other first keyword, and tool reads use a `readOnly: true` connection.
- No new npm dependencies. `axios` is removed.
- Auth (`src/server/*`, `STRICT_AUTH`, JWKS, audiences, RFC 9728 challenge) is not modified by any task.
- Emoji: none in code, config, or docs (the origin project allows only `⚠️ ✅ ❌ 🔐 ✕ ✓`; this repo uses none).
- Run tests with `node_modules/.bin/jest <paths>` from the repo root (never bare `npx jest`, which can fetch a different jest). Typecheck with `node_modules/.bin/tsc --noEmit`.
- Commit after every task with the message given; never `git add -A` (the `data/` directory and `node_modules` must not be staged).

---

## File map

| Path | Responsibility |
|---|---|
| `src/vertical/types.ts` | `McpToolDef`, `VerticalTool`, `ResourceDef`, `PromptDef`, `Vertical`, `filterByScopes` (moved from `src/tools/toolTypes.ts`) |
| `src/vertical/load.ts` | `loadVertical(dir): Vertical` — read `vertical.json`, `schema.sql`, `seed.json`; validate; throw `VerticalConfigError` naming the file/tool |
| `src/vertical/db.ts` | `seedDatabase(dbPath, schemaSql, seed)`, `runSelect(dbPath, sql, params)` |
| `src/tools/registry.ts` | Loads the active vertical at import; exports `VERTICAL`, `ALL_TOOLS`, `SUPPORTED_SCOPES`, `RESOURCE_CATALOG`, `PROMPTS`, `RESOURCE_NAME_DEFAULT`, `findTool`, `dispatch`, `resolveDbPath` |
| `verticals/banking/{vertical.json,schema.sql,seed.json}` | Default vertical |
| `verticals/healthcare/{vertical.json,schema.sql,seed.json}` | Worked example |
| `src/index.ts` | Rewired to the registry exports; airlines/invest/API-key code removed |
| `tests/vertical/*.test.ts`, `tests/verticals.test.ts`, `tests/swap.test.ts` | Engine, per-folder, and swap tests |

---

### Task 1: Vertical types and the loader with validation

**Files:**
- Create: `src/vertical/types.ts`
- Create: `src/vertical/load.ts`
- Create: `tests/vertical/load.test.ts`
- Create: `tests/vertical/fixtures.ts` (helper that writes a temp vertical folder)

**Interfaces:**
- Produces: `loadVertical(dir: string): Vertical`; `paramNames(sql: string): string[]`; `class VerticalConfigError extends Error`; types below. Task 2 consumes `paramNames`; Task 3 consumes `Vertical`, `loadVertical`, `VerticalConfigError`; Task 6 consumes `filterByScopes`.

- [ ] **Step 1: Write the types**

`src/vertical/types.ts`:

```ts
'use strict';

/** MCP tool definition as advertised by tools/list. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredScopes: string[];
  readOnly: boolean;
  intentHints?: string[];
}

/** A tool as written in vertical.json: the MCP definition plus how to answer it. */
export interface VerticalTool extends McpToolDef {
  sql: string;
  result: 'one' | 'many';
}

export interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  requiredScope: string;
  uriTemplate: string;
  templateName: string;
  listTool: string;
}

export interface PromptArgDef {
  name: string;
  description: string;
  required?: boolean;
}

/** `template` is the user message; `{{argName}}` placeholders are filled from prompts/get arguments. */
export interface PromptDef {
  name: string;
  description: string;
  arguments: PromptArgDef[];
  template: string;
}

export interface Vertical {
  name: string;
  resourceName: string;
  tools: VerticalTool[];
  resources: ResourceDef[];
  prompts: PromptDef[];
  schemaSql: string;
  seed: Record<string, Array<Record<string, unknown>>>;
  dir: string;
}

export function filterByScopes(tools: McpToolDef[], tokenScopes: string[]): McpToolDef[] {
  // Empty scope list -> only tools that require no scopes. Advertising the
  // full catalog to zero-scope tokens violates least-privilege.
  if (tokenScopes.length === 0) {
    return tools.filter((t) => t.requiredScopes.length === 0);
  }
  const has = (s: string) => tokenScopes.includes(s) || tokenScopes.includes('*');
  return tools.filter((t) => t.requiredScopes.length === 0 || t.requiredScopes.every(has));
}
```

- [ ] **Step 2: Write the fixture helper**

`tests/vertical/fixtures.ts`:

```ts
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

/** Write a vertical folder into a fresh temp dir and return its path. Pass overrides to break it. */
export function writeVertical(overrides: {
  config?: unknown; schema?: string; seed?: unknown; omit?: Array<'vertical.json' | 'schema.sql' | 'seed.json'>;
} = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertical-'));
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
```

- [ ] **Step 3: Write the failing loader tests**

`tests/vertical/load.test.ts`:

```ts
'use strict';
import { loadVertical, VerticalConfigError } from '../../src/vertical/load';
import { writeVertical, config, GOOD_CONFIG } from './fixtures';

describe('loadVertical', () => {
  it('loads a good folder', () => {
    const v = loadVertical(writeVertical());
    expect(v.name).toBe('demo');
    expect(v.tools.map((t) => t.name)).toEqual(['list_things', 'get_thing']);
    expect(v.tools[0].readOnly).toBe(true);
    expect(v.resources[0].listTool).toBe('list_things');
    expect(v.prompts[0].name).toBe('describe_thing');
    expect(v.schemaSql).toContain('CREATE TABLE');
    expect(v.seed.things).toHaveLength(2);
  });

  it('defaults resources and prompts to empty arrays', () => {
    const v = loadVertical(writeVertical({ config: config((c) => { delete (c as any).resources; delete (c as any).prompts; }) }));
    expect(v.resources).toEqual([]);
    expect(v.prompts).toEqual([]);
  });

  const failing: Array<[string, () => string, RegExp]> = [
    ['missing folder', () => '/nonexistent/vertical', /vertical\.json/],
    ['missing schema.sql', () => writeVertical({ omit: ['schema.sql'] }), /schema\.sql/],
    ['missing seed.json', () => writeVertical({ omit: ['seed.json'] }), /seed\.json/],
    ['tool without sql', () => writeVertical({ config: config((c) => { delete (c.tools[0] as any).sql; }) }), /list_things.*sql/],
    ['tool with bad result', () => writeVertical({ config: config((c) => { (c.tools[0] as any).result = 'some'; }) }), /list_things.*result/],
    ['duplicate tool name', () => writeVertical({ config: config((c) => { c.tools[1].name = 'list_things'; }) }), /duplicate tool.*list_things/],
    ['duplicate resource uri', () => writeVertical({ config: config((c) => { c.resources.push({ ...c.resources[0] }); }) }), /duplicate resource.*demo:\/\/things/],
    ['resource listTool names no tool', () => writeVertical({ config: config((c) => { c.resources[0].listTool = 'nope'; }) }), /demo:\/\/things.*nope/],
    ['required arg not in sql', () => writeVertical({ config: config((c) => { c.tools[1].sql = 'SELECT * FROM things'; }) }), /get_thing.*thing_id/],
    ['sql that does not prepare', () => writeVertical({ config: config((c) => { c.tools[0].sql = 'SELECT nope FROM missing_table'; }) }), /list_things.*missing_table/],
    ['sql that is not a SELECT', () => writeVertical({ config: config((c) => { c.tools[0].sql = 'DELETE FROM things'; }) }), /list_things.*SELECT/],
    ['prompt placeholder with no argument', () => writeVertical({ config: config((c) => { c.prompts[0].template = 'Use {{missing}}'; }) }), /describe_thing.*missing/],
    ['seed table not in schema', () => writeVertical({ seed: { ghosts: [{ id: 1 }] } }), /seed\.json.*ghosts/],
  ];
  for (const [label, dir, pattern] of failing) {
    it(`rejects: ${label}`, () => {
      expect(() => loadVertical(dir())).toThrow(VerticalConfigError);
      expect(() => loadVertical(dir())).toThrow(pattern);
    });
  }

  it('keeps GOOD_CONFIG itself valid (fixture sanity)', () => {
    expect(GOOD_CONFIG.tools).toHaveLength(2);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node_modules/.bin/jest tests/vertical/load.test.ts`
Expected: FAIL — `Cannot find module '../../src/vertical/load'`.

- [ ] **Step 5: Write the loader**

`src/vertical/load.ts`:

```ts
'use strict';

/**
 * Read and validate one vertical folder:
 *   <dir>/vertical.json   name, resourceName, tools[], resources[], prompts[]
 *   <dir>/schema.sql      CREATE TABLE IF NOT EXISTS ...
 *   <dir>/seed.json       { "<table>": [ row, ... ] }
 *
 * Every problem is a VerticalConfigError naming the file and the tool, so a
 * bad config fails at startup instead of on the first tools/call.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { PromptDef, ResourceDef, Vertical, VerticalTool } from './types';

export class VerticalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerticalConfigError';
  }
}

/** Names of the `:param` placeholders in a SQL string, in order, de-duplicated. */
export function paramNames(sql: string): string[] {
  const names: string[] = [];
  for (const m of sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function readFile(dir: string, file: string): string {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) throw new VerticalConfigError(`${p}: file not found`);
  return fs.readFileSync(p, 'utf8');
}

function fail(file: string, what: string): never {
  throw new VerticalConfigError(`${file}: ${what}`);
}

export function loadVertical(dir: string): Vertical {
  const cfgFile = path.join(dir, 'vertical.json');
  let cfg: any;
  try {
    cfg = JSON.parse(readFile(dir, 'vertical.json'));
  } catch (err) {
    if (err instanceof VerticalConfigError) throw err;
    fail(cfgFile, `not valid JSON (${(err as Error).message})`);
  }
  const schemaSql = readFile(dir, 'schema.sql');
  const seedFile = path.join(dir, 'seed.json');
  let seed: Record<string, Array<Record<string, unknown>>>;
  try {
    seed = JSON.parse(readFile(dir, 'seed.json'));
  } catch (err) {
    if (err instanceof VerticalConfigError) throw err;
    fail(seedFile, `not valid JSON (${(err as Error).message})`);
  }

  if (typeof cfg.name !== 'string' || !cfg.name) fail(cfgFile, '"name" is required');
  if (typeof cfg.resourceName !== 'string' || !cfg.resourceName) fail(cfgFile, '"resourceName" is required');
  if (!Array.isArray(cfg.tools) || cfg.tools.length === 0) fail(cfgFile, '"tools" must be a non-empty array');

  // Validate SQL against the real schema on a throwaway in-memory database.
  const probe = new DatabaseSync(':memory:');
  try {
    probe.exec(schemaSql);
  } catch (err) {
    fail(path.join(dir, 'schema.sql'), `does not execute (${(err as Error).message})`);
  }
  const tableExists = probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");

  const tools: VerticalTool[] = [];
  const seen = new Set<string>();
  for (const t of cfg.tools) {
    const label = `tool "${t?.name ?? '?'}"`;
    if (typeof t.name !== 'string' || !t.name) fail(cfgFile, 'every tool needs a "name"');
    if (seen.has(t.name)) fail(cfgFile, `duplicate tool name "${t.name}"`);
    seen.add(t.name);
    if (typeof t.description !== 'string') fail(cfgFile, `${label}: "description" is required`);
    if (typeof t.inputSchema !== 'object' || t.inputSchema === null) fail(cfgFile, `${label}: "inputSchema" is required`);
    if (!Array.isArray(t.requiredScopes)) fail(cfgFile, `${label}: "requiredScopes" must be an array`);
    if (typeof t.sql !== 'string' || !t.sql.trim()) fail(cfgFile, `${label}: "sql" is required`);
    if (t.result !== 'one' && t.result !== 'many') fail(cfgFile, `${label}: "result" must be "one" or "many"`);
    if (!/^\s*SELECT\b/i.test(t.sql)) fail(cfgFile, `${label}: "sql" must be a SELECT`);
    const params = paramNames(t.sql);
    for (const req of (t.inputSchema.required ?? []) as string[]) {
      if (!params.includes(req)) fail(cfgFile, `${label}: required argument "${req}" is not a :${req} parameter in "sql"`);
    }
    try {
      probe.prepare(t.sql);
    } catch (err) {
      fail(cfgFile, `${label}: "sql" does not prepare against schema.sql (${(err as Error).message})`);
    }
    tools.push({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      requiredScopes: t.requiredScopes,
      readOnly: true,
      intentHints: Array.isArray(t.intentHints) ? t.intentHints : [],
      sql: t.sql,
      result: t.result,
    });
  }

  const resources: ResourceDef[] = [];
  const seenUri = new Set<string>();
  for (const r of cfg.resources ?? []) {
    const label = `resource "${r?.uri ?? '?'}"`;
    for (const key of ['uri', 'name', 'description', 'mimeType', 'requiredScope', 'uriTemplate', 'templateName', 'listTool']) {
      if (typeof r[key] !== 'string' || !r[key]) fail(cfgFile, `${label}: "${key}" is required`);
    }
    if (seenUri.has(r.uri)) fail(cfgFile, `duplicate resource uri "${r.uri}"`);
    seenUri.add(r.uri);
    if (!seen.has(r.listTool)) fail(cfgFile, `${label}: listTool "${r.listTool}" is not a tool in this vertical`);
    resources.push(r);
  }

  const prompts: PromptDef[] = [];
  for (const p of cfg.prompts ?? []) {
    const label = `prompt "${p?.name ?? '?'}"`;
    if (typeof p.name !== 'string' || !p.name) fail(cfgFile, 'every prompt needs a "name"');
    if (typeof p.description !== 'string') fail(cfgFile, `${label}: "description" is required`);
    if (typeof p.template !== 'string') fail(cfgFile, `${label}: "template" is required`);
    const args: string[] = (p.arguments ?? []).map((a: any) => a.name);
    for (const m of p.template.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
      if (!args.includes(m[1])) fail(cfgFile, `${label}: template placeholder {{${m[1]}}} has no matching argument`);
    }
    prompts.push({ name: p.name, description: p.description, arguments: p.arguments ?? [], template: p.template });
  }

  for (const table of Object.keys(seed)) {
    if (!Array.isArray(seed[table])) fail(seedFile, `"${table}" must be an array of rows`);
    if (!tableExists.get(table)) fail(seedFile, `table "${table}" is not created by schema.sql`);
  }
  probe.close();

  return { name: cfg.name, resourceName: cfg.resourceName, tools, resources, prompts, schemaSql, seed, dir };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node_modules/.bin/jest tests/vertical/load.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 7: Typecheck and commit**

Run: `node_modules/.bin/tsc --noEmit` — expected exit 0 (the old code still compiles; nothing imports the new files yet).

```bash
git add src/vertical/types.ts src/vertical/load.ts tests/vertical/fixtures.ts tests/vertical/load.test.ts
git commit -m "feat(vertical): types and folder loader with fail-fast validation"
```

---

### Task 2: Database — seed once, read-only SELECT per call

**Files:**
- Create: `src/vertical/db.ts`
- Create: `tests/vertical/db.test.ts`

**Interfaces:**
- Consumes: `paramNames` (Task 1).
- Produces: `seedDatabase(dbPath: string, schemaSql: string, seed: Record<string, Array<Record<string, unknown>>>): { seededTables: string[] }`; `runSelect(dbPath: string, sql: string, params: Record<string, unknown>): Record<string, unknown>[]`. Task 3 and Task 4 consume both.

- [ ] **Step 1: Write the failing tests**

`tests/vertical/db.test.ts`:

```ts
'use strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { runSelect, seedDatabase } from '../../src/vertical/db';
import { GOOD_SCHEMA, GOOD_SEED } from './fixtures';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vertical-db-'));
const dbPath = path.join(tmpDir, 'demo.db');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('seedDatabase', () => {
  it('creates the file, applies the schema and seeds empty tables', () => {
    const r = seedDatabase(dbPath, GOOD_SCHEMA, GOOD_SEED);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(r.seededTables).toEqual(['things']);
    expect(runSelect(dbPath, 'SELECT COUNT(*) AS n FROM things', {})[0].n).toBe(2);
  });

  it('does not re-seed a non-empty table, so an out-of-band edit survives a restart', () => {
    const conn = new DatabaseSync(dbPath);
    conn.exec("UPDATE things SET label = 'edited' WHERE id = 'T-1'");
    conn.close();
    const r = seedDatabase(dbPath, GOOD_SCHEMA, GOOD_SEED);
    expect(r.seededTables).toEqual([]);
    expect(runSelect(dbPath, "SELECT label FROM things WHERE id = 'T-1'", {})[0].label).toBe('edited');
  });

  it('creates the parent directory', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'demo.db');
    seedDatabase(nested, GOOD_SCHEMA, GOOD_SEED);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('runSelect', () => {
  it('binds only the named parameters the SQL mentions, NULL when absent', () => {
    const rows = runSelect(dbPath, 'SELECT id FROM things ORDER BY id LIMIT COALESCE(:limit, 20)', { limit: 1, ignored: 'x' });
    expect(rows).toEqual([{ id: 'T-1' }]);
    const all = runSelect(dbPath, 'SELECT id FROM things ORDER BY id LIMIT COALESCE(:limit, 20)', {});
    expect(all).toHaveLength(2);
  });

  it('is read-only: a write statement is refused', () => {
    expect(() => runSelect(dbPath, "DELETE FROM things", {})).toThrow(/readonly|read-only/i);
    expect(runSelect(dbPath, 'SELECT COUNT(*) AS n FROM things', {})[0].n).toBe(2);
  });

  it('sees an external edit on the next call (no cached connection)', () => {
    const conn = new DatabaseSync(dbPath);
    conn.exec("UPDATE things SET size = 99 WHERE id = 'T-2'");
    conn.close();
    expect(runSelect(dbPath, "SELECT size FROM things WHERE id = 'T-2'", {})[0].size).toBe(99);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/jest tests/vertical/db.test.ts`
Expected: FAIL — `Cannot find module '../../src/vertical/db'`.

- [ ] **Step 3: Write the module**

`src/vertical/db.ts`:

```ts
'use strict';

/**
 * SQLite access for the active vertical.
 *
 * seedDatabase — run once at startup: apply schema.sql, then insert seed rows
 *   into each table that is EMPTY. A restart never clobbers a row changed
 *   outside the app (the documented reason data/ is a bind mount).
 * runSelect — one read per call on a read-only connection: the hard guarantee
 *   that config SQL can only read. Opening per call costs microseconds at this
 *   volume and makes external edits visible immediately.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { paramNames } from './load';

export function seedDatabase(
  dbPath: string,
  schemaSql: string,
  seed: Record<string, Array<Record<string, unknown>>>,
): { seededTables: string[] } {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const conn = new DatabaseSync(dbPath);
  const seededTables: string[] = [];
  try {
    conn.exec('PRAGMA foreign_keys = ON');
    conn.exec(schemaSql);
    conn.exec('BEGIN');
    try {
      for (const [table, rows] of Object.entries(seed)) {
        const { n } = conn.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
        if (n > 0 || rows.length === 0) continue;
        const cols = Object.keys(rows[0]);
        const stmt = conn.prepare(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        );
        for (const row of rows) stmt.run(...cols.map((c) => (row[c] ?? null) as never));
        seededTables.push(table);
      }
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
  } finally {
    conn.close();
  }
  return { seededTables };
}

export function runSelect(
  dbPath: string,
  sql: string,
  params: Record<string, unknown>,
): Record<string, unknown>[] {
  const conn = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const bound: Record<string, unknown> = {};
    for (const name of paramNames(sql)) bound[name] = params[name] ?? null;
    return conn.prepare(sql).all(bound as never) as Record<string, unknown>[];
  } finally {
    conn.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node_modules/.bin/jest tests/vertical/db.test.ts`
Expected: PASS, 6 tests. If the read-only test fails with a different message, print the actual error and widen the regex to match it — the assertion that matters is that the DELETE is refused and the count is still 2.

- [ ] **Step 5: Commit**

```bash
git add src/vertical/db.ts tests/vertical/db.test.ts
git commit -m "feat(vertical): seed-once database and read-only select"
```

---

### Task 3: Registry — load the active vertical, dispatch tools

**Files:**
- Rewrite: `src/tools/registry.ts` (delete all current contents)
- Create: `tests/vertical/dispatch.test.ts`

**Interfaces:**
- Consumes: `loadVertical`, `VerticalConfigError` (Task 1); `seedDatabase`, `runSelect` (Task 2).
- Produces (all consumed by `src/index.ts` in Task 6):
  - `VERTICAL: Vertical`
  - `ALL_TOOLS: McpToolDef[]`, `SUPPORTED_SCOPES: string[]`, `RESOURCE_CATALOG: ResourceDef[]`, `PROMPTS: PromptDef[]`, `RESOURCE_NAME_DEFAULT: string`
  - `findTool(name: string): McpToolDef | undefined`
  - `dispatch(toolName: string, args: Record<string, unknown>, token: string, subject: string): Promise<unknown>` (token/subject unused — kept so `index.ts` call sites do not change)
  - `resolveDbPath(): string`

- [ ] **Step 1: Write the failing tests**

`tests/vertical/dispatch.test.ts`:

```ts
'use strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeVertical } from './fixtures';

// The registry loads the vertical at import time, so env must be set first.
const dir = writeVertical();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
process.env.VERTICALS_DIR = path.dirname(dir);
process.env.VERTICAL = path.basename(dir);
process.env.VERTICAL_DB_PATH = path.join(tmp, 'demo.db');

import { ALL_TOOLS, PROMPTS, RESOURCE_CATALOG, RESOURCE_NAME_DEFAULT, SUPPORTED_SCOPES, dispatch, findTool } from '../../src/tools/registry';

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('registry over a config vertical', () => {
  it('exposes the catalog, scopes, resources and prompts from vertical.json', () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual(['list_things', 'get_thing']);
    expect(ALL_TOOLS[0]).not.toHaveProperty('sql'); // tools/list must not leak SQL
    expect(SUPPORTED_SCOPES).toEqual(['demo:read']);
    expect(RESOURCE_CATALOG[0].uri).toBe('demo://things');
    expect(PROMPTS[0].name).toBe('describe_thing');
    expect(RESOURCE_NAME_DEFAULT).toBe('Demo MCP Server');
    expect(findTool('get_thing')?.description).toBe('One thing by id.');
    expect(findTool('nope')).toBeUndefined();
  });

  it('seeded the database at import time', () => {
    expect(fs.existsSync(process.env.VERTICAL_DB_PATH as string)).toBe(true);
  });

  it('result: many -> { items, count }', async () => {
    const r = await dispatch('list_things', {}, '', '') as { items: unknown[]; count: number };
    expect(r.count).toBe(2);
    expect(r.items[0]).toEqual({ id: 'T-1', label: 'first', size: 10 });
  });

  it('result: one -> the row', async () => {
    expect(await dispatch('get_thing', { thing_id: 'T-2' }, '', '')).toEqual({ id: 'T-2', label: 'second', size: 20 });
  });

  it('clamps limit to 1..100', async () => {
    expect((await dispatch('list_things', { limit: 0 }, '', '') as { count: number }).count).toBe(1);
    expect((await dispatch('list_things', { limit: '5&x' }, '', '') as { count: number }).count).toBe(2);
    expect((await dispatch('list_things', { limit: 100000 }, '', '') as { count: number }).count).toBe(2);
  });

  it('rejects a missing required argument with isError semantics (throws)', async () => {
    await expect(dispatch('get_thing', {}, '', '')).rejects.toThrow('missing required argument: thing_id');
  });

  it('result: one with no row throws not found', async () => {
    await expect(dispatch('get_thing', { thing_id: 'T-9' }, '', '')).rejects.toThrow('not found: thing_id=T-9');
  });

  it('unknown tool throws', async () => {
    await expect(dispatch('nope', {}, '', '')).rejects.toThrow('Unknown tool: nope');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/jest tests/vertical/dispatch.test.ts`
Expected: FAIL — the current registry exports different names (`RESOURCE_CATALOG` undefined) and imports airlines/banking modules.

- [ ] **Step 3: Rewrite the registry**

Replace the entire contents of `src/tools/registry.ts` with:

```ts
'use strict';

/**
 * The active vertical, loaded once at import from
 *   $VERTICALS_DIR/$VERTICAL   (defaults: <package>/verticals, "banking")
 * and its database at
 *   $VERTICAL_DB_PATH           (default: <cwd>/data/<VERTICAL>.db)
 *
 * Everything the transport needs — the catalog, advertised scopes,
 * resources, prompts, and dispatch — comes from here, so index.ts never
 * knows which vertical it is serving. A bad config exits the process with
 * the offending file and tool named.
 */

import path from 'path';
import { loadVertical, VerticalConfigError } from '../vertical/load';
import { runSelect, seedDatabase } from '../vertical/db';
import { McpToolDef, PromptDef, ResourceDef, Vertical, VerticalTool } from '../vertical/types';

const MAX_LIMIT = 100;

function loadActive(): Vertical {
  const name = process.env.VERTICAL || 'banking';
  const root = process.env.VERTICALS_DIR || path.join(__dirname, '..', '..', 'verticals');
  try {
    return loadVertical(path.join(root, name));
  } catch (err) {
    if (err instanceof VerticalConfigError) {
      console.error(`[mcp-resource-server] FATAL: invalid vertical "${name}" — ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export const VERTICAL: Vertical = loadActive();

export function resolveDbPath(): string {
  return process.env.VERTICAL_DB_PATH || path.join(process.cwd(), 'data', `${VERTICAL.name}.db`);
}

{
  const { seededTables } = seedDatabase(resolveDbPath(), VERTICAL.schemaSql, VERTICAL.seed);
  if (seededTables.length) console.log(`[mcp-resource-server] seeded ${resolveDbPath()}: ${seededTables.join(', ')}`);
}

const TOOLS_BY_NAME = new Map<string, VerticalTool>(VERTICAL.tools.map((t) => [t.name, t]));

/** The catalog as advertised — the SQL never leaves this module. */
export const ALL_TOOLS: McpToolDef[] = VERTICAL.tools.map(({ sql: _sql, result: _result, ...def }) => def);

/** Derived from the catalog so RFC 9728 metadata only advertises scopes that unlock a tool. */
export const SUPPORTED_SCOPES: string[] = [...new Set(ALL_TOOLS.flatMap((t) => t.requiredScopes))];

export const RESOURCE_CATALOG: ResourceDef[] = VERTICAL.resources;
export const PROMPTS: PromptDef[] = VERTICAL.prompts;
export const RESOURCE_NAME_DEFAULT: string = VERTICAL.resourceName;

export function findTool(toolName: string): McpToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === toolName);
}

// `limit` is the one argument with engine semantics: clamp to 1..MAX_LIMIT so a
// malformed or oversized value can't distort the query; absent stays absent
// (the SQL's COALESCE supplies the default).
function clampLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

export async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  _token: string,
  _subject: string,
): Promise<unknown> {
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  const required = ((tool.inputSchema as { required?: string[] }).required ?? []);
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      throw new Error(`missing required argument: ${name}`);
    }
  }
  const params: Record<string, unknown> = { ...args };
  if ('limit' in params) params.limit = clampLimit(params.limit);

  const rows = runSelect(resolveDbPath(), tool.sql, params);
  if (tool.result === 'many') return { items: rows, count: rows.length };
  if (rows.length === 0) {
    const key = required[0];
    throw new Error(key ? `not found: ${key}=${String(args[key])}` : 'not found');
  }
  return rows[0];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node_modules/.bin/jest tests/vertical/dispatch.test.ts`
Expected: PASS, 8 tests. (`tsc` will fail at this point because `src/index.ts` and the old vertical files still reference removed exports — that is fixed in Tasks 6 and 7; do not run the full suite yet.)

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry.ts tests/vertical/dispatch.test.ts
git commit -m "feat(registry): serve the active config vertical"
```

---

### Task 4: The banking vertical

**Files:**
- Create: `verticals/banking/schema.sql`
- Create: `verticals/banking/seed.json`
- Create: `verticals/banking/vertical.json`
- Create: `tests/verticals.test.ts` (generic: every folder, every tool)

**Interfaces:**
- Consumes: `loadVertical`, `paramNames` (Task 1); `seedDatabase`, `runSelect` (Task 2).
- Produces: the default vertical. Task 6's transport tests use `list_accounts`, `get_account_balance`, `banking://accounts`, `banking://cards`, scope `banking:read`, prompt `explain_account`.

- [ ] **Step 1: Write the generic per-folder test**

`tests/verticals.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node_modules/.bin/jest tests/verticals.test.ts`
Expected: FAIL — `ENOENT ... verticals` (no folder yet).

- [ ] **Step 3: Write the banking schema**

`verticals/banking/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  nickname      TEXT NOT NULL,
  type          TEXT NOT NULL,          -- checking | savings | money_market | credit_card
  number_masked TEXT NOT NULL,
  balance       REAL NOT NULL,
  available     REAL NOT NULL,
  currency      TEXT NOT NULL,
  opened        TEXT NOT NULL,          -- YYYY-MM-DD
  status        TEXT NOT NULL           -- open | frozen | closed
);

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  date            TEXT NOT NULL,        -- YYYY-MM-DD
  merchant        TEXT NOT NULL,
  category        TEXT NOT NULL,
  amount          REAL NOT NULL,        -- negative = money out
  status          TEXT NOT NULL,        -- posted | pending
  running_balance REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  kind        TEXT NOT NULL,            -- debit | credit
  network     TEXT NOT NULL,
  last4       TEXT NOT NULL,
  status      TEXT NOT NULL,            -- active | locked
  expires     TEXT NOT NULL,            -- MM/YY
  daily_limit REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS statements (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  period          TEXT NOT NULL,        -- YYYY-MM
  opening_balance REAL NOT NULL,
  closing_balance REAL NOT NULL,
  total_in        REAL NOT NULL,
  total_out       REAL NOT NULL,
  document        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  address  TEXT NOT NULL,
  city     TEXT NOT NULL,
  zip      TEXT NOT NULL,
  hours    TEXT NOT NULL,
  services TEXT NOT NULL,
  has_atm  INTEGER NOT NULL
);
```

- [ ] **Step 4: Write the banking seed**

`verticals/banking/seed.json` (one customer, Jun–Aug 2026, fixed dates):

```json
{
  "accounts": [
    { "id": "ACC-001", "nickname": "Everyday Checking", "type": "checking", "number_masked": "****4471", "balance": 4312.58, "available": 4187.58, "currency": "USD", "opened": "2019-03-12", "status": "open" },
    { "id": "ACC-002", "nickname": "Rainy Day Savings", "type": "savings", "number_masked": "****9902", "balance": 18540.90, "available": 18540.90, "currency": "USD", "opened": "2019-03-12", "status": "open" },
    { "id": "ACC-003", "nickname": "House Fund", "type": "money_market", "number_masked": "****1187", "balance": 52210.00, "available": 52210.00, "currency": "USD", "opened": "2022-08-01", "status": "open" },
    { "id": "ACC-004", "nickname": "Rewards Visa", "type": "credit_card", "number_masked": "****3308", "balance": -1284.33, "available": 8715.67, "currency": "USD", "opened": "2021-11-20", "status": "open" }
  ],
  "transactions": [
    { "id": "TXN-1001", "account_id": "ACC-001", "date": "2026-06-02", "merchant": "Acme Corp Payroll", "category": "income", "amount": 3250.00, "status": "posted", "running_balance": 5102.14 },
    { "id": "TXN-1002", "account_id": "ACC-001", "date": "2026-06-03", "merchant": "Greenfield Apartments", "category": "rent", "amount": -1650.00, "status": "posted", "running_balance": 3452.14 },
    { "id": "TXN-1003", "account_id": "ACC-001", "date": "2026-06-05", "merchant": "Whole Harvest Market", "category": "groceries", "amount": -142.87, "status": "posted", "running_balance": 3309.27 },
    { "id": "TXN-1004", "account_id": "ACC-001", "date": "2026-06-09", "merchant": "City Power & Light", "category": "utilities", "amount": -118.40, "status": "posted", "running_balance": 3190.87 },
    { "id": "TXN-1005", "account_id": "ACC-001", "date": "2026-06-14", "merchant": "Transfer to Rainy Day Savings", "category": "transfer", "amount": -500.00, "status": "posted", "running_balance": 2690.87 },
    { "id": "TXN-1006", "account_id": "ACC-001", "date": "2026-06-16", "merchant": "Acme Corp Payroll", "category": "income", "amount": 3250.00, "status": "posted", "running_balance": 5940.87 },
    { "id": "TXN-1007", "account_id": "ACC-001", "date": "2026-06-18", "merchant": "Blue Line Transit", "category": "transport", "amount": -86.00, "status": "posted", "running_balance": 5854.87 },
    { "id": "TXN-1008", "account_id": "ACC-001", "date": "2026-06-21", "merchant": "Rewards Visa Payment", "category": "credit_card_payment", "amount": -900.00, "status": "posted", "running_balance": 4954.87 },
    { "id": "TXN-1009", "account_id": "ACC-001", "date": "2026-06-27", "merchant": "Whole Harvest Market", "category": "groceries", "amount": -131.22, "status": "posted", "running_balance": 4823.65 },
    { "id": "TXN-1010", "account_id": "ACC-001", "date": "2026-07-01", "merchant": "Acme Corp Payroll", "category": "income", "amount": 3250.00, "status": "posted", "running_balance": 8073.65 },
    { "id": "TXN-1011", "account_id": "ACC-001", "date": "2026-07-03", "merchant": "Greenfield Apartments", "category": "rent", "amount": -1650.00, "status": "posted", "running_balance": 6423.65 },
    { "id": "TXN-1012", "account_id": "ACC-001", "date": "2026-07-07", "merchant": "Northwind Insurance", "category": "insurance", "amount": -212.50, "status": "posted", "running_balance": 6211.15 },
    { "id": "TXN-1013", "account_id": "ACC-001", "date": "2026-07-10", "merchant": "City Power & Light", "category": "utilities", "amount": -124.10, "status": "posted", "running_balance": 6087.05 },
    { "id": "TXN-1014", "account_id": "ACC-001", "date": "2026-07-12", "merchant": "Transfer to House Fund", "category": "transfer", "amount": -1500.00, "status": "posted", "running_balance": 4587.05 },
    { "id": "TXN-1015", "account_id": "ACC-001", "date": "2026-07-16", "merchant": "Acme Corp Payroll", "category": "income", "amount": 3250.00, "status": "posted", "running_balance": 7837.05 },
    { "id": "TXN-1016", "account_id": "ACC-001", "date": "2026-07-19", "merchant": "Rewards Visa Payment", "category": "credit_card_payment", "amount": -1100.00, "status": "posted", "running_balance": 6737.05 },
    { "id": "TXN-1017", "account_id": "ACC-001", "date": "2026-07-25", "merchant": "Whole Harvest Market", "category": "groceries", "amount": -158.64, "status": "posted", "running_balance": 6578.41 },
    { "id": "TXN-1018", "account_id": "ACC-001", "date": "2026-08-01", "merchant": "Acme Corp Payroll", "category": "income", "amount": 3250.00, "status": "posted", "running_balance": 9828.41 },
    { "id": "TXN-1019", "account_id": "ACC-001", "date": "2026-08-03", "merchant": "Greenfield Apartments", "category": "rent", "amount": -1650.00, "status": "posted", "running_balance": 8178.41 },
    { "id": "TXN-1020", "account_id": "ACC-001", "date": "2026-08-08", "merchant": "Transfer to House Fund", "category": "transfer", "amount": -3500.00, "status": "posted", "running_balance": 4678.41 },
    { "id": "TXN-1021", "account_id": "ACC-001", "date": "2026-08-11", "merchant": "City Power & Light", "category": "utilities", "amount": -131.83, "status": "posted", "running_balance": 4546.58 },
    { "id": "TXN-1022", "account_id": "ACC-001", "date": "2026-08-15", "merchant": "Blue Line Transit", "category": "transport", "amount": -86.00, "status": "posted", "running_balance": 4460.58 },
    { "id": "TXN-1023", "account_id": "ACC-001", "date": "2026-08-20", "merchant": "Whole Harvest Market", "category": "groceries", "amount": -148.00, "status": "posted", "running_balance": 4312.58 },
    { "id": "TXN-1024", "account_id": "ACC-001", "date": "2026-08-23", "merchant": "Corner Cafe", "category": "dining", "amount": -125.00, "status": "pending", "running_balance": 4187.58 },
    { "id": "TXN-2001", "account_id": "ACC-002", "date": "2026-06-14", "merchant": "Transfer from Everyday Checking", "category": "transfer", "amount": 500.00, "status": "posted", "running_balance": 17495.10 },
    { "id": "TXN-2002", "account_id": "ACC-002", "date": "2026-06-30", "merchant": "Interest Paid", "category": "interest", "amount": 58.32, "status": "posted", "running_balance": 17553.42 },
    { "id": "TXN-2003", "account_id": "ACC-002", "date": "2026-07-14", "merchant": "Transfer from Everyday Checking", "category": "transfer", "amount": 500.00, "status": "posted", "running_balance": 18053.42 },
    { "id": "TXN-2004", "account_id": "ACC-002", "date": "2026-07-31", "merchant": "Interest Paid", "category": "interest", "amount": 60.18, "status": "posted", "running_balance": 18113.60 },
    { "id": "TXN-2005", "account_id": "ACC-002", "date": "2026-08-05", "merchant": "Car Repair Withdrawal", "category": "withdrawal", "amount": -134.00, "status": "posted", "running_balance": 17979.60 },
    { "id": "TXN-2006", "account_id": "ACC-002", "date": "2026-08-14", "merchant": "Transfer from Everyday Checking", "category": "transfer", "amount": 500.00, "status": "posted", "running_balance": 18479.60 },
    { "id": "TXN-2007", "account_id": "ACC-002", "date": "2026-08-22", "merchant": "Interest Paid", "category": "interest", "amount": 61.30, "status": "posted", "running_balance": 18540.90 },
    { "id": "TXN-3001", "account_id": "ACC-003", "date": "2026-06-30", "merchant": "Interest Paid", "category": "interest", "amount": 148.75, "status": "posted", "running_balance": 47060.25 },
    { "id": "TXN-3002", "account_id": "ACC-003", "date": "2026-07-12", "merchant": "Transfer from Everyday Checking", "category": "transfer", "amount": 1500.00, "status": "posted", "running_balance": 48560.25 },
    { "id": "TXN-3003", "account_id": "ACC-003", "date": "2026-07-31", "merchant": "Interest Paid", "category": "interest", "amount": 149.75, "status": "posted", "running_balance": 48710.00 },
    { "id": "TXN-3004", "account_id": "ACC-003", "date": "2026-08-08", "merchant": "Transfer from Everyday Checking", "category": "transfer", "amount": 3500.00, "status": "posted", "running_balance": 52210.00 },
    { "id": "TXN-4001", "account_id": "ACC-004", "date": "2026-06-04", "merchant": "Skyward Airlines", "category": "travel", "amount": -486.20, "status": "posted", "running_balance": -1102.90 },
    { "id": "TXN-4002", "account_id": "ACC-004", "date": "2026-06-08", "merchant": "Corner Cafe", "category": "dining", "amount": -38.45, "status": "posted", "running_balance": -1141.35 },
    { "id": "TXN-4003", "account_id": "ACC-004", "date": "2026-06-12", "merchant": "StreamFlix", "category": "subscriptions", "amount": -15.99, "status": "posted", "running_balance": -1157.34 },
    { "id": "TXN-4004", "account_id": "ACC-004", "date": "2026-06-15", "merchant": "Summit Outfitters", "category": "shopping", "amount": -212.00, "status": "posted", "running_balance": -1369.34 },
    { "id": "TXN-4005", "account_id": "ACC-004", "date": "2026-06-21", "merchant": "Payment - Thank You", "category": "payment", "amount": 900.00, "status": "posted", "running_balance": -469.34 },
    { "id": "TXN-4006", "account_id": "ACC-004", "date": "2026-06-26", "merchant": "Harbor Grill", "category": "dining", "amount": -94.60, "status": "posted", "running_balance": -563.94 },
    { "id": "TXN-4007", "account_id": "ACC-004", "date": "2026-07-02", "merchant": "PetroMax Fuel", "category": "fuel", "amount": -61.18, "status": "posted", "running_balance": -625.12 },
    { "id": "TXN-4008", "account_id": "ACC-004", "date": "2026-07-06", "merchant": "Corner Cafe", "category": "dining", "amount": -27.10, "status": "posted", "running_balance": -652.22 },
    { "id": "TXN-4009", "account_id": "ACC-004", "date": "2026-07-12", "merchant": "StreamFlix", "category": "subscriptions", "amount": -15.99, "status": "posted", "running_balance": -668.21 },
    { "id": "TXN-4010", "account_id": "ACC-004", "date": "2026-07-14", "merchant": "Lakeside Hotel", "category": "travel", "amount": -642.00, "status": "posted", "running_balance": -1310.21 },
    { "id": "TXN-4011", "account_id": "ACC-004", "date": "2026-07-19", "merchant": "Payment - Thank You", "category": "payment", "amount": 1100.00, "status": "posted", "running_balance": -210.21 },
    { "id": "TXN-4012", "account_id": "ACC-004", "date": "2026-07-23", "merchant": "Summit Outfitters", "category": "shopping", "amount": -158.40, "status": "posted", "running_balance": -368.61 },
    { "id": "TXN-4013", "account_id": "ACC-004", "date": "2026-07-29", "merchant": "Harbor Grill", "category": "dining", "amount": -112.35, "status": "posted", "running_balance": -480.96 },
    { "id": "TXN-4014", "account_id": "ACC-004", "date": "2026-08-02", "merchant": "PetroMax Fuel", "category": "fuel", "amount": -58.90, "status": "posted", "running_balance": -539.86 },
    { "id": "TXN-4015", "account_id": "ACC-004", "date": "2026-08-06", "merchant": "Bright Smile Dental", "category": "healthcare", "amount": -260.00, "status": "posted", "running_balance": -799.86 },
    { "id": "TXN-4016", "account_id": "ACC-004", "date": "2026-08-12", "merchant": "StreamFlix", "category": "subscriptions", "amount": -15.99, "status": "posted", "running_balance": -815.85 },
    { "id": "TXN-4017", "account_id": "ACC-004", "date": "2026-08-15", "merchant": "Corner Cafe", "category": "dining", "amount": -33.20, "status": "posted", "running_balance": -849.05 },
    { "id": "TXN-4018", "account_id": "ACC-004", "date": "2026-08-18", "merchant": "Skyward Airlines", "category": "travel", "amount": -398.00, "status": "posted", "running_balance": -1247.05 },
    { "id": "TXN-4019", "account_id": "ACC-004", "date": "2026-08-21", "merchant": "Whole Harvest Market", "category": "groceries", "amount": -37.28, "status": "posted", "running_balance": -1284.33 },
    { "id": "TXN-4020", "account_id": "ACC-004", "date": "2026-08-24", "merchant": "Harbor Grill", "category": "dining", "amount": -76.00, "status": "pending", "running_balance": -1360.33 }
  ],
  "cards": [
    { "id": "CARD-01", "account_id": "ACC-001", "kind": "debit", "network": "Visa", "last4": "4471", "status": "active", "expires": "09/28", "daily_limit": 2500.00 },
    { "id": "CARD-02", "account_id": "ACC-004", "kind": "credit", "network": "Visa", "last4": "3308", "status": "active", "expires": "11/27", "daily_limit": 10000.00 }
  ],
  "statements": [
    { "id": "STM-ACC-001-2026-06", "account_id": "ACC-001", "period": "2026-06", "opening_balance": 1852.14, "closing_balance": 4823.65, "total_in": 6500.00, "total_out": 3528.49, "document": "statements/ACC-001/2026-06.pdf" },
    { "id": "STM-ACC-001-2026-07", "account_id": "ACC-001", "period": "2026-07", "opening_balance": 4823.65, "closing_balance": 6578.41, "total_in": 6500.00, "total_out": 4745.24, "document": "statements/ACC-001/2026-07.pdf" },
    { "id": "STM-ACC-002-2026-06", "account_id": "ACC-002", "period": "2026-06", "opening_balance": 16995.10, "closing_balance": 17553.42, "total_in": 558.32, "total_out": 0.00, "document": "statements/ACC-002/2026-06.pdf" },
    { "id": "STM-ACC-002-2026-07", "account_id": "ACC-002", "period": "2026-07", "opening_balance": 17553.42, "closing_balance": 18113.60, "total_in": 560.18, "total_out": 0.00, "document": "statements/ACC-002/2026-07.pdf" },
    { "id": "STM-ACC-003-2026-06", "account_id": "ACC-003", "period": "2026-06", "opening_balance": 46911.50, "closing_balance": 47060.25, "total_in": 148.75, "total_out": 0.00, "document": "statements/ACC-003/2026-06.pdf" },
    { "id": "STM-ACC-003-2026-07", "account_id": "ACC-003", "period": "2026-07", "opening_balance": 47060.25, "closing_balance": 48710.00, "total_in": 1649.75, "total_out": 0.00, "document": "statements/ACC-003/2026-07.pdf" },
    { "id": "STM-ACC-004-2026-06", "account_id": "ACC-004", "period": "2026-06", "opening_balance": -616.70, "closing_balance": -563.94, "total_in": 900.00, "total_out": 847.24, "document": "statements/ACC-004/2026-06.pdf" },
    { "id": "STM-ACC-004-2026-07", "account_id": "ACC-004", "period": "2026-07", "opening_balance": -563.94, "closing_balance": -480.96, "total_in": 1100.00, "total_out": 1017.02, "document": "statements/ACC-004/2026-07.pdf" }
  ],
  "branches": [
    { "id": "BR-01", "name": "Downtown Financial Center", "address": "120 Market St", "city": "Springfield", "zip": "62701", "hours": "Mon-Fri 9-5, Sat 9-1", "services": "teller, mortgage, safe deposit", "has_atm": 1 },
    { "id": "BR-02", "name": "Riverside Branch", "address": "88 River Rd", "city": "Springfield", "zip": "62704", "hours": "Mon-Fri 9-5", "services": "teller, notary", "has_atm": 1 },
    { "id": "BR-03", "name": "Northgate Mall Kiosk", "address": "2200 Northgate Blvd", "city": "Springfield", "zip": "62707", "hours": "Daily 10-8", "services": "atm only", "has_atm": 1 },
    { "id": "BR-04", "name": "Oakdale Branch", "address": "15 Oak Ave", "city": "Oakdale", "zip": "62855", "hours": "Mon-Fri 9-4", "services": "teller, small business", "has_atm": 0 },
    { "id": "BR-05", "name": "Lakeview Branch", "address": "402 Shoreline Dr", "city": "Lakeview", "zip": "62966", "hours": "Mon-Fri 9-5, Sat 9-12", "services": "teller, mortgage, wealth", "has_atm": 1 },
    { "id": "BR-06", "name": "Airport Concourse ATM", "address": "Terminal B", "city": "Springfield", "zip": "62707", "hours": "24 hours", "services": "atm only", "has_atm": 1 }
  ]
}
```

- [ ] **Step 5: Write the banking tool catalog**

`verticals/banking/vertical.json`:

```json
{
  "name": "banking",
  "resourceName": "Banking MCP Server",
  "tools": [
    {
      "name": "list_accounts",
      "description": "List all of the customer's accounts with type, masked number, balance and status.",
      "inputSchema": { "type": "object", "properties": {}, "required": [] },
      "requiredScopes": ["banking:read"],
      "intentHints": ["show my accounts", "what accounts do I have", "list accounts"],
      "sql": "SELECT id, nickname, type, number_masked, balance, available, currency, status FROM accounts ORDER BY id",
      "result": "many"
    },
    {
      "name": "get_account",
      "description": "Full details of one account.",
      "inputSchema": {
        "type": "object",
        "properties": { "account_id": { "type": "string", "description": "Account id, e.g. ACC-001" } },
        "required": ["account_id"]
      },
      "requiredScopes": ["banking:read"],
      "intentHints": ["show account details", "tell me about my checking account"],
      "sql": "SELECT id, nickname, type, number_masked, balance, available, currency, opened, status FROM accounts WHERE id = :account_id",
      "result": "one"
    },
    {
      "name": "get_account_balance",
      "description": "Current and available balance for one account.",
      "inputSchema": {
        "type": "object",
        "properties": { "account_id": { "type": "string", "description": "Account id, e.g. ACC-001" } },
        "required": ["account_id"]
      },
      "requiredScopes": ["banking:read"],
      "intentHints": ["what's my balance", "how much is in checking", "available balance"],
      "sql": "SELECT id AS account_id, nickname, balance, available, currency FROM accounts WHERE id = :account_id",
      "result": "one"
    },
    {
      "name": "list_transactions",
      "description": "Most recent transactions for one account, newest first.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "account_id": { "type": "string", "description": "Account id, e.g. ACC-001" },
          "limit": { "type": "integer", "description": "Max rows (1-100, default 20)" }
        },
        "required": ["account_id"]
      },
      "requiredScopes": ["banking:read"],
      "intentHints": ["recent transactions", "show my transactions", "what did I spend"],
      "sql": "SELECT id, date, merchant, category, amount, status, running_balance FROM transactions WHERE account_id = :account_id ORDER BY date DESC, id DESC LIMIT COALESCE(:limit, 20)",
      "result": "many"
    },
    {
      "name": "search_transactions",
      "description": "Find transactions across all accounts whose merchant or category contains the query text.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Text to match against merchant or category, e.g. groceries" },
          "limit": { "type": "integer", "description": "Max rows (1-100, default 20)" }
        },
        "required": ["query"]
      },
      "requiredScopes": ["banking:read"],
      "intentHints": ["find transactions from", "how much did I spend on groceries", "search transactions"],
      "sql": "SELECT id, account_id, date, merchant, category, amount, status FROM transactions WHERE merchant LIKE '%' || :query || '%' OR category LIKE '%' || :query || '%' ORDER BY date DESC, id DESC LIMIT COALESCE(:limit, 20)",
      "result": "many"
    },
    {
      "name": "list_cards",
      "description": "Debit and credit cards on the customer's accounts.",
      "inputSchema": { "type": "object", "properties": {}, "required": [] },
      "requiredScopes": ["banking:read"],
      "intentHints": ["show my cards", "is my card active", "card limits"],
      "sql": "SELECT c.id, c.account_id, a.nickname AS account, c.kind, c.network, c.last4, c.status, c.expires, c.daily_limit FROM cards c JOIN accounts a ON a.id = c.account_id ORDER BY c.id",
      "result": "many"
    },
    {
      "name": "get_statement",
      "description": "Monthly statement summary for one account and period.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "account_id": { "type": "string", "description": "Account id, e.g. ACC-001" },
          "period": { "type": "string", "description": "Statement month as YYYY-MM, e.g. 2026-07" }
        },
        "required": ["account_id", "period"]
      },
      "requiredScopes": ["banking:read"],
      "intentHints": ["show my July statement", "statement for checking", "monthly summary"],
      "sql": "SELECT id, account_id, period, opening_balance, closing_balance, total_in, total_out, document FROM statements WHERE account_id = :account_id AND period = :period",
      "result": "one"
    },
    {
      "name": "find_branches",
      "description": "Branches and ATMs, optionally filtered by city or zip code.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "City name, e.g. Springfield" },
          "zip": { "type": "string", "description": "5-digit zip code" }
        },
        "required": []
      },
      "requiredScopes": ["banking:read"],
      "intentHints": ["nearest branch", "find an ATM", "branch hours"],
      "sql": "SELECT id, name, address, city, zip, hours, services, has_atm FROM branches WHERE (:city IS NULL OR city = :city) AND (:zip IS NULL OR zip = :zip) ORDER BY id",
      "result": "many"
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
    },
    {
      "uri": "banking://cards",
      "name": "Cards",
      "description": "All debit and credit cards for the customer",
      "mimeType": "application/json",
      "requiredScope": "banking:read",
      "uriTemplate": "banking://cards/{card_id}",
      "templateName": "Card",
      "listTool": "list_cards"
    }
  ],
  "prompts": [
    {
      "name": "explain_account",
      "description": "Explain one account's recent activity in plain language for the customer.",
      "arguments": [{ "name": "account_id", "description": "Account id, e.g. ACC-001", "required": true }],
      "template": "Call get_account_balance and list_transactions for account {{account_id}}, then explain the current balance and the most notable recent transactions in plain, customer-friendly language. Do not show raw field names."
    }
  ]
}
```

- [ ] **Step 6: Run the generic test**

Run: `node_modules/.bin/jest tests/verticals.test.ts`
Expected: PASS — `verticals/banking` with 9 tests (1 + 8 tools). `find_branches` gets `city: "Springfield"` from the first branch row; `get_statement` gets `account_id: "ACC-001"` and `period: "2026-06"`; `search_transactions` gets `query: "a"`.

- [ ] **Step 7: Commit**

```bash
git add verticals/banking tests/verticals.test.ts
git commit -m "feat(banking): config-defined banking vertical with 8 read tools"
```

---

### Task 5: The healthcare vertical (worked example)

**Files:**
- Create: `verticals/healthcare/schema.sql`
- Create: `verticals/healthcare/seed.json`
- Create: `verticals/healthcare/vertical.json`

**Interfaces:**
- Consumes: the generic test from Task 4 (it picks the folder up automatically).
- Produces: the swap target for Task 6's `tests/swap.test.ts` (`view_records`, `get_record`, scope `healthcare:read`, `resourceName` "Healthcare MCP Server").

- [ ] **Step 1: Schema**

`verticals/healthcare/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS patients (
  id         TEXT PRIMARY KEY,
  full_name  TEXT NOT NULL,
  dob        TEXT NOT NULL,
  mrn        TEXT NOT NULL,
  primary_physician TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  date       TEXT NOT NULL,
  type       TEXT NOT NULL,   -- visit | lab | imaging | immunization
  provider   TEXT NOT NULL,
  summary    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  datetime   TEXT NOT NULL,   -- YYYY-MM-DDTHH:MM
  provider   TEXT NOT NULL,
  location   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL    -- scheduled | completed | cancelled
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patients(id),
  medication  TEXT NOT NULL,
  dosage      TEXT NOT NULL,
  prescriber  TEXT NOT NULL,
  refills_left INTEGER NOT NULL,
  status      TEXT NOT NULL   -- active | expired
);
```

- [ ] **Step 2: Seed**

`verticals/healthcare/seed.json`:

```json
{
  "patients": [
    { "id": "PAT-001", "full_name": "Morgan Ellis", "dob": "1984-05-19", "mrn": "MRN-448210", "primary_physician": "Dr. Priya Raman" }
  ],
  "records": [
    { "id": "REC-101", "patient_id": "PAT-001", "date": "2026-06-04", "type": "visit", "provider": "Dr. Priya Raman", "summary": "Annual physical. BP 118/76, BMI 23.4. No concerns; continue current plan." },
    { "id": "REC-102", "patient_id": "PAT-001", "date": "2026-06-04", "type": "lab", "provider": "CareConnect Lab", "summary": "CBC and lipid panel within normal limits. LDL 96 mg/dL." },
    { "id": "REC-103", "patient_id": "PAT-001", "date": "2026-07-11", "type": "imaging", "provider": "Riverside Imaging", "summary": "Right knee X-ray after fall: no fracture, mild effusion. RICE and follow-up in 2 weeks." },
    { "id": "REC-104", "patient_id": "PAT-001", "date": "2026-07-25", "type": "visit", "provider": "Dr. Alan Okafor (Ortho)", "summary": "Knee follow-up: effusion resolved, full range of motion. Cleared for activity." },
    { "id": "REC-105", "patient_id": "PAT-001", "date": "2026-08-15", "type": "immunization", "provider": "CareConnect Pharmacy", "summary": "Seasonal influenza vaccine administered, left deltoid. No reaction." }
  ],
  "appointments": [
    { "id": "APT-201", "patient_id": "PAT-001", "datetime": "2026-06-04T09:00", "provider": "Dr. Priya Raman", "location": "Main Clinic, Suite 210", "reason": "Annual physical", "status": "completed" },
    { "id": "APT-202", "patient_id": "PAT-001", "datetime": "2026-07-25T14:30", "provider": "Dr. Alan Okafor", "location": "Orthopedics, Bldg C", "reason": "Knee follow-up", "status": "completed" },
    { "id": "APT-203", "patient_id": "PAT-001", "datetime": "2026-09-09T10:15", "provider": "Dr. Priya Raman", "location": "Main Clinic, Suite 210", "reason": "Lab review", "status": "scheduled" },
    { "id": "APT-204", "patient_id": "PAT-001", "datetime": "2026-10-02T08:00", "provider": "Bright Smile Dental", "location": "Dental Annex", "reason": "Cleaning", "status": "scheduled" }
  ],
  "prescriptions": [
    { "id": "RX-301", "patient_id": "PAT-001", "medication": "Atorvastatin", "dosage": "10 mg nightly", "prescriber": "Dr. Priya Raman", "refills_left": 2, "status": "active" },
    { "id": "RX-302", "patient_id": "PAT-001", "medication": "Ibuprofen", "dosage": "400 mg every 8 hours as needed", "prescriber": "Dr. Alan Okafor", "refills_left": 0, "status": "expired" },
    { "id": "RX-303", "patient_id": "PAT-001", "medication": "Cetirizine", "dosage": "10 mg daily", "prescriber": "Dr. Priya Raman", "refills_left": 5, "status": "active" }
  ]
}
```

- [ ] **Step 3: Catalog**

`verticals/healthcare/vertical.json`:

```json
{
  "name": "healthcare",
  "resourceName": "Healthcare MCP Server",
  "tools": [
    {
      "name": "view_records",
      "description": "The patient's medical records, newest first.",
      "inputSchema": { "type": "object", "properties": { "limit": { "type": "integer", "description": "Max rows (1-100, default 20)" } }, "required": [] },
      "requiredScopes": ["healthcare:read"],
      "intentHints": ["show my medical records", "view my records", "recent visits"],
      "sql": "SELECT id, date, type, provider, summary FROM records ORDER BY date DESC, id DESC LIMIT COALESCE(:limit, 20)",
      "result": "many"
    },
    {
      "name": "get_record",
      "description": "One medical record by id.",
      "inputSchema": { "type": "object", "properties": { "record_id": { "type": "string", "description": "Record id, e.g. REC-101" } }, "required": ["record_id"] },
      "requiredScopes": ["healthcare:read"],
      "intentHints": ["show record", "details of my lab result"],
      "sql": "SELECT r.id, r.date, r.type, r.provider, r.summary, p.full_name AS patient, p.mrn FROM records r JOIN patients p ON p.id = r.patient_id WHERE r.id = :record_id",
      "result": "one"
    },
    {
      "name": "list_appointments",
      "description": "Upcoming and past appointments.",
      "inputSchema": { "type": "object", "properties": {}, "required": [] },
      "requiredScopes": ["healthcare:read"],
      "intentHints": ["my appointments", "when is my next appointment"],
      "sql": "SELECT id, datetime, provider, location, reason, status FROM appointments ORDER BY datetime",
      "result": "many"
    },
    {
      "name": "list_prescriptions",
      "description": "Current and expired prescriptions with refills remaining.",
      "inputSchema": { "type": "object", "properties": {}, "required": [] },
      "requiredScopes": ["healthcare:read"],
      "intentHints": ["my prescriptions", "do I have refills left", "medications"],
      "sql": "SELECT id, medication, dosage, prescriber, refills_left, status FROM prescriptions ORDER BY status, medication",
      "result": "many"
    }
  ],
  "resources": [
    {
      "uri": "healthcare://records",
      "name": "Patient Records",
      "description": "All medical records for the patient",
      "mimeType": "application/json",
      "requiredScope": "healthcare:read",
      "uriTemplate": "healthcare://records/{record_id}",
      "templateName": "Patient Record",
      "listTool": "view_records"
    }
  ],
  "prompts": [
    {
      "name": "summarize_visit",
      "description": "Summarize one medical record for the patient in plain language.",
      "arguments": [{ "name": "record_id", "description": "Record id, e.g. REC-101", "required": true }],
      "template": "Call get_record for {{record_id}} and explain what it says in plain, patient-friendly language. Do not show raw field names."
    }
  ]
}
```

- [ ] **Step 4: Run the generic test**

Run: `node_modules/.bin/jest tests/verticals.test.ts`
Expected: PASS — both folders, 9 + 5 tests.

- [ ] **Step 5: Commit**

```bash
git add verticals/healthcare
git commit -m "feat(healthcare): config-defined healthcare vertical as the worked example"
```

---

### Task 6: Rewire `src/index.ts`, re-point transport tests, add the swap test

**Files:**
- Modify: `src/index.ts` (line numbers below are from the current file; re-check with `grep -n` before editing)
- Modify: `tests/httpMcp.test.ts`, `tests/resources.test.ts`
- Create: `tests/swap.test.ts`

**Interfaces:**
- Consumes: every export of `src/tools/registry.ts` (Task 3); `filterByScopes` now from `src/vertical/types`.

- [ ] **Step 1: Change imports and remove the hard-coded catalog and prompts**

In `src/index.ts`:

1. Delete the `ResourceDef` interface and the `RESOURCE_CATALOG` const (currently lines 36–58).
2. Delete the `PromptArgDef`/`PromptDef` interfaces and the `PROMPTS` const (currently lines 80–116, the block ending with `];` after `summarize_airline_booking`). Keep the comment header above them, editing it to read:

```ts
// MCP Prompts capability — templates come from the active vertical's
// vertical.json (prompts[]); {{arg}} placeholders are filled from
// prompts/get arguments.
// ---------------------------------------------------------------------------
```

3. Change these import lines:

```ts
import { filterByScopes } from './tools/toolTypes';
import { ALL_TOOLS, SUPPORTED_SCOPES, dispatch, findTool } from './tools/registry';
...
import { resolvePassenger, listBookings } from './db/airlinesDb';
import { getHoldings, resolveInvestor } from './db/investDb';
```
to
```ts
import { filterByScopes } from './vertical/types';
import {
  ALL_TOOLS, PROMPTS, RESOURCE_CATALOG, RESOURCE_NAME_DEFAULT, SUPPORTED_SCOPES, VERTICAL, dispatch, findTool,
} from './tools/registry';
```
(delete the two `./db/` imports entirely; `import crypto from 'crypto'` is deleted in Step 3).

- [ ] **Step 2: Resource name from the vertical**

Change
```ts
const RESOURCE_NAME = process.env.MCP_SERVER_RESOURCE_NAME || 'Super Banking MCP Server (mcp-resource-server)';
```
to
```ts
const RESOURCE_NAME = process.env.MCP_SERVER_RESOURCE_NAME || RESOURCE_NAME_DEFAULT;
console.log(`[mcp-resource-server] vertical "${VERTICAL.name}" — ${ALL_TOOLS.length} tools, ${RESOURCE_CATALOG.length} resources, ${PROMPTS.length} prompts`);
```

- [ ] **Step 3: Remove the API-key path**

Delete the block beginning `// API-key auth (backend-app pattern)` through the closing `}` of `function apiKeyMatches` (currently lines 155–171). Delete the whole `if (url === '/invest' && req.method === 'GET') { ... }` branch in `handleHttp` (currently lines 343–382). Delete `import crypto from 'crypto';`. In `/health`, change `authMethods: ['bearer_token', 'api_key']` to `authMethods: ['bearer_token']` and add `vertical: VERTICAL.name,` after `resourceUri`.

- [ ] **Step 4: Prompts from config**

Replace the `prompts/list` and `prompts/get` handlers (currently lines 467–481) with:

```ts
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
```

- [ ] **Step 5: Completion returns nothing to suggest**

Replace the whole `completion/complete` handler (currently lines 483–507, including its comment) with:

```ts
  // MCP Completion capability: this server has no argument autocompletion
  // sources, so every request gets an empty list — the spec treats "nothing
  // to suggest" as a normal result, not an error.
  if (method === 'completion/complete') {
    send(rpcResult(id, { completion: { values: [], total: 0, hasMore: false } }));
    return;
  }
```

- [ ] **Step 6: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: errors ONLY in the old vertical files under `src/tools/` and `src/db/` (they import `./toolTypes` and modules the registry no longer exports). If `src/index.ts` itself reports an error, fix it now. The old files are deleted in Task 7.

- [ ] **Step 7: Re-point `tests/httpMcp.test.ts`**

Apply these replacements (use `sed -i ''` on macOS or edit by hand), then read the file once to confirm nothing else references airlines:

- `process.env.AIRLINES_DB_PATH = path.join(tmpDir, 'airlines.db');` → `process.env.VERTICAL_DB_PATH = path.join(tmpDir, 'banking.db');`
- delete the `process.env.AIRLINES_SEED_PATH = ...` line
- every `'airlines:read'` → `'banking:read'`
- every `get_airline_bookings` → `list_accounts`
- the `prompts/list` test: `p.name === 'summarize_airline_booking'` → `p.name === 'explain_account'`
- the `prompts/get` test: `name: 'summarize_airline_booking', arguments: { bookingId: 'K7XR2M' }` → `name: 'explain_account', arguments: { account_id: 'ACC-001' }`; its text assertions become `expect(text).toContain('ACC-001'); expect(text).toContain('get_account_balance');`
- the completion tests (the `describe` starting at the comment `MCP Completion capability`): replace the whole describe with one test:

```ts
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
```
- any assertion on the `tools/call` result body for `get_airline_bookings` (a `bookings` array) becomes `expect(parsed.items).toHaveLength(4)` where `parsed = JSON.parse(r.json.result.content[0].text)`.

- [ ] **Step 8: Re-point `tests/resources.test.ts`**

- `process.env.AIRLINES_DB_PATH = ...` → `process.env.VERTICAL_DB_PATH = path.join(tmpDir, 'banking.db');`; delete the `AIRLINES_SEED_PATH` line.
- `toBeGreaterThanOrEqual(11)` → `toBe(2)` (banking advertises exactly `banking://accounts` and `banking://cards`).
- every `healthcare://records` reference: it is not in the banking vertical, so change those tests to use `banking://cards` with scope `banking:read` and assert `contents[0].text` parses to `{ items, count: 2 }`.
- the `banking://accounts` read assertion: parsed text has `count: 4`.

- [ ] **Step 9: Write the swap test**

`tests/swap.test.ts`:

```ts
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
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  expect(meta.scopes_supported).toEqual(['healthcare:read']);
  expect(meta.resource_name).toBe('Healthcare MCP Server');
});

it('a banking tool name is unknown here', async () => {
  const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } }, token('healthcare:read'));
  expect(r.error).toBeDefined();
});

it('healthcare data comes back', async () => {
  const r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_record', arguments: { record_id: 'REC-103' } } }, token('healthcare:read'));
  expect(JSON.parse(r.result.content[0].text).type).toBe('imaging');
});
```

- [ ] **Step 10: Run the transport suites**

Run: `node_modules/.bin/jest tests/httpMcp.test.ts tests/resources.test.ts tests/swap.test.ts tests/acceptedAudiences.test.ts tests/resourceUriEnv.test.ts tests/mcpLogging.test.ts tests/transactionHop.test.ts`
Expected: PASS. If `tests/mcpLogging.test.ts` or `tests/transactionHop.test.ts` set `AIRLINES_*` env vars, apply the same `VERTICAL_DB_PATH` replacement there.

- [ ] **Step 11: Commit**

```bash
git add src/index.ts tests/httpMcp.test.ts tests/resources.test.ts tests/swap.test.ts tests/mcpLogging.test.ts tests/transactionHop.test.ts
git commit -m "feat(server): serve the active config vertical; prompts from config; drop API-key and airlines hooks"
```

---

### Task 7: Delete the code verticals and their build wiring

**Files:**
- Delete: `src/tools/*Tools.ts`, `src/tools/*ToolHandler.ts`, `src/tools/toolTypes.ts`, `src/db/` (whole dir), `seed/` (whole dir), `scripts/gen-seeds-from-bff.mjs`, `openapi/`, `data/airlines.db`, and tests `tests/*Db.test.ts`, `tests/*Tools*.test.ts`, `tests/investToolHandler.test.ts`, `tests/investSqlite.test.ts`, `tests/insertIdSqlMax.test.ts`, `tests/mockData.test.ts`, `tests/seedParity.test.ts`, `tests/registry.test.ts`
- Modify: `package.json`, `Dockerfile`, `docker-compose.yml`, `.gitignore`, `.env.example`

- [ ] **Step 1: Delete**

```bash
git rm -q -r src/db seed openapi scripts/gen-seeds-from-bff.mjs data/airlines.db
git rm -q src/tools/toolTypes.ts $(ls src/tools/*Tools.ts src/tools/*ToolHandler.ts)
git rm -q tests/registry.test.ts tests/seedParity.test.ts tests/insertIdSqlMax.test.ts tests/mockData.test.ts tests/investToolHandler.test.ts tests/investSqlite.test.ts $(ls tests/*Db.test.ts tests/*Tools*.test.ts)
rmdir scripts 2>/dev/null || true
ls src/tools   # expected: registry.ts only
```

- [ ] **Step 2: package.json**

Remove the `"axios": "^1.17.0",` line from `dependencies`. Change `"description"` to `"Config-driven MCP server: one vertical (banking by default) defined by verticals/<name>/{vertical.json,schema.sql,seed.json}"`. Remove the `"seeds:gen"` script.

- [ ] **Step 3: Dockerfile**

Replace
```dockerfile
COPY openapi/ ./openapi/
# Seeds for the per-vertical SQLite databases. Applied only when the tables are empty
# (src/db/*Db.ts), so a restart never clobbers out-of-band edits to
# /app/data/*.db.
COPY seed/ ./seed/
```
with
```dockerfile
# Vertical definitions (tools, schema, seed). The active one is chosen by
# VERTICAL at runtime; its seed is applied at startup only when the tables in
# /app/data/<VERTICAL>.db are empty, so a restart never clobbers edits.
COPY verticals/ ./verticals/
```

- [ ] **Step 4: docker-compose.yml**

Under `environment:` add `VERTICAL: ${VERTICAL:-banking}` and change the `volumes` comment to `# SQLite database for the active vertical, seeded at startup from the image's verticals/ dir. Bind mount so data survives a container recreate.`

- [ ] **Step 5: .gitignore and .env.example**

Append `data/` to `.gitignore`. In `.env.example`, after the `HOST=0.0.0.0` line add:

```
# --- Which vertical to serve ---
# A folder under verticals/. Ships with "banking" (default) and "healthcare".
VERTICAL=banking
```

- [ ] **Step 6: Typecheck and run the whole suite**

Run: `node_modules/.bin/tsc --noEmit && node_modules/.bin/jest`
Expected: exit 0; suites: vertical/load, vertical/db, vertical/dispatch, verticals, swap, httpMcp, resources, acceptedAudiences, resourceUriEnv, mcpLogging, transactionHop, plus modernNegotiation/serverDiscover if present. All green.

- [ ] **Step 7: Commit**

```bash
git add -u
git add .gitignore .env.example
git commit -m "chore: remove code verticals, invest proxy, openapi and axios; wire VERTICAL through Docker"
```
(`git add -u` stages deletions and modifications of tracked files only; verify with `git status --short` that no `data/` or `node_modules` entry is listed.)

---

### Task 8: README rewrite and live verification

**Files:**
- Rewrite: `README.md`

- [ ] **Step 1: README**

Replace `README.md` with the following. Where marked, paste the current file's "Auth modes", "Getting a bearer token", "Calling a tool directly (sanity check)" and "Connecting an MCP client" sections (they are unchanged except the two substitutions noted).

```markdown
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

<-- paste the current "Auth modes" section here, unchanged -->
<-- paste the current "Getting a bearer token" section here; change the example scope airlines:read to banking:read -->
<-- paste the current "Calling a tool directly (sanity check)" section here; replace get_airline_bookings with list_accounts -->
<-- paste the current "Connecting an MCP client" section here, unchanged -->
```

- [ ] **Step 2: Build and run the banking vertical live**

```bash
docker build -q -t mcp-rs-config .
mkdir -p /tmp/rs-live && rm -rf /tmp/rs-live/*
docker run -d --name rs-live -p 18090:8081 -v /tmp/rs-live:/app/data --env-file .env.example -e NODE_ENV=production mcp-rs-config
sleep 3; curl -s http://localhost:18090/health
TOKEN=$(node -e "const b64=s=>Buffer.from(JSON.stringify(s)).toString('base64url');console.log(b64({alg:'none',typ:'JWT'})+'.'+b64({sub:'u',scope:'banking:read',aud:'your-resource-uri',exp:Math.floor(Date.now()/1000)+3600})+'.')")
for call in '"list_accounts","arguments":{}' '"get_account","arguments":{"account_id":"ACC-002"}' '"get_account_balance","arguments":{"account_id":"ACC-001"}' '"list_transactions","arguments":{"account_id":"ACC-004","limit":3}' '"search_transactions","arguments":{"query":"groceries"}' '"list_cards","arguments":{}' '"get_statement","arguments":{"account_id":"ACC-001","period":"2026-07"}' '"find_branches","arguments":{"zip":"62707"}'; do
  curl -s -X POST http://localhost:18090/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":$call}}" | head -c 200; echo
done
docker rm -f rs-live
```
Expected: `/health` shows `"vertical":"banking"`; all eight calls return `"isError":false` with data (`find_branches` zip 62707 → 2 rows; `get_statement` → closing_balance 6578.41).

- [ ] **Step 3: Swap to healthcare live**

```bash
docker run -d --name rs-live -p 18090:8081 -v /tmp/rs-live:/app/data --env-file .env.example -e NODE_ENV=production -e VERTICAL=healthcare mcp-rs-config
sleep 3; curl -s http://localhost:18090/.well-known/oauth-protected-resource | grep -o '"scopes_supported":\[[^]]*\]'
TOKEN=$(node -e "const b64=s=>Buffer.from(JSON.stringify(s)).toString('base64url');console.log(b64({alg:'none',typ:'JWT'})+'.'+b64({sub:'u',scope:'healthcare:read',aud:'your-resource-uri',exp:Math.floor(Date.now()/1000)+3600})+'.')")
curl -s -X POST http://localhost:18090/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_prescriptions","arguments":{}}}' | head -c 200; echo
ls /tmp/rs-live
docker rm -f rs-live; docker rmi -f mcp-rs-config; rm -rf /tmp/rs-live
```
Expected: `"scopes_supported":["healthcare:read"]`; prescriptions returned; `ls` shows both `banking.db` and `healthcare.db`.

- [ ] **Step 4: Commit and push**

```bash
git add README.md
git commit -m "docs: README for the config-driven vertical server"
git push origin main
```
