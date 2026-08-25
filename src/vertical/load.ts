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
      const stmt = probe.prepare(t.sql);
      stmt.all(Object.fromEntries(params.map((n) => [n, null])));
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
