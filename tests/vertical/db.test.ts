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
