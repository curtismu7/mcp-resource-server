'use strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupVerticals, writeVertical } from './fixtures';

// The registry loads the vertical at import time, so env must be set first.
const dir = writeVertical();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
process.env.VERTICALS_DIR = path.dirname(dir);
process.env.VERTICAL = path.basename(dir);
process.env.VERTICAL_DB_PATH = path.join(tmp, 'demo.db');

import { ALL_TOOLS, PROMPTS, RESOURCE_CATALOG, RESOURCE_NAME_DEFAULT, SUPPORTED_SCOPES, dispatch, findTool } from '../../src/tools/registry';

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); cleanupVerticals(); });

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
