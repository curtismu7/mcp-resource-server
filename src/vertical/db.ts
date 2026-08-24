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
