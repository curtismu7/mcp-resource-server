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
