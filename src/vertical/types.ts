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
